"""End-to-end check of the device-side config vault on real hardware.

Drives the protocol port the way the UI does, and looks at the CIRCUITPY volume
from the host side where that is meaningful. Measured on CircuitPython 10.3.1 /
Pico 2, so the expectations below are not guesses:

* the board's writes are the truth; Windows shows G:\\config.json from a cache and
  only catches up when the volume is re-read, i.e. after a reset -> so the host
  check runs after the reset step, and a file that lingers there after cfg.clear
  is expected, not a failure;
* "survives a reboot" is the actual point of the feature, so reset is part of the
  probe, which also exercises the reset command.

    python tools/vault_probe.py COM7
"""
import json, os, sys, time
import serial

VOL = "G:/" if os.path.isdir("G:/") else None
port = sys.argv[1] if len(sys.argv) > 1 else "COM7"
SNAP = json.dumps({"v": 1, "pins": [{"n": 2, "r": 1, "p": 1}], "buses": [], "uarts": [], "spis": []})
host_path = os.path.join(VOL, "config.json") if VOL else None

s = None


def reopen(wait=1.2):
    global s
    for _ in range(20):
        try:
            s = serial.Serial(port, 115200, timeout=0.2, write_timeout=2.0)
            s.reset_input_buffer()
            return
        except Exception:
            time.sleep(1.0)  # the port is still re-enumerating after the reset
    raise RuntimeError("no %s after 20s" % port)


def ask(obj, wait=1.3):
    global s
    if s is None:
        reopen()
    buf = (json.dumps(obj) + "\n").encode()
    # Chunked, because the device drains the CDC FIFO a few hundred bytes at a time:
    # a single 65 KB write would time out in the host driver long before the board
    # finished reading it, which says nothing about the firmware's own size guard.
    while buf:
        s.write(buf[:256])
        buf = buf[256:]
    s.flush()
    time.sleep(wait)
    try:
        raw = s.read(s.in_waiting).decode("utf-8", "replace")
    except Exception:
        return None  # the port vanished under us - a reset was expected
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("id") == obj.get("id"):
            return m
    return None


def host_bytes():
    if not host_path:
        return "(no volume mounted)"
    time.sleep(0.4)
    return open(host_path, "rb").read() if os.path.exists(host_path) else None


print("volume:", VOL or "(no G: - host-side checks skipped)")
reopen()
# ask twice: the first frame after opening the port can be swallowed while the
# connection settles, and a probe that flakes on hello is a probe nobody trusts.
m = ask({"id": 1, "cmd": "hello"}) or ask({"id": 1, "cmd": "hello"})
caps = (m or {}).get("data", {}).get("caps", {})
print("hello  -> version=%s caps.cfg=%s" % ((m or {}).get("data", {}).get("version"), caps.get("cfg")))
print("clear  ->", ask({"id": 2, "cmd": "cfg.clear"}), "(start from empty)")

m = ask({"id": 3, "cmd": "cfg.save", "args": {"text": SNAP}})
print("save   ->", m)
m = ask({"id": 4, "cmd": "cfg.get"})
d = (m or {}).get("data", {})
print("get    -> ok=%s bytes=%s equal=%s" % ((m or {}).get("ok"), d.get("bytes"), d.get("text") == SNAP))

# The firmware replies first and resets 0.25s later, so read inside that window or
# the port is gone before the bytes can be collected.
print("reset  ->", ask({"id": 5, "cmd": "reset", "args": {}}, 0.12), "(the port drops here)")
s.close()
time.sleep(7.0)
reopen()
m = ask({"id": 6, "cmd": "cfg.get"})
d = (m or {}).get("data", {})
print("get    -> survived reboot: %s" % (d.get("text") == SNAP))
print("host   -> sees the same bytes: %s" % (host_bytes() == SNAP.encode()))

print("nojson ->", ask({"id": 7, "cmd": "cfg.save", "args": {"text": "not json"}}))
print("nopins ->", ask({"id": 8, "cmd": "cfg.save", "args": {"text": '{"v":1}'}}))
huge = json.dumps({"v": 1, "pins": [], "pad": "x" * 70000})
print("toobig ->", ask({"id": 9, "cmd": "cfg.save", "args": {"text": huge}}, 3.0))
print("clear  ->", ask({"id": 10, "cmd": "cfg.clear"}))
print("get    ->", ask({"id": 11, "cmd": "cfg.get"}), "(device says gone; Explorer may still show the old copy)")
s.close()
