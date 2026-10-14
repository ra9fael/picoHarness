"""A/B the volume mount on real hardware: does caps.cfg.writable track boot.py?

CircuitPython refuses to remount from code.py ("Cannot remount path when visible via
USB"), so the only way to see the other state is to change boot.py and do a hard
reset. This script does exactly that, uses the firmware's own reset command to walk
to the board for it (three resets: align the volume views, flip the mount, flip it
back), and always puts the shipped boot.py back.

What each half asserts (measured expectations, not guesses):

* writable=True  -> cfg.save lands, cfg.clear removes the file;
* writable=False -> caps.cfg reports it, cfg.save answers Errno 30, cfg.clear answers
  the read-only refusal instead of pretending the file was absent, and cfg.get still
  reads whatever is on the volume, because reading needs no write permission.

    python tools/mount_ab.py COM7
"""
import json, os, sys, time
import serial

# the error strings carry non-ascii and this console's default codec is gbk
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

VOL = "G:/"
PORT = sys.argv[1] if len(sys.argv) > 1 else "COM7"
SNAP = json.dumps({"v": 1, "pins": [{"n": 2, "r": 1, "p": 1}], "buses": [], "uarts": [], "spis": []})
SHIPPED = 'storage.remount("/", readonly=False, disable_concurrent_write_protection=True)'
LOCKED = 'storage.remount("/", readonly=True)'

s = None
fails = []


def check(cond, label):
    print("%-58s %s" % (label, "ok" if cond else "FAIL"))
    if not cond:
        fails.append(label)


def reopen(wait=1.0):
    global s
    for _ in range(25):
        try:
            s = serial.Serial(PORT, 115200, timeout=0.2, write_timeout=2.0)
            s.reset_input_buffer()
            return
        except Exception:
            time.sleep(wait)  # still re-enumerating after the reset
    raise RuntimeError("no %s after 25s" % PORT)


def ask(obj, wait=1.2):
    global s
    if s is None:
        reopen()
    buf = (json.dumps(obj) + "\n").encode()
    try:
        while buf:  # chunked: see the note in vault_probe.py about one big write
            s.write(buf[:256])
            buf = buf[256:]
        s.flush()
    except Exception:
        return None  # the port is a stale instance, not a live one
    time.sleep(wait)
    try:
        raw = s.read(s.in_waiting).decode("utf-8", "replace")
    except Exception:
        return None
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


def hello(max_wait=90):
    # Opening a port after a reset is not the same as reaching the board: Windows keeps
    # the previous instance of the interface around and hands out handles that fail on
    # the first write, so a reply - not a successful open - is the only proof. Each
    # round closes and reopens, because a handle bound to the dead instance never
    # heals.
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
            m = ask({"id": 1, "cmd": "hello"})
        except Exception:
            m = None
        if m:
            return (m or {}).get("data", {}).get("caps", {}).get("cfg", {})
        time.sleep(2.0)
    return {}


def reboot_and_wait():
    # The firmware answers, waits a quarter second, then resets; the port dies with
    # it, so drop the handle before waiting for the volume to come back.
    ask({"id": 90, "cmd": "reset"}, 0.12)
    try:
        s.close()
    except Exception:
        pass
    s = None
    time.sleep(7.0)


def write_boot(text):
    for _ in range(15):
        try:
            # utf-8 because boot.py's comments carry em dashes and this console's
            # default codec is gbk; the board reads the file as utf-8 regardless.
            with open(VOL + "boot.py", "w", encoding="utf-8") as f:
                f.write(text)
            return True
        except OSError:
            time.sleep(1.0)  # the volume is still coming up after the reset
    return False


