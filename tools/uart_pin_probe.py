"""Board check for the UART pin set the RP2350 function table predicts.

probe_uart()'s hand-written tables omit GP28 (UART0 TX) and GP27 (UART1 RX).
This asks CircuitPython itself whether it accepts them, with same-instance and
cross-instance controls, so the table gets corrected on measurement rather than
on a datasheet reading alone.

Uses the raw REPL on the CONSOLE port (the protocol port is only probed, then
left closed, so code.py stops running and nothing else owns the pins).

  .venv/Scripts/python.exe tools/uart_pin_probe.py
"""

import sys
import time

import serial
import serial.tools.list_ports

PING = '{"id":987654,"cmd":"ping","args":{"t":"AUDITNONCE"}}\r\n'

SOURCE = """
import board, busio
PN = lambda n: getattr(board, "GP%d" % n)
CASES = [(28, 1), (26, 27), (28, 27), (0, 27), (28, 5), (2, 3), (4, 5), (28, -1), (27, -1)]
def probe(tx, rx):
    t, r = PN(tx), (None if rx < 0 else PN(rx))
    try:
        u = busio.UART(t, r, baudrate=115200, timeout=0)
        u.deinit()
        return "ok"
    except Exception as e:
        return "%s: %s" % (type(e).__name__, e)
for tx, rx in CASES:
    print("UART %s/%s -> %s" % (tx, rx, probe(tx, rx)))
"""


def drain(s, secs):
    end = time.time() + secs
    buf = b""
    while time.time() < end:
        n = s.in_waiting
        if n:
            buf += s.read(n)
        else:
            time.sleep(0.02)
    return buf


def protocol_port():
    """Close code.py's data port by finding it; returns its device name."""
    for p in serial.tools.list_ports.comports():
        if p.vid != 0x2E8A:
            continue
        try:
            s = serial.Serial(p.device, 115200, timeout=0.2, write_timeout=0.5)
        except Exception as e:
            print("%s busy (%s)" % (p.device, e))
            continue
        try:
            s.reset_input_buffer()
            s.write(PING.encode())
            buf = drain(s, 0.6)
        finally:
            s.close()
        if b"AUDITNONCE" in buf:
            return p.device
    return None


def main():
    proto = protocol_port()
    if not proto:
        print("no reachable protocol port: close the browser's Web Serial session first")
        return 1
    all_ports = [p.device for p in serial.tools.list_ports.comports() if p.vid == 0x2E8A]
    console = next((d for d in all_ports if d != proto), None)
    if not console:
        print("board came up single-port; no console to drive the REPL")
        return 1
    print("protocol %s (code.py stopped when it closed), console %s" % (proto, console))

    s = serial.Serial(console, 115200, timeout=1, write_timeout=1)
    s.write(b"\x03\x03")
    time.sleep(0.8)
    s.reset_input_buffer()
    s.write(b"\x01")  # raw REPL (Ctrl-A on this build)
    if not drain(s, 1.5).startswith(b"OK"):
        print("could not enter the raw REPL")
        s.close()
        return 1
    s.write(SOURCE.encode() + b"\x04")  # Ctrl-D runs the pasted block, replies OK
    buf = drain(s, 25)
    s.write(b"\x03")
    time.sleep(0.3)
    s.close()
    sys.stdout.buffer.write(buf.replace(b"\r", b""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
