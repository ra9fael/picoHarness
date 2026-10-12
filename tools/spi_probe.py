r"""One-off RP2350 SPI pin-capability sweep, run on the board over the REPL.

Nothing in the firmware may hard-code SPI pin groups until this has been measured
(CircuitPython's rp2 SPI constructor is the only authority on which (SCK, MOSI,
MISO) triples it will accept, and that answer has moved between releases). The
script is deliberately a measurement, not an assertion: it dumps what the port
accepts, rejects, and how the rejected ones fail.

Usage:
    python tools/spi_probe.py                 # pin sweep (takes minutes)
    python tools/spi_probe.py COM3            # ...over this console port
    python tools/spi_probe.py --followup      # instance limits, modes, clock landing
    python tools/spi_probe.py --api           # method set, lock discipline, throughput
    python tools/spi_probe.py --freq          # requested | .frequency | measured rate
Writes the device-side snippet to <CIRCUITPY>/spi_*.py, execs it through the raw REPL,
and prints the decoded findings (each mode also dumps its own spi_probe_*.json, which
is git-ignored -- re-run the tool rather than trusting a saved snapshot).

Measured on CircuitPython 10.3.1 / Pico 2 (rp2350a), 2026-10-12, and the basis for the
static table in src/fw/code.py: SPI pins are positional-only (no baudrate=/half_duplex=
kwarg), two peripherals only, .frequency tells the truth (the achievable clock is
150MHz divided by an even integer, so 75MHz max), and the routable pins form two groups
-- SCK 2/6/18/22 with MOSI 3/7/19/23 and MISO 0/4/16/20, SCK 10/14/26 with MOSI
11/15/27 and MISO 8/12/24/28 -- while 1571 other pairs the datasheet implies are
rejected with "Invalid pins".
"""
import json
import os
import re
import sys
import time

import serial
from serial.tools import list_ports

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

VIDS = (0x2E8A, 0x239A)
DRIVE = os.environ.get("CIRCUITPY_DRIVE", "G:/")

