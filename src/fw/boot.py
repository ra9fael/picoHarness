# PicoHarness boot configuration — runs before code.py on every power-on/reset.
# Two USB CDC ports: "console" is CircuitPython's own (REPL, print, tracebacks),
# "data" is what code.py runs the JSON-lines protocol on. Keeping them apart is
# what lets the host read the protocol stream without boot banners, log lines or
# REPL echoes mixed into it.
#
# The vault (cfg.save) is what this line pays for. Measured on CircuitPython 10.3.1
# / Pico 2, both halves of the trade:
#   remount("/", readonly=False)                       board can write, and Windows
#       loses write access to CIRCUITPY completely — the copy-onto-G: deploy is dead
#       until someone gets the volume back (safe mode: press RESET twice quickly,
#       which runs neither boot.py nor code.py). Do not "tighten" this line by
#       dropping the flag below.
#   remount(..., disable_concurrent_write_protection=True)   both sides can write.
#       The cost is that Windows reads the volume from a cache and only refreshes it
#       when the volume is re-read, so Explorer keeps showing an old config.json, or
#       keeps showing one the board already deleted, until a reset or a replug. So:
#       verify a board save with the UI's 载入/load, which asks the board, not with
#       Explorer. And if you are about to drag files onto G: after saving to the
#       board, reset first — that is the one moment the two views can disagree about
#       which clusters are free.
#
# Do NOT touch GPIO or build any bus object from here: GP0/GP1 are the console
# UART and the pin arbiter lives in code.py.
import storage
import usb_cdc

usb_cdc.enable(console=True, data=True)
storage.remount("/", readonly=False, disable_concurrent_write_protection=True)
