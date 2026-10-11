# PicoHarness boot configuration — runs before code.py on every power-on/reset.
# Two USB CDC ports: "console" is CircuitPython's own (REPL, print, tracebacks),
# "data" is what code.py runs the JSON-lines protocol on. Keeping them apart is
# what lets the host read the protocol stream without boot banners, log lines or
# REPL echoes mixed into it.
#
# Everything else about USB stays at CircuitPython defaults: the CIRCUITPY drive
# (MSC) stays enabled, because deploying means copying files onto it.
#
# Do NOT touch GPIO or build any bus object from here: GP0/GP1 are the console
# UART and the pin arbiter lives in code.py.
import usb_cdc

usb_cdc.enable(console=True, data=True)