# Runs on the board. Prints one SWEEP<json> line at the end.
DEVICE_SRC = r'''
import json, board, busio, digitalio

NUM = 29
P = [getattr(board, "GP%d" % n) for n in range(NUM)]
out = {"cpver": None, "sck_alone": [], "mosi": {}, "miso": {}, "triple": [],
       "reject": {}, "baud": [], "half_duplex": None, "no_miso_read": None,
       "no_mosi_write": None, "loopback": None}

import microcontroller
out["cpver"] = microcontroller.circuitpython_version if hasattr(microcontroller, "circuitpython_version") else None

def tryit(label, fn):
    try:
        r = fn()
        return ("ok", r)
    except Exception as e:
        # The sweep fails on most pins by design, so tally by message instead of
        # dumping thousands of identical lines: distinct texts + counts is the
        # evidence, and the first label shows where each failure came from.
        k = type(e).__name__ + ": " + str(e)[:70]
        rec = out["reject"].get(k)
        if rec is None:
            out["reject"][k] = [1, label]
        else:
            rec[0] += 1
        return ("err", e)

def mk(sck, mosi=None, miso=None, **kw):
    def f():
        # mosi/miso are positional-only on the rp2 port (busio.SPI(..., mosi=..)
        # raises "unexpected keyword argument"), so pass them by position.
        o = busio.SPI(P[sck],
                     P[mosi] if mosi is not None else None,
                     P[miso] if miso is not None else None,
                     **kw)
        o.deinit()
        return True
    return f

# A: every ordered (SCK, partner) pair, tried in both roles. A bare SCK cannot be
#    constructed on this port at all -- busio.SPI(sck) raises "Must provide MISO or
#    MOSI pin" -- so the SCK-capable set is derived from the pairs that do build.
for s in range(NUM):
    for q in range(NUM):
        if q == s:
            continue
        if tryit("mosi %d/%d" % (s, q), mk(s, mosi=q))[0] == "ok":
            out["mosi"].setdefault(s, []).append(q)
        if tryit("miso %d/%d" % (s, q), mk(s, miso=q))[0] == "ok":
            out["miso"].setdefault(s, []).append(q)
    print("row %d done" % s)
out["sck_alone"] = sorted(set(out["mosi"]) | set(out["miso"]))

# C: full-duplex triples that the port accepts
for s, mo in out["mosi"].items():
    mi = out["miso"].get(int(s), [])
    for a in mo[:8]:
        for b in mi[:8]:
            if a == b:
                continue
            if tryit("spi %s/%d/%d" % (s, a, b), mk(int(s), mosi=a, miso=b))[0] == "ok":
                out["triple"].append([int(s), a, b])

# D: how high will one accepted bus go, and does it keep the number it is given?
if out["triple"]:
    s, a, b = out["triple"][0]
    for hz in (100000, 1000000, 10000000, 30000000, 62500000):
        # Measured here: baudrate= is not a constructor kwarg on this port, so the
        # speed has to be set with configure() under the lock; .frequency then
        # reports the clock the divider actually landed on, which is the number to
        # show the user (it is not always the one that was asked for).
        o = busio.SPI(P[s], P[a], P[b])
        try:
            if not o.try_lock():
                raise RuntimeError("could not lock")
            o.configure(baudrate=hz, polarity=0, phase=0)
            out["baud"].append([hz, "ok", o.frequency])
            o.unlock()
        except Exception as e:
            out["baud"].append([hz, "err", type(e).__name__ + ": " + str(e)[:40]])
        o.deinit()
    try:
        o = busio.SPI(P[s], P[a], P[b], half_duplex=True)
        o.deinit()
        out["half_duplex"] = "accepted"
    except Exception as e:
        out["half_duplex"] = type(e).__name__ + ": " + str(e)[:50]
    # E: what actually happens on a half bus
    o = busio.SPI(P[s], P[a], None)
    buf = bytearray(4)
    try:
        if o.try_lock():
            o.readinto(buf)
            o.unlock()
        out["no_miso_read"] = "ok"
    except Exception as e:
        out["no_miso_read"] = type(e).__name__ + ": " + str(e)[:60]
    o.deinit()
    o = busio.SPI(P[s], None, P[b])
    try:
        if o.try_lock():
            o.write(b"\x01")
            o.unlock()
        out["no_mosi_write"] = "ok"
    except Exception as e:
        out["no_mosi_write"] = type(e).__name__ + ": " + str(e)[:60]
    o.deinit()
    # F: no MOSI->MISO wire is assumed here. What this proves is that a full-duplex
    #    transfer runs on an idle bus, and that configure() only works inside the
    #    lock (measured: "Function requires lock" otherwise). The rp2 port has no
    #    writeread()/writeto_then_readfrom(), so full duplex is write_readinto().
    o = busio.SPI(P[s], P[a], P[b])
    r = bytearray(2)
    try:
        if not o.try_lock():
            raise RuntimeError("could not lock")
        o.configure(baudrate=1000000, polarity=1, phase=1)
        o.write_readinto(bytearray(b"\xAA\x55"), r)
        o.unlock()
        out["loopback"] = {"rd": list(r), "mode": "ok"}
    except Exception as e:
        out["loopback"] = type(e).__name__ + ": " + str(e)[:60]
    o.deinit()

print("SWEEP" + json.dumps(out))
'''


def cp_ports():
    for p in list_ports.comports():
        if p.vid in VIDS:
            yield p.device


def to_repl(s, patience=30.0):
    """Drive the board to a friendly '>>>' prompt.

    ^C stops code.py, ^B leaves the raw REPL (its own banner says so; at a
    friendly prompt it is a harmless cursor key), CR asks for the prompt. All three
    every round, because any byte that lands in the console while code.py is doing
    its multi-second boot probe parks the board in the raw REPL -- where ^C is data
    and never answers, so a ^C-only handshake just times out.
    """
    deadline = time.time() + patience
    while time.time() < deadline:
        s.write(b"\x03")
        time.sleep(0.3)
        s.write(b"\x02\r")
        s.flush()
        time.sleep(0.5)
        if b">>>" in s.read(4096):
            return True
    return False


def raw_exec(s, code, timeout=900.0):
    """Run one block through the raw REPL and collect everything it prints.

    Protocol: ^A makes the device answer "OK" when it will accept code; the block
    must end with \\r\\n (a lone \\n is echoed but never executed) and ^D runs it;
    the device then prints its output followed by \\x04. Progress lines are echoed
    live -- a full sweep takes minutes and a silent wait is indistinguishable from
    a hang.
    """
    s.write(b"\x01")
    deadline = time.time() + 3
    while b"OK" not in s.read(256) and time.time() < deadline:
        pass
    # Chunked: a multi-KB paste outruns the REPL's line ring buffer and loses bytes.
    blob = code.encode() + b"\r\n"
    for i in range(0, len(blob), 256):
        s.write(blob[i : i + 256])
        s.flush()
        time.sleep(0.03)
    s.write(b"\x04")
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        chunk = s.read(4096)
        if chunk:
            text = chunk.decode("utf-8", "replace")
            if "SWEEP" not in text:
                print(text.strip()[:200], flush=True)
            buf += chunk
            if b"\x04" in buf:
                break
    return buf.decode("utf-8", "replace")