def main():
    if not os.path.isdir(VOL):
        print("no %s - mount CIRCUITPY and rerun" % VOL)
        return 2
    # newline="" so the bytes round-trip exactly: Python's default text mode turns every
    # \n into \r\n on the way out, and a probe that "restores" boot.py should leave the
    # file identical to what it found, md5 and all.
    with open(VOL + "boot.py", encoding="utf-8", newline="") as f:
        original = f.read()
    if SHIPPED not in original:
        # Refuse to guess: the A/B only means something if the starting point is the
        # boot.py this repository ships.
        print("G:/boot.py is not the shipped variant (no %s line) - deploy it first" % SHIPPED)
        return 2
    try:
        print("== half 1: shipped boot.py (writable for code.py)")
        cfg = hello()
        check(cfg.get("writable") is True, "caps.cfg.writable is True")
        # Keep whatever the user had saved, if anything: this probe clears the vault to
        # prove writes work, and a fixture must not eat someone's real configuration.
        m = ask({"id": 10, "cmd": "cfg.get"})
        saved = (m or {}).get("data", {}).get("text")
        m = ask({"id": 2, "cmd": "cfg.clear"})
        check(bool(m and m.get("ok")), "cfg.clear accepted (%s)" % (m or {}).get("error"))
        m = ask({"id": 3, "cmd": "cfg.save", "args": {"text": SNAP}})
        check(bool(m and m.get("ok")), "cfg.save accepted (%s)" % (m or {}).get("error"))

        # Align the two views before touching the volume from this side. Windows has
        # cached the directory as it looked before the board wrote config.json, and a
        # host-side write from that snapshot is what eats the other side's new file —
        # the residual the docs warn about, not a bug in cfg.save. A reset makes the
        # host re-read the volume; the read-back also proves the file survived it.
        reboot_and_wait()
        cfg = hello()
        check(cfg.get("writable") is True, "still writable after the aligning reset")
        m = ask({"id": 11, "cmd": "cfg.get"})
        d = (m or {}).get("data", {})
        check(d.get("text") == SNAP, "cfg.get reads the file back after a reset")

        print("== half 2: boot.py forced to readonly=True, then reset")
        if not write_boot(original.replace(SHIPPED, LOCKED)):
            print("could not write G:/boot.py")
            return 2
        reboot_and_wait()
        cfg = hello()
        check(cfg.get("writable") is False, "caps.cfg.writable flipped to False")
        m = ask({"id": 4, "cmd": "cfg.save", "args": {"text": SNAP}})
        err = str((m or {}).get("error", ""))
        check(not (m or {}).get("ok") and "Errno 30" in err, "cfg.save refused with Errno 30 (%s)" % err)
        m = ask({"id": 5, "cmd": "cfg.clear"})
        err = str((m or {}).get("error", ""))
        check(not (m or {}).get("ok") and "read-only" in err, "cfg.clear refused honestly (%s)" % err)
        m = ask({"id": 6, "cmd": "cfg.get"})
        d = (m or {}).get("data", {})
        check(
            d.get("text") == SNAP,
            "cfg.get still reads the file written in half 1 (ok=%s bytes=%s err=%s)"
            % ((m or {}).get("ok"), d.get("bytes"), (m or {}).get("error")),
        )

        print("== restore: shipped boot.py back, then reset")
        if not write_boot(original):
            print("WARNING: could not restore G:/boot.py - copy it by hand from src/fw/boot.py")
            return 2
        reboot_and_wait()
        cfg = hello()
        check(cfg.get("writable") is True, "caps.cfg.writable back to True")
        m = ask({"id": 7, "cmd": "cfg.save", "args": {"text": SNAP}})
        check(bool(m and m.get("ok")), "cfg.save works again (%s)" % (m or {}).get("error"))
        m = ask({"id": 8, "cmd": "cfg.clear"})
        check(bool(m and m.get("ok")), "cfg.clear works again (%s)" % (m or {}).get("error"))
        if saved and saved != SNAP:
            m = ask({"id": 9, "cmd": "cfg.save", "args": {"text": saved}})
            check(bool(m and m.get("ok")), "restored the config that was on the board before")
    finally:
        if s is not None:
            s.close()
    print("\n%s" % ("ALL PASS" if not fails else "FAILED: " + ", ".join(fails)))
    return 0 if not fails else 1


sys.exit(main())
