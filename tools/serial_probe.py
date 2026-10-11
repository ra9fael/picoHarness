"""Host-side probe: verify JSON-lines handshake and ping/echo over USB CDC.

With boot.py the board enumerates two CDC ports that share one VID/PID, and only
behaviour tells them apart -- the same rule the UI uses. So this script classifies the
candidates with a nonce ping (the port that answers is the DATA port), restarts the
device program over the CONSOLE port, and reads the resulting ready broadcast from the
data port.

Usage:
    python tools/serial_probe.py            # auto-discover both ports
    python tools/serial_probe.py COM3 COM7  # restrict to these two
"""
import json
import sys
import time

import serial
from serial.tools import list_ports

VIDS = (0x239A, 0x2E8A)  # CircuitPython, plus the Raspberry Pi build of it
BAUD = 115200


def try_json(line):
    i = line.find("{")
    if i < 0:
        return None
    try:
        return json.loads(line[i:])
    except ValueError:
        return None


def open_port(name):
    s = serial.Serial(name, BAUD, timeout=0.2)
    s.reset_input_buffer()
    return s


def read_until(s, pred, seconds):
    """Return the first line pred accepts, or None."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        line = s.readline().decode(errors="replace").strip()
        if line and pred(line):
            return line
    return None


def is_protocol(name):
    """Ask the port to run a command: only code.py can answer with our nonce.

    A REPL echoes what we typed, and the echo contains the request itself, so the
    test matches the reply value rather than the id.
    """
    nonce = "probe%d" % (time.time() * 1000)
    req = {"id": 987654, "cmd": "ping", "args": {"t": nonce}}
    s = open_port(name)
    try:
        s.write((json.dumps(req) + "\n").encode())
        return read_until(s, lambda l: '"pong":"%s"' % nonce in l.replace(" ", ""), 1.0) is not None
    finally:
        s.close()


def kick(s):
    """Ctrl+C then Ctrl+D: a stopped device program comes back, at the cost of a reboot."""
    s.write(b"\x03")  # stop the running program -> REPL prompt
    time.sleep(0.5)
    s.write(b"\x04")  # soft reset from the prompt -> re-run code.py
    time.sleep(0.5)
    s.write(b"\x04")  # in case the first byte only woke the REPL


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
        # Nothing answers, so code.py is stopped or crashed: kick the other port and
        # look again -- the protocol only exists while the program runs.
        other = next((n for n in names if n != data), names[0])
        print("no port answered the ping; kicking", other)
        s = open_port(other)
        try:
            kick(s)
        finally:
            s.close()
        time.sleep(2)
        data = next((n for n in names if is_protocol(n)), None)
    if data is None:
        print("FAIL: still no data port after the kick")
        return 1
    ctl = next((n for n in names if n != data), None)
    print("data port: %s | console port: %s" % (data, ctl or "(single-port board)"))

    # Open the data port BEFORE restarting the device: CircuitPython drops CDC bytes
    # when no host holds the port, so the boot broadcast only arrives if a reader is
    # already attached.
    s = open_port(data)
    if ctl:
        k = open_port(ctl)
        try:
            kick(k)
        finally:
            k.close()
    line = read_until(s, lambda l: '"evt":"ready"' in l.replace(" ", ""), 12)
    if line is None:
        s.close()
        print("FAIL: no ready line on the data port")
        return 1
    print("HANDSHAKE OK:", line[:300])

    # Stray control bytes buffered during the reset must not glue onto a request.
    s.write(b"\n")
    time.sleep(0.3)
    s.reset_input_buffer()

    try:
        for cmd, args in [("hello", {}), ("ping", {"t": 123}), ("echo", {"msg": "hello pico"})]:
            req = {"id": int(time.time() * 1000) % 100000, "cmd": cmd, "args": args}
            s.write((json.dumps(req) + "\n").encode())
            t0 = time.time()
            line = read_until(s, lambda l: (try_json(l) or {}).get("id") == req["id"], 3)
            if line is None:
                print("FAIL: no reply for", cmd)
                return 1
            print("%s RTT=%dms -> %s" % (cmd, (time.time() - t0) * 1000, line[:200]))
    finally:
        s.close()
    print("SPIKE SERIAL TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
