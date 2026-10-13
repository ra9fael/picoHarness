# Collect the Stage 0 PIO probe report from the board's DATA CDC port.
#
# Run this after tools/pio_pwm_probe.py is deployed as code.py; the probe
# replays its whole report every second, so attaching late still works.
#
#   python tools/pio_pwm_read.py [COM7] [seconds]
#   python tools/pio_pwm_read.py [COM7] [seconds] raw   # keep duplicates
import sys
import time

import serial
from serial.tools import list_ports

VIDS = (0x239A, 0x2E8A)
port = sys.argv[1] if len(sys.argv) > 1 else None
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 150.0

if port is None:
    cands = [p.device for p in list_ports.comports() if p.vid in VIDS]
    if not cands:
        sys.exit("no CircuitPython port found")
    port = cands[-1]
    print("using %s (candidates %s)" % (port, cands), flush=True)

raw = "raw" in sys.argv[3:]
s = serial.Serial(port, 115200, timeout=0.2)
s.reset_input_buffer()
seen = set()
partial = b""
t_end = time.monotonic() + seconds
t0 = time.monotonic()
while time.monotonic() < t_end:
    chunk = s.read(4096)
    if chunk:
        partial += chunk
        while b"\n" in partial:
            line, partial = partial.split(b"\n", 1)
            text = line.decode("utf-8", "replace").strip()
            if text and (raw or text not in seen):
                if raw:
                    dup = " DUP" if text in seen else ""
                    print("%.3f %s%s" % (time.monotonic() - t0, text, dup), flush=True)
                else:
                    print(text, flush=True)
                seen.add(text)
s.close()
print("--- %d unique lines from %s" % (len(seen), port), flush=True)
