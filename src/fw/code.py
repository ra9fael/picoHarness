# PicoHarness firmware — IO workbench stage
# JSON-lines command loop over USB CDC (REPL stdin/stdout).
# Note: CircuitPython has no select()/non-blocking stdin, so input levels are
# sampled on demand (host polls gpio.state); the device cannot push gpio_in
# events while blocked in readline().
import sys
import json

import board
import digitalio
import analogio
from pwmio import PWMOut

APP = "PicoHarness"
VERSION = "0.0.6-wb"
NUM_PINS = 27  # GP0..GP26

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


pin_obj = [None] * NUM_PINS
pin_mode = [MODE_UNUSED] * NUM_PINS
pin_pull = [0] * NUM_PINS  # valid for inputs: 0 = up, 1 = down, 2 = none
out_bits = 0
in_idx = ()
out_idx = ()


def _pin(n):
    return getattr(board, "GP%d" % n)


def _reindex():
    global in_idx, out_idx
    in_idx = tuple(n for n in range(NUM_PINS) if pin_mode[n] == MODE_IN)
    out_idx = tuple(n for n in range(NUM_PINS) if pin_mode[n] == MODE_OUT)


def _mask_of(idxs):
    m = 0
    for n in idxs:
        m |= 1 << n
    return m


def apply_cfg(in_mask, out_mask, pd_mask=0, pn_mask=0):
    # Incremental: only pins whose direction (or input pull) changed are
    # reconfigured, so untouched outputs never glitch. Output wins over input.
    # Pull: DOWN if pd bit, NONE if pn bit, else UP.
    global out_bits
    for n in range(NUM_PINS):
        if pwm_obj[n]:
            continue  # owned by PWM; release it there first
        want = MODE_OUT if (out_mask >> n) & 1 else (MODE_IN if (in_mask >> n) & 1 else MODE_UNUSED)
        pull = 1 if (pd_mask >> n) & 1 else (2 if (pn_mask >> n) & 1 else 0)
        if want == pin_mode[n] and (want != MODE_IN or pull == pin_pull[n]):
            continue
        if pin_obj[n]:
            pin_obj[n].deinit()
            pin_obj[n] = None
        pin_mode[n] = want
        pin_pull[n] = pull if want == MODE_IN else 0
        if want:
            d = digitalio.DigitalInOut(_pin(n))
            if want == MODE_IN:
                if pull == 1:
                    d.switch_to_input(pull=digitalio.Pull.DOWN)
                elif pull == 2:
                    d.switch_to_input()
                else:
                    d.switch_to_input(pull=digitalio.Pull.UP)
            else:
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


pwm_obj = [None] * NUM_PINS
pwm_par = [None] * NUM_PINS  # (freq, duty 0..1) for reporting


def pwm_start(pin, freq, duty):
    n = int(pin)
    if not 0 <= n < NUM_PINS:
        raise ValueError("pin out of range")
    if pin_obj[n]:  # hand the pin over from plain GPIO output
        pin_obj[n].deinit()
        pin_obj[n] = None
        pin_mode[n] = MODE_UNUSED
        _reindex()
    duty = max(0.0, min(1.0, float(duty)))
    if pwm_obj[n]:
        pwm_obj[n].frequency = int(freq)
        pwm_obj[n].duty_cycle = int(duty * 65535)
    else:
        pwm_obj[n] = PWMOut(_pin(n), frequency=int(freq), duty_cycle=int(duty * 65535))
    pwm_par[n] = (int(freq), duty)


def pwm_stop(pin):
    n = int(pin)
    if pwm_obj[n]:
        pwm_obj[n].deinit()
        pwm_obj[n] = None
    pwm_par[n] = None


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


def read_state():
    b = 0
    for n in in_idx:
        if pin_obj[n].value:
            b |= 1 << n
    pd = 0
    pn = 0
    for n in in_idx:
        if pin_pull[n] == 1:
            pd |= 1 << n
        elif pin_pull[n] == 2:
            pn |= 1 << n
    pwm_m = 0
    pw = {}
    for n in range(NUM_PINS):
        if pwm_obj[n]:
            pwm_m |= 1 << n
            pw[str(n)] = {"freq": pwm_par[n][0], "duty": pwm_par[n][1]}
    return {
        "in": b,
        "out": out_bits,
        "cfg_in": _mask_of(in_idx),
        "cfg_out": _mask_of(out_idx),
        "cfg_pd": pd,
        "cfg_pn": pn,
        "cfg_pwm": pwm_m,
        "pwm": pw,
    }


CAPS = probe_caps()

send(
    {
        "evt": "ready",
        "app": APP,
        "version": VERSION,
        "cp": list(sys.implementation.version[0:3]),
        "pins": NUM_PINS,
        "caps": CAPS,
    }
)

while True:
    line = sys.stdin.readline()
    if not line:
        continue
    line = line.strip()
    if not line:
        continue
    try:
        req = parse_req(line)
    except ValueError:
        send({"id": None, "ok": False, "error": "bad json"})
        continue
    rid = req.get("id")
    cmd = req.get("cmd")
    args = req.get("args") or {}
    try:
        if cmd == "ping":
            resp = {"ok": True, "data": {"pong": args.get("t")}}
        elif cmd == "echo":
            resp = {"ok": True, "data": {"echo": args.get("msg")}}
        elif cmd == "gpio.cfg":
            apply_cfg(
                int(args.get("in", 0)),
                int(args.get("out", 0)),
                int(args.get("pd", 0)),
                int(args.get("pn", 0)),
            )
            resp = {"ok": True, "data": read_state()}
        elif cmd == "gpio.out":
            set_out(int(args.get("mask", 0)), int(args.get("vals", 0)))
            resp = {"ok": True, "data": read_state()}
        elif cmd == "gpio.state":
            resp = {"ok": True, "data": read_state()}
        elif cmd == "pwm.cfg":
            pwm_start(args.get("pin"), args.get("freq", 1000), args.get("duty", 0.5))
            resp = {"ok": True, "data": read_state()}
        elif cmd == "pwm.stop":
            pwm_stop(args.get("pin"))
            resp = {"ok": True, "data": read_state()}
        else:
            resp = {"ok": False, "error": "unknown cmd: %s" % cmd}
    except Exception as e:
        resp = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    resp["id"] = rid
    send(resp)