def verify_protocol(wanted=30.0):
    """Leave the board in the state the UI expects: code.py answering on its port.

    The sweep ran from the REPL, so code.py was stopped for its duration and the
    volatile pin/bus config is gone with it. Ping every CircuitPython CDC port and
    report which one answers, so a failure here is visible instead of surprising the
    next Web Serial connect.
    """
    nonce = "spi-probe-%d" % int(time.time())
    req = ('{"id":1,"cmd":"ping","args":{"t":"%s"}}\r\n' % nonce).encode()
    deadline = time.time() + wanted
    while time.time() < deadline:
        for name in cp_ports():
            try:
                with serial.Serial(name, 115200, timeout=0.15) as s:
                    s.write(req)
                    buf = b""
                    end = time.time() + 1.0
                    while time.time() < end:
                        buf += s.read(512)
                        if nonce.encode() in buf and b"pong" in buf:
                            return name
            except Exception:
                pass
        time.sleep(0.5)
    return None


# Third device snippet: the method set, and whether the ~84% throughput deficit is
# a clock-divider artifact or per-transfer overhead.
API_SRC = r'''
import json, board, busio, time

P = [getattr(board, "GP%d" % n) for n in range(29)]
out = {}
a = busio.SPI(P[2], P[3], P[0])
out["dir"] = [m for m in dir(a) if not m.startswith("_")]


def measured(o, hz, n):
    if not o.try_lock():
        return None
    try:
        o.configure(baudrate=hz)
        t0 = time.monotonic_ns()
        o.write(bytearray(n))
        dt = (time.monotonic_ns() - t0) / 1e9
    finally:
        o.unlock()
    return round(n * 8 / dt) if dt > 0 else None


# Same rate, three payload sizes: a fixed per-call cost shows up as a shrinking
# deficit, a wrong divider as a deficit that never moves.
out["scale"] = [[n, measured(a, 1000000, n)] for n in (64, 512, 4096, 32768)]

# Does configure() keep the number it is handed at the top of the range?
out["top"] = [[hz, measured(a, hz, 4096)] for hz in (10000000, 20000000, 30000000, 50000000)]

# A bus on the other instance, alive alongside this one, using whichever
# read/transfer methods this build actually has.
b = busio.SPI(P[10], P[11], P[8])
how = None
try:
    if b.try_lock():
        b.configure(baudrate=1000000)
        w = bytearray(b"\xAA\x55")
        r = bytearray(2)
        if hasattr(b, "writeread"):
            b.writeread(w, r)
            how = "writeread"
        elif hasattr(b, "writeto_then_readfrom"):
            b.writeto_then_readfrom(w, r)
            how = "writeto_then_readfrom"
        else:
            b.write(w)
            b.readinto(r)
            how = "write+readinto"
        b.unlock()
    out["two_instances"] = [how, list(r)]
except Exception as e:
    out["two_instances"] = [type(e).__name__ + ": " + str(e)[:60]]

# Lock discipline: what does an unlocked transfer say, and is the lock exclusive
# across instances?
try:
    a.write(bytearray(1))
    out["unlocked_write"] = "allowed"
except Exception as e:
    out["unlocked_write"] = type(e).__name__ + ": " + str(e)[:50]
locked = a.try_lock()
other = None
try:
    if b.try_lock():
        other = "got second lock while first held"
        b.unlock()
    else:
        other = "busy"
except Exception as e:
    other = type(e).__name__ + ": " + str(e)[:50]
out["lock_across_instances"] = other
if locked:
    a.unlock()

# Pin reuse: can a still-bound bus's SCK be grabbed by digitalio underneath it?
try:
    import digitalio
    d = digitalio.DigitalInOut(P[2])
    d.switch_to_output()
    out["gpio_under_bus"] = "allowed (no claim check)"
    d.deinit()
except Exception as e:
    out["gpio_under_bus"] = type(e).__name__ + ": " + str(e)[:60]

a.deinit()
b.deinit()
# After deinit the instance must be free again -- spi.release() depends on it.
try:
    c = busio.SPI(P[18], P[19], P[16])
    out["reuse_after_deinit"] = "ok"
    c.deinit()
except Exception as e:
    out["reuse_after_deinit"] = type(e).__name__ + ": " + str(e)[:60]
print("API" + json.dumps(out))
'''


