"""On-board check of the firmware's PIO PWM backend.

Everything the PWM lane claims about PIO comes from this run, so it is deliberately
narrow: does caps report the table, do GP0 and GP1 accept first_set_pin (the two pins
the caps set inherits from the datasheet rather than from a probe), does a 0.1 Hz-class
channel start, does the 13th channel get refused with the budget named, and does the
budget come back when the channels are stopped.

Usage:
    python tools/pio_fw_check.py             # auto-discover the two CDC ports
    python tools/pio_fw_check.py COM3 COM7   # restrict to these

Copying the new code.py onto CIRCUITPY reboots the board, so attach this reader after
the copy, not before (the boot broadcast is dropped when no host holds the port).
"""
import json
import sys
import time

from serial.tools import list_ports
from serial_probe import VIDS, is_protocol, kick, open_port, read_until, try_json

PIO_PINS = list(range(12))  # 12 is exactly the RP2350's state-machine budget
HW_PIN = 14                 # kept out of the PIO set: a pad holds one generator
FULL_FREQ = 0.1             # the request the hardware slice cannot make at all


def ask(s, cmd, args, rid, timeout=4):
    req = {"id": rid, "cmd": cmd, "args": args}
    s.write((json.dumps(req) + "\n").encode())
    line = read_until(s, lambda l, r=req["id"]: (try_json(l) or {}).get("id") == r, timeout)
    if line is None:
        return None
    return json.loads(line[line.find("{"):])


def main():
    names = sys.argv[1:] or [
        p.device for p in list_ports.comports() if p.vid in VIDS and p.pid is not None
    ]
    if not names:
        print("FAIL: no CircuitPython CDC port found")
        return 1
    print("candidates:", ", ".join(names))
    data = next((n for n in names if is_protocol(n)), None)
    if data is None:
        other = names[0]
        print("no port answered the ping; kicking", other)
        k = open_port(other)
        kick(k)
        k.close()
        time.sleep(2)
        data = next((n for n in names if is_protocol(n)), None)
    if data is None:
        print("FAIL: still no data port after the kick")
        return 1
    print("data port:", data)

    s = open_port(data)
    fails = []
    try:
        rid = int(time.time() * 1000) % 1000000

        def check(label, ok, detail=""):
            print("%-4s %s %s" % ("ok" if ok else "FAIL", label, detail))
            if not ok:
                fails.append(label)

        r = ask(s, "hello", {}, rid + 1)
        caps = (r or {}).get("data", {}).get("caps") if r else None
        check("hello answers caps", bool(caps), "" if r else "(no reply)")
        pio = (caps or {}).get("pwm_pio")
        check("caps.pwm_pio is reported", pio is not None, json.dumps(pio))
        if not pio:
            print("no PIO in this build: copy lib/adafruit_pioasm.mpy and re-run")
            return 1

        chans = {}
        for n in PIO_PINS:
            reply = ask(
                s, "pwm.cfg", {"pin": n, "freq": FULL_FREQ, "duty": 0.5, "backend": "pio"},
                rid + 10 + n) or {}
            ch = (reply.get("data") or {}).get("pwm", {}).get(str(n))
            chans[n] = ch
            check(
                "GP%d starts at %g Hz on PIO" % (n, FULL_FREQ),
                bool(reply.get("ok")) and ch and ch.get("be") == "pio",
                "" if ch else json.dumps(reply.get("error")))
        got = [c for c in chans.values() if c]
        check(
            "every channel reports the frequency it generates",
            all(abs(c["hfreq"] - FULL_FREQ) / FULL_FREQ < 0.01 for c in got),
            " ".join("%d:%.6f" % (n, chans[n]["hfreq"]) for n in sorted(chans) if chans[n]))

        reply = ask(s, "pwm.cfg", {"pin": 12, "freq": 1000, "duty": 0.25, "backend": "pio"},
                    rid + 30) or {}
        err = str(reply.get("error"))
        check("the 13th channel is refused", reply.get("ok") is False, err)
        check("and names the budget", "12/12" in err, err)

        reply = ask(s, "gpio.state", {}, rid + 31) or {}
        st = reply.get("data") or {}
        want = sum(1 << n for n in PIO_PINS if chans.get(n))
        check("state.cfg_pio_pwm matches the live channels", st.get("cfg_pio_pwm") == want,
              "%s want %s" % (st.get("cfg_pio_pwm"), want))
        check("state.pio_sm_free is 0", st.get("pio_sm_free") == 0, str(st.get("pio_sm_free")))

        reply = ask(s, "pwm.cfg", {"pin": HW_PIN, "freq": 5, "duty": 0.5, "backend": "hw"},
                    rid + 32) or {}
        ch = (reply.get("data") or {}).get("pwm", {}).get(str(HW_PIN))
        check("GP%d still runs the hardware slice" % HW_PIN,
              bool(reply.get("ok")) and ch and ch.get("be") == "hw",
              json.dumps(ch) if ch else str(reply.get("error")))

        for n in PIO_PINS + [HW_PIN]:
            ask(s, "pwm.stop", {"pin": n}, rid + 40 + n)
        reply = ask(s, "gpio.state", {}, rid + 70) or {}
        st = reply.get("data") or {}
        check("the budget comes back", st.get("pio_sm_free") == pio.get("max_sm"),
              "%s of %s" % (st.get("pio_sm_free"), pio.get("max_sm")))
    finally:
        s.close()

    if fails:
        print("PIO FW CHECK FAILED (%d): %s" % (len(fails), ", ".join(fails)))
        return 1
    print("PIO FW CHECK PASSED")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
