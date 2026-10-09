"""Host-side probe: verify JSON-lines handshake and ping/echo over USB CDC."""
import json
import sys
import time

import serial

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM3"
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def try_json(line):
    i = line.find("{")
    if i < 0:
        return None
    try:
        return json.loads(line[i:])
    except ValueError:
        return None


def main():
    s = serial.Serial(PORT, 115200, timeout=0.2)
    s.reset_input_buffer()
    s.write(b"\x03")  # Ctrl+C: stop current program -> wakes/enters REPL
    time.sleep(0.4)
    s.write(b"\x04")  # Ctrl+D at REPL prompt: soft reset
    time.sleep(0.4)
    s.write(b"\x04")  # second one in case the first only woke the REPL
    deadline = time.time() + 8
    while time.time() < deadline:
        line = s.readline().decode(errors="replace").strip()
        if not line:
            continue
        print("  <", line)
        msg = try_json(line)
        if msg and msg.get("evt") == "ready":
            print("HANDSHAKE OK:", msg)
            break
    else:
        print("FAIL: no ready line")
        return 1
    # Flush stray control bytes buffered during reset so the next request
    # starts at a clean line boundary.
    s.write(b"\n")
    time.sleep(0.3)
    s.reset_input_buffer()

    for cmd, args in [("ping", {"t": 123}), ("echo", {"msg": "hello pico"})]:
        req = {"id": int(time.time() * 1000) % 100000, "cmd": cmd, "args": args}
        s.write((json.dumps(req) + "\n").encode())
        t0 = time.time()
        while time.time() - t0 < 3:
            line = s.readline().decode(errors="replace").strip()
            msg = try_json(line) if line else None
            if msg and msg.get("id") == req["id"]:
                print("%s RTT=%dms -> %s" % (cmd, (time.time() - t0) * 1000, line))
                break
        else:
            print("FAIL: no reply for", cmd)
            return 1
    print("SPIKE SERIAL TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
