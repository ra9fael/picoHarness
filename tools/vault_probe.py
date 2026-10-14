"""End-to-end check of the device-side config vault on real hardware.

Drives the protocol port the way the UI does, and looks at the CIRCUITPY volume
from the host side where that is meaningful. Measured on CircuitPython 10.3.1 /
Pico 2, so the expectations below are not guesses:

* the board's writes are the truth; Windows shows G:\\config.json from a cache and
  only catches up when the volume is re-read, i.e. after a reset -> so the host
  check runs after the reset step, and a file that lingers there after cfg.clear
  is expected, not a failure;
* "survives a reboot" is the actual point of the feature, so reset is part of the
  probe, which also exercises the reset command;
* after any reset the port you can open is not necessarily the port you can use -
  Windows hands out a handle to the dead USB instance, whose first write fails - so
  every step that follows a reset retries until the board answers (the same rule
  tools/mount_ab.py measures).

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
    try:
        while buf:
            s.write(buf[:256])
            buf = buf[256:]
        s.flush()
    except Exception:
        return None  # the port is a stale instance, not a live one
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


def reply(cmd, obj_id, wait=1.3, max_wait=90):
    # Reaching the board after a reset is not the same as opening its port: Windows
    # keeps the previous instance of the interface around and hands out handles that
    # fail on the first write, so a reply - not a successful open - is the only proof.
    # Each round closes and reopens, because a handle bound to the dead instance never
    # heals. Same rule, same loop, as tools/mount_ab.py's hello().
    global s
    deadline = time.time() + max_wait
    while time.time() < deadline:
        try:
            if s is not None:
                s.close()
        except Exception:
            pass
        s = None
        try:
            reopen(wait=0.5)
            m = ask({"id": obj_id, "cmd": cmd}, wait)
        except Exception:
            m = None
        if m:
            return m
        time.sleep(2.0)
    return None


def host_bytes():
    if not host_path:
        return "(no volume mounted)"
    time.sleep(0.4)
    return open(host_path, "rb").read() if os.path.exists(host_path) else None


print("volume:", VOL or "(no G: - host-side checks skipped)")
m = reply("hello", 1)
caps = (m or {}).get("data", {}).get("caps", {})
print("hello  -> version=%s caps.cfg=%s" % ((m or {}).get("data", {}).get("version"), caps.get("cfg")))
if caps.get("cfg", {}).get("writable") is False:
    # boot.py on this board has no remount() line, so every write below is expected
    # to fail with Errno 30 - tools/mount_ab.py is the probe for that state.
    print("         NOTE: volume read-only for code.py; save steps will report Errno 30")
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
s = None
time.sleep(7.0)
m = reply("cfg.get", 6)
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
