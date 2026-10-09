# PicoHarness firmware — IO workbench stage
# JSON-lines command loop over USB CDC (REPL stdin/stdout).
# Architecture: a command dispatch table routes to per-function drivers
# (gpio / pwm / ...). Every driver must claim(n, who) a pin before touching
# it and release(n) when done — the owner table is the single arbiter of pin
# ownership, so functions can never fight over a pin implicitly.
# Main loop is an asyncio task group: command_reader + gpio_monitor, which
# pushes {"evt":"gpio_in","in":mask} on input level *edges*, + adc_monitor,
# which pushes {"evt":"adc","vals":{pin:raw}} when any active channel moves
# more than the deadband vs the last sent value. stdin idiom matters:
# read(n>1) blocks until n chars arrive (replies then only flush when the
# NEXT request shows up — real-hardware log showed 3s command timeouts);
# read(1) is the documented non-blocking form, returning None when nothing
# is pending.
import sys
import json
import asyncio

import board
import digitalio
import analogio
from pwmio import PWMOut

APP = "PicoHarness"
VERSION = "0.1.1-montdbg"
NUM_PINS = 29  # GP0..GP28: Pico-family boards expose up to GP28; on rp2040 GP27/28 are ADC1/ADC2

MODE_UNUSED, MODE_IN, MODE_OUT = 0, 1, 2


def send(obj):
    print(json.dumps(obj))


def parse_req(line):
    # A stray control byte can glue onto a request line; recover by parsing
    # the outermost {...} substring before giving up.
    try:
        return json.loads(line)
    except ValueError:
        s = line.find("{")
        e = line.rfind("}")
        if 0 <= s < e:
            return json.loads(line[s : e + 1])
        raise


def _pin(n):
    return getattr(board, "GP%d" % n)


# —— pin ownership arbiter ——
owner = [None] * NUM_PINS  # None | "gpio" | "pwm" | ...


def claim(n, who, force=False):
    o = owner[n]
    if o == who:
        return True
    if o is not None:
        if not force:
            return False
        release(n)
    owner[n] = who
    return True


def release(n):
    o = owner[n]
    if o == "gpio":
        gpio_release(n)
    elif o == "pwm":
        pwm_release(n)
    elif o == "adc":
        adc_release(n)
    owner[n] = None


# —— digital GPIO driver ——
pin_obj = [None] * NUM_PINS
pin_mode = [MODE_UNUSED] * NUM_PINS
pin_pull = [0] * NUM_PINS  # valid for inputs: 0 = up, 1 = down, 2 = none
out_bits = 0
in_idx = ()
out_idx = ()


def _reindex():
    global in_idx, out_idx
    in_idx = tuple(n for n in range(NUM_PINS) if pin_mode[n] == MODE_IN)
    out_idx = tuple(n for n in range(NUM_PINS) if pin_mode[n] == MODE_OUT)


def _mask_of(idxs):
    m = 0
    for n in idxs:
        m |= 1 << n
    return m


def gpio_release(n):
    global out_bits
    if pin_obj[n]:
        pin_obj[n].deinit()
        pin_obj[n] = None
    if pin_mode[n] != MODE_UNUSED:
        pin_mode[n] = MODE_UNUSED
        pin_pull[n] = 0
        out_bits &= ~(1 << n)
        _reindex()


def apply_cfg(in_mask, out_mask, pd_mask=0, pn_mask=0):
    # Incremental: only pins whose direction (or input pull) changed are
    # reconfigured, so untouched outputs never glitch. Output wins over input.
    # Pull: DOWN if pd bit, NONE if pn bit, else UP.
    global out_bits
    for n in range(NUM_PINS):
        if owner[n] in ("pwm", "adc"):
            continue  # other drivers own this pin; host must stop them first
        want = MODE_OUT if (out_mask >> n) & 1 else (MODE_IN if (in_mask >> n) & 1 else MODE_UNUSED)
        if want == MODE_UNUSED:
            if owner[n] == "gpio":
                release(n)
            continue
        claim(n, "gpio")
        pull = 1 if (pd_mask >> n) & 1 else (2 if (pn_mask >> n) & 1 else 0)
        if want == pin_mode[n] and (want != MODE_IN or pull == pin_pull[n]):
            continue
        if pin_obj[n]:
            pin_obj[n].deinit()
            pin_obj[n] = None
        pin_mode[n] = want
        pin_pull[n] = pull if want == MODE_IN else 0
        if want == MODE_IN:
            d = digitalio.DigitalInOut(_pin(n))
            if pull == 1:
                d.switch_to_input(pull=digitalio.Pull.DOWN)
            elif pull == 2:
                d.switch_to_input()
            else:
                d.switch_to_input(pull=digitalio.Pull.UP)
        else:
            d = digitalio.DigitalInOut(_pin(n))
            d.switch_to_output(value=bool((out_bits >> n) & 1))
        pin_obj[n] = d
    _reindex()
    kept = 0
    for n in out_idx:
        pin_obj[n].value = bool((out_bits >> n) & 1)
        if (out_bits >> n) & 1:
            kept |= 1 << n
    out_bits = kept