# Fourth device snippet: is the frequency property the request or the hardware?
# (PWM taught us this distinction is worth a whole bug report.)
FREQ_SRC = r'''
import json, board, busio, time

P = [getattr(board, "GP%d" % n) for n in range(29)]
a = busio.SPI(P[2], P[3], P[0])
rows = []
for hz in (9600, 50000, 100000, 500000, 1000000, 2000000, 3125000, 5000000,
           10000000, 15625000, 20000000, 25000000, 26843178, 30000000, 50000000,
           62500000, 100000000):
    try:
        if not a.try_lock():
            rows.append([hz, "lock busy"])
            continue
        try:
            a.configure(baudrate=hz)
            reported = a.frequency
            t0 = time.monotonic_ns()
            a.write(bytearray(4096))
            dt = (time.monotonic_ns() - t0) / 1e9
        finally:
            a.unlock()
        rows.append([hz, reported, round(4096 * 8 / dt) if dt > 0 else None])
    except Exception as e:
        rows.append([hz, type(e).__name__ + ": " + str(e)[:50]])
a.deinit()
print("FREQ" + json.dumps({"rows": rows}))
'''


def freq_probe():
    """requested Hz | property | measured throughput -- the three can all differ."""
    data = stage_and_run("spi_freq_probe.py", FREQ_SRC, "FREQ")
    if data is None:
        return 1
    with open("spi_probe_freq.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print("%12s %14s %14s" % ("requested", "frequency", "throughput"))
    for row in data["rows"]:
        print("%12s %14s %14s" % tuple([str(x) for x in (row + ["", ""])[:3]]))
    return 0


def api_probe():
    """Print what the third round measured: method names and the real clock story."""
    data = stage_and_run("spi_api_probe.py", API_SRC, "API")
    if data is None:
        return 1
    with open("spi_probe_api.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print("SPI methods on this build: %s" % data["dir"])
    print("throughput at 1 MHz vs payload size: %s" % data["scale"])
    print("top of the range: %s" % data["top"])
    print("two instances at once (%s): %s" % (data["lock_across_instances"], data["two_instances"]))
    print("unlocked write: %s" % data["unlocked_write"])
    print("digitalio on a live bus pin: %s" % data["gpio_under_bus"])
    print("instance reusable after deinit: %s" % data["reuse_after_deinit"])
    return 0


def stage_and_run(fname, src, marker="SWEEP", port=None):
    """Write a device-side snippet to the CIRCUITPY volume and run it from the REPL."""
    if not os.path.isdir(DRIVE):
        print("no CIRCUITPY volume at %s (set CIRCUITPY_DRIVE)" % DRIVE)
        return None
    dst = os.path.join(DRIVE, fname)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(src)
    ports = [port] if port else ([p for p in sys.argv[1:] if not p.startswith("-")] or list(cp_ports()))
    if not ports:
        print("no CircuitPython serial port found")
        return None
    print("using %s" % ports[0])
    with serial.Serial(ports[0], 115200, timeout=0.2) as s:
        if not to_repl(s):
            print("could not reach the REPL prompt")
            return None
        out = raw_exec(s, "exec(open('/%s').read())" % fname)
    m = re.search(marker + r"(\{.*\})", out, re.S)
    if not m:
        print("--- device said ---")
        print(out[-3000:])
        print("(no %s line found -- the snippet raised early)" % marker)
        return None
    return json.loads(m.group(1))


def followup():
    """Measure the SPI settings API, not just the pin map.

    The first sweep proved which pins build; this one answers what the object will
    actually accept afterwards -- and on this port the constructor takes no
    baudrate at all, so every speed/polarity question belongs to configure().
    """
    data = stage_and_run("spi_cfg_probe.py", CONFIG_SRC, "CFG")
    if data is None:
        return 1
    with open("spi_probe_config.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print("repr of a group-A bus: %s" % data.get("repr_a"))
    print("repr of a group-B bus: %s" % data.get("repr_b"))
    print("configure() per speed:")
    for row in data.get("baud", []):
        print("  %s" % row)
    print("polarity/phase: %s" % data.get("modes"))
    print("two buses, same instance: %s" % data.get("same_instance"))
    print("two buses, different instances: %s" % data.get("two_instances"))
    print("CSn pad as data pin: %s" % data.get("csn_as_pad"))
    print("gpio on an SPI pin while bus alive: %s" % data.get("gpio_conflict"))
    return 0


# Second device snippet: the settings API and instance limits.
CONFIG_SRC = r'''
import json, board, busio, time

P = [getattr(board, "GP%d" % n) for n in range(29)]
out = {"repr_a": None, "repr_b": None, "baud": [], "modes": None,
       "same_instance": None, "two_instances": None}


def bus(s, m, i):
    return busio.SPI(P[s], P[m], P[i])


# What the object calls itself is the cheapest read on which PL022 instance it took.
a = bus(2, 3, 0)
out["repr_a"] = repr(a)
b = bus(10, 11, 8)
out["repr_b"] = repr(b)

# The constructor takes no baudrate on this port, so speed lives entirely in
# configure(), and the only honest read of what the clock did is timing a
# transfer: bits / elapsed. A 512-byte write at the requested rate says whether
# the divider rounds, clamps, or silently ignores.
buf = bytearray(512)
for hz in (9600, 100000, 1000000, 3000000, 5000000, 10000000, 20000000, 40000000, 62500000):
    try:
        if not a.try_lock():
            out["baud"].append([hz, "lock busy"])
            continue
        try:
            a.configure(baudrate=hz)
            t0 = time.monotonic_ns()
            a.write(buf)
            dt = (time.monotonic_ns() - t0) / 1e9
        finally:
            a.unlock()
        out["baud"].append([hz, "ok", round(len(buf) * 8 / dt) if dt > 0 else None])
    except Exception as e:
        out["baud"].append([hz, type(e).__name__ + ": " + str(e)[:50]])

try:
    if a.try_lock():
        for pol in (0, 1):
            for ph in (0, 1):
                a.configure(baudrate=1000000, polarity=pol, phase=ph)
        a.unlock()
    out["modes"] = "all four accepted"
except Exception as e:
    out["modes"] = type(e).__name__ + ": " + str(e)[:60]

# A second bus on the same instance must not be silently allowed.
try:
    a2 = bus(18, 19, 16)
    out["same_instance"] = "allowed: " + repr(a2)
    a2.deinit()
except Exception as e:
    out["same_instance"] = type(e).__name__ + ": " + str(e)[:60]

# ... and both instances alive at once, each still transferring.
try:
    w = bytearray(b"\xAA")
    r = bytearray(1)
    for o in (a, b):
        if o.try_lock():
            o.configure(baudrate=1000000)
            o.writeread(w, r)
            o.unlock()
    out["two_instances"] = "both alive, rd=%d" % r[0]
except Exception as e:
    out["two_instances"] = type(e).__name__ + ": " + str(e)[:60]

a.deinit()
b.deinit()
print("CFG" + json.dumps(out))
'''


def main():
    if "--api" in sys.argv:
        return api_probe()
    if "--freq" in sys.argv:
        return freq_probe()
    if "--followup" in sys.argv:
        return followup()
    # 1. stage the sweep on the device volume
    dst = os.path.join(DRIVE, "spi_sweep.py")
    if not os.path.isdir(DRIVE):
        print("no CIRCUITPY volume at %s (set CIRCUITPY_DRIVE)" % DRIVE)
        return 1
    with open(dst, "w", encoding="utf-8") as f:
        f.write(DEVICE_SRC)
    print("staged %s" % dst)

    # 2. run it from the REPL, reading only its printed line
    ports = sys.argv[1:] or list(cp_ports())
    if not ports:
        print("no CircuitPython serial port found")
        return 1
    port = ports[0]
    print("using %s" % port)
    with serial.Serial(port, 115200, timeout=0.2) as s:
        if not to_repl(s):
            print("could not reach the REPL prompt")
            return 1
        out = raw_exec(s, "exec(open('/spi_sweep.py').read())")
    m = re.search(r"SWEEP(\{.*\})", out, re.S)
    if not m:
        print("--- device said ---")
        print(out[-4000:])
        print("(no SWEEP line found -- the sweep raised early)")
        return 1
    data = json.loads(m.group(1))
    with open("spi_probe_result.json", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)

    print("SCK-capable pins: %s" % data["sck_alone"])
    for s in sorted(data["mosi"], key=int):
        print("  SCK GP%s -> MOSI %s | MISO %s" % (s, data["mosi"][s], data["miso"].get(s, [])))
    print("accepted triples: %d (first 8: %s)" % (len(data["triple"]), data["triple"][:8]))
    print("baudrate: %s" % data["baud"])
    print("half_duplex: %s" % data["half_duplex"])
    print("read on a MOSI-only bus: %s" % data["no_miso_read"])
    print("write on a MISO-only bus: %s" % data["no_mosi_write"])
    print("transfer on an idle bus: %s" % data["loopback"])
    print("distinct failure texts:")
    for k, v in sorted(data["reject"].items(), key=lambda kv: -kv[1][0])[:12]:
        print("  %5d x %s   (first: %s)" % (v[0], k, v[1]))
    answered = verify_protocol()
    print("protocol port answering ping after the sweep: %s" % (answered or "NONE"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
