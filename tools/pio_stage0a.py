# Stage 0a: can a device-side program write a file onto CIRCUITPY at all, and
# which import (if any) stops the real probe? Deploy as code.py.
import os
import sys
import time

TRIED = []


def w(msg):
    for path in ("/probe_log.txt", "/sd/probe_log.txt"):
        try:
            with open(path, "a") as f:
                f.write(msg + "\n")
            return True
        except OSError as e:
            TRIED.append("%s %s(%s)" % (path, type(e).__name__, e))
    try:
        print(msg)
    except OSError:
        pass
    return False


w("A enter code.py")
try:
    import storage
    w("B storage %s" % getattr(storage, "readonly", None))
    import board
    import microcontroller
    w("C board %s" % getattr(board, "ID", "?"))
    import array
    w("D array")
    import rp2pio
    w("E rp2pio %s" % sorted(n for n in dir(rp2pio) if not n.startswith("_")))
    import adafruit_pioasm
    w("F pioasm %s" % sorted(n for n in dir(adafruit_pioasm) if not n.startswith("_")))
    w("G all imports OK")
except BaseException as e:
    w("X FAIL %s: %s" % (type(e).__name__, e))
    for path in ("/probe_log.txt", "/sd/probe_log.txt"):
        try:
            with open(path, "a") as f:
                sys.print_exception(e, f)
            break
        except OSError:
            pass

if TRIED:
    try:
        with open("/probe_log.txt", "a") as f:
            f.write("write attempts: %s\n" % TRIED)
    except OSError:
        pass
w("H done")
time.sleep(100000)