def set_out(mask, vals):
    global out_bits
    out_bits = (out_bits & ~mask) | (vals & mask)
    for n in out_idx:
        if (mask >> n) & 1:
            pin_obj[n].value = bool((out_bits >> n) & 1)


# —— PWM driver ——
pwm_obj = [None] * NUM_PINS
pwm_par = [None] * NUM_PINS  # (freq, duty 0..1) for reporting


def pwm_release(n):
    if pwm_obj[n]:
        pwm_obj[n].deinit()
        pwm_obj[n] = None
    pwm_par[n] = None


def pwm_start(pin, freq, duty):
    n = int(pin)
    if not 0 <= n < NUM_PINS:
        raise ValueError("pin out of range")
    if not claim(n, "pwm", force=True):  # steals plain-GPIO pins on purpose
        raise RuntimeError("pin busy")
    duty = max(0.0, min(1.0, float(duty)))
    if pwm_obj[n]:
        pwm_obj[n].frequency = int(freq)
        pwm_obj[n].duty_cycle = int(duty * 65535)
    else:
        pwm_obj[n] = PWMOut(_pin(n), frequency=int(freq), duty_cycle=int(duty * 65535))
    pwm_par[n] = (int(freq), duty)


def pwm_stop(pin):
    n = int(pin)
    if owner[n] == "pwm":
        release(n)


# —— ADC driver ——
adc_obj = [None] * NUM_PINS


def adc_release(n):
    if adc_obj[n]:
        adc_obj[n].deinit()
        adc_obj[n] = None


def adc_start(pin):
    n = int(pin)
    if not 0 <= n < NUM_PINS:
        raise ValueError("pin out of range")
    if not claim(n, "adc", force=True):  # steals gpio pins, like pwm does
        raise RuntimeError("pin busy")
    if not adc_obj[n]:
        adc_obj[n] = analogio.AnalogIn(_pin(n))


def adc_stop(pin):
    n = int(pin)
    if owner[n] == "adc":
        release(n)


# —— capability probe ——
def probe_caps():
    # Ask CircuitPython itself which pins support PWM / ADC instead of
    # hard-coding a per-chip table that drifts with CP releases.
    caps = {"pwm": [], "adc": []}
    for n in range(NUM_PINS):
        try:
            p = PWMOut(_pin(n), duty_cycle=0)
            p.deinit()
            caps["pwm"].append(n)
        except ValueError:
            pass
    for n in range(NUM_PINS):
        try:
            a = analogio.AnalogIn(_pin(n))
            a.deinit()
            caps["adc"].append(n)
        except ValueError:
            pass
    return caps


# —— state reporting & command table ——
def read_inputs():
    b = 0
    for n in in_idx:
        if pin_obj[n].value:
            b |= 1 << n
    return b


def read_state():
    pd = 0
    pn = 0
    for n in in_idx:
        if pin_pull[n] == 1:
            pd |= 1 << n
        elif pin_pull[n] == 2:
            pn |= 1 << n
    pwm_m = 0
    pw = {}
    adc_m = 0
    for n in range(NUM_PINS):
        if owner[n] == "pwm":
            pwm_m |= 1 << n
            pw[str(n)] = {"freq": pwm_par[n][0], "duty": pwm_par[n][1]}
        elif owner[n] == "adc":
            adc_m |= 1 << n
    return {
        "in": read_inputs(),
        "out": out_bits,
        "cfg_in": _mask_of(in_idx),
        "cfg_out": _mask_of(out_idx),
        "cfg_pd": pd,
        "cfg_pn": pn,
        "cfg_pwm": pwm_m,
        "cfg_adc": adc_m,
        "pwm": pw,
    }


def cmd_ping(args):
    return {"ok": True, "data": {"pong": args.get("t")}}


def cmd_echo(args):
    return {"ok": True, "data": {"echo": args.get("msg")}}


def cmd_gpio_cfg(args):
    apply_cfg(
        int(args.get("in", 0)),
        int(args.get("out", 0)),
        int(args.get("pd", 0)),
        int(args.get("pn", 0)),
    )
    return {"ok": True, "data": read_state()}


def cmd_gpio_out(args):
    set_out(int(args.get("mask", 0)), int(args.get("vals", 0)))
    return {"ok": True, "data": read_state()}


def cmd_gpio_state(args):
    return {"ok": True, "data": read_state()}


def cmd_pwm_cfg(args):
    pwm_start(args.get("pin"), args.get("freq", 1000), args.get("duty", 0.5))
    return {"ok": True, "data": read_state()}


def cmd_pwm_stop(args):
    pwm_stop(args.get("pin"))
    return {"ok": True, "data": read_state()}


def cmd_adc_cfg(args):
    adc_start(args.get("pin"))
    return {"ok": True, "data": read_state()}


def cmd_adc_stop(args):
    adc_stop(args.get("pin"))
    return {"ok": True, "data": read_state()}


COMMANDS = {
    "ping": cmd_ping,
    "echo": cmd_echo,
    "gpio.cfg": cmd_gpio_cfg,
    "gpio.out": cmd_gpio_out,
    "gpio.state": cmd_gpio_state,
    "pwm.cfg": cmd_pwm_cfg,
    "pwm.stop": cmd_pwm_stop,
    "adc.cfg": cmd_adc_cfg,
    "adc.stop": cmd_adc_stop,
}


def dispatch(req):
    rid = req.get("id")
    handler = COMMANDS.get(req.get("cmd"))
    if not handler:
        resp = {"ok": False, "error": "unknown cmd: %s" % req.get("cmd")}
    else:
        try:
            resp = handler(req.get("args") or {})
        except Exception as e:
            resp = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    resp["id"] = rid
    send(resp)


send(
    {
        "evt": "ready",
        "app": APP,
        "version": VERSION,
        "cp": list(sys.implementation.version[0:3]),
        "pins": NUM_PINS,
        "caps": probe_caps(),
    }
)


async def command_reader():
    buf = ""
    while True:
        got = False
        while True:
            try:
                ch = sys.stdin.read(1)  # non-blocking: None when nothing pending
            except OSError:
                ch = None
            if not ch:
                break
            got = True
            buf += ch
            if ch == "\n":
                line = buf.strip()
                buf = ""
                if not line:
                    continue
                try:
                    dispatch(parse_req(line))
                except ValueError:
                    send({"id": None, "ok": False, "error": "bad json"})
        await asyncio.sleep(0.002 if got else 0.01)


async def gpio_monitor():
    last = None
    alive = False
    while True:
        try:
            if not alive:
                alive = True
                send({"evt": "dbg", "task": "gpio", "alive": True})
            if in_idx:
                cur = read_inputs()
                if cur != last:
                    send({"evt": "gpio_in", "in": cur})
                    last = cur
        except Exception as e:  # never let a task die silently under gather
            send({"evt": "dbg", "task": "gpio", "err": "%s: %s" % (type(e).__name__, e)})
        await asyncio.sleep(0.05)


ADC_DEADBAND = 328  # ~0.5% of the 16-bit span; keeps noise off the wire


async def adc_monitor():
    sent = {}
    alive = False
    while True:
        try:
            if not alive:
                alive = True
                send({"evt": "dbg", "task": "adc", "alive": True})
            vals = {}
            for n in range(NUM_PINS):
                if adc_obj[n] is not None:
                    vals[str(n)] = adc_obj[n].value
            if vals:
                moved = len(vals) != len(sent) or any(
                    abs(v - sent.get(k, -98304)) > ADC_DEADBAND for k, v in vals.items()
                )
                if moved:
                    send({"evt": "adc", "vals": vals})
                    sent = vals
            else:
                sent = {}
        except Exception as e:
            send({"evt": "dbg", "task": "adc", "err": "%s: %s" % (type(e).__name__, e)})
        await asyncio.sleep(0.1)


async def main():
    send({"evt": "dbg", "task": "main", "alive": True})
    while True:
        try:
            await asyncio.gather(command_reader(), gpio_monitor(), adc_monitor())
        except Exception as e:  # a dead gather = dead events; say so loudly
            send({"evt": "dbg", "task": "gather", "err": "%s: %s" % (type(e).__name__, e)})
            await asyncio.sleep(0.2)


asyncio.run(main())
