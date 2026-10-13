# Stage 0 probe for PIO-backed PWM: what does this board's PIO actually do?
#
# Deploy as code.py on the CIRCUITPY drive, then read the DATA CDC port:
#     python tools/pio_pwm_read.py COM7 120
#     python tools/pio_pwm_read.py COM7 120 raw   # keep the replay duplicates
#
# The feasibility questions and the arithmetic they feed:
#   1. is rp2pio (built-in) plus adafruit_pioasm (lib/) usable on this build
#   2. how many PWM state machines coexist, measured first so nothing earlier has
#      already poisoned the pin pool
#   3. the lowest and highest state machine clock we can ask for
#   4. the slowest PWM the board actually produces, end to end, at the 0.1 Hz target
#   5. the SM cost of one countdown tick, which decides the duty resolution
#
# A PIO PWM period of N ticks takes N * cycles_per_tick / clock seconds, so the floor
# frequency is clock_min / (2 * 65535 + overhead), and the duty resolution at a given
# frequency is one tick in clock / frequency.
#
# Lessons baked into the shape of this probe:
#   * A StateMachine whose constructor raises still leaves its pin claimed for the rest
#     of the run, so the budget measurement goes first and every attempt takes a fresh
#     pin; asking it later would measure the leftovers, not the hardware.
#   * Ask with a frequency that was *accepted*: sm.frequency can report 2288 for a
#     request of 2289 while a request of 2288 is refused outright.
#   * Every wait is bounded and announces itself before it starts. The first version
#     polled a 65535-iteration delay for 34 s and, when it reported nothing at all,
#     gave no way to tell a slow measurement from a wedged state machine.
#   * Start the clock before the TX write, not after: measuring from after write()
#     returned hid 116 us of handshake and made short passes look like they ran fewer
#     cycles than the program counts.
#   * Read the state machine's attributes before deinit(); after deinit() even
#     sm.frequency raises.
#   * Program memory is what limits how many PIO PWMs fit: a PIO block holds 32
#     instruction words, so the 21-word delay program only placed one state machine per
#     block. The 9-word countdown below is what the backend would actually ship.
#
# The report streams out of usb_cdc.data and repeats every second: the console port's
# host->device direction can wedge, and this build mounts CIRCUITPY read-only for the
# device, so the port the firmware already speaks on is the only dependable output
# channel.
import array
import sys
import time

import board
import microcontroller
import usb_cdc

import rp2pio

import adafruit_pioasm

lines = []
started = time.monotonic()
MAX_COUNT = 65535

# The countdown shape a slow PWM would use: one TX word carries both 16-bit counters,
# X paces the high phase and Y the low phase, and each tick is one instruction, so a
# tick costs one SM clock. adafruit_pioasm encodes `set <dst>, 0..31` only, which is
# why the counters come from the FIFO instead of a set instruction.
PWM_ASM = """
.program pwmprobe
  pull block
  out x, 16
  out y, 16
  set pins, 1
high:
  jmp x-- high
  set pins, 0
low:
  jmp y-- low
  push
  jmp 0
"""
# pull + 2 out + 2 set + push + jmp = 7 instructions outside the countdowns, plus one
# cycle each for the two jumps whose condition finally fails.
CYCLES_FIXED = 9


def log(msg):
    lines.append(str(msg))


def emit(msg):
    try:
        usb_cdc.data.write(("%s %s\n" % (msg, time.monotonic() - started)).encode())
    except OSError:
        pass


def brief(e):
    return "%s: %s" % (type(e).__name__, str(e).splitlines()[0][:120])


def gp_number(name, adc_base):
    if name.startswith("GP"):
        digits = ""
        for ch in name[2:]:
            if not ch.isdigit():
                break
            digits += ch
        if digits:
            return int(digits)
    elif name.startswith("A") and name[1:].isdigit():
        # Some boards declare only the ADC alias (GP29 on a Pico 2 is board.A3).
        return adc_base + int(name[1:])
    return None


def run():
    log("probe v11 start")
    log("CP %s" % ".".join(str(x) for x in sys.implementation.version))
    words = adafruit_pioasm.assemble(PWM_ASM)
    log("pwmprobe words=%d (32 available per PIO block)" % len(words))

    adc_base = 26 if hasattr(board, "GP26_A0") else 40
    pins = {}
    for name in dir(board):
        obj = getattr(board, name)
        if not isinstance(obj, microcontroller.Pin):
            continue
        n = gp_number(name, adc_base)
        if n is not None:
            pins.setdefault(n, obj)
    numbers = sorted(pins)
    log("pins %s" % numbers)

    used = set()

    def fresh_pin():
        for n in numbers:
            if n >= 2 and n not in used:
                used.add(n)
                return n, pins[n]
        return None, None

    def make(pin, freq):
        return rp2pio.StateMachine(
            words, frequency=freq, first_set_pin=pin, wait_for_txstall=False)

    def state(sm):
        return "pc=%s off=%s tx=%s rx=%s" % (sm.pc, sm.offset, sm.txstall, sm.rxstall)

    emit("BEGIN")
    for line in lines:
        emit(line)
    lines.clear()

    # ---- 2. how many PWM state machines coexist, on distinct pins ----
    # Default exclusive_pin_use: the way the workbench would drive several channels.
    alive = []
    placed = []
    while len(alive) < 16:
        gp, pin = fresh_pin()
        if pin is None:
            emit("sm out of pins at %d" % len(alive))
            break
        try:
            sm = make(pin, 1000000)
            alive.append(sm)
            placed.append("%d@%d" % (gp, sm.offset))
        except Exception as e:
            emit("sm cap hit at %d (%s)" % (len(alive), brief(e)))
            break
    emit("sm concurrent=%d gp@offset=%s" % (len(alive), ",".join(placed)))
    for s in alive:
        s.deinit()

    # ---- 3. divider range: constructors only, so the sweep is quick ----
    accepted = []
    for req in (2000, 2288, 2289, 2300, 3000, 100000, 150000000, 150003000):
        gp, pin = fresh_pin()
        if pin is None:
            emit("freq out of pins")
            break
        try:
            sm = make(pin, req)
            emit("freq GP%d req=%d -> actual=%d off=%d" % (
                gp, req, sm.frequency, sm.offset))
            accepted.append((req, sm.frequency))
            sm.deinit()
        except Exception as e:
            emit("freq GP%d req=%d -> %s" % (gp, req, brief(e)))
    floor_req, floor_actual = min(accepted) if accepted else (0, 0)
    emit("floor req=%d actual=%d" % (floor_req, floor_actual))
    if floor_actual:
        emit("design floor=%.4g Hz = %d / (%d ticks + %d)" % (
            floor_actual / float(2 * MAX_COUNT + CYCLES_FIXED), floor_actual,
            2 * MAX_COUNT, CYCLES_FIXED))

    # ---- 4/5. one run of the PWM loop, timed ----
    def one_pass(freq, high, low, label):
        gp, pin = fresh_pin()
        if pin is None:
            emit("pass out of pins (%s)" % label)
            return None
        sm = None
        expect = CYCLES_FIXED + high + low
        try:
            sm = make(pin, freq)
            clock = sm.frequency
            # t0 covers the write too: the TX handshake is part of what we time.
            t0 = time.monotonic_ns()
            sm.write(array.array("I", [((low << 16) | high) & 0xFFFFFFFF]))
            deadline = time.monotonic() + min(4.0 * expect / clock + 2.0, 25.0)
            next_note = time.monotonic() + 2.0
            dt = None
            while time.monotonic() < deadline:
                if sm.in_waiting:
                    dt = time.monotonic_ns() - t0
                    sm.readinto(array.array("I", [0]))
                    break
                now = time.monotonic()
                if now > next_note:
                    next_note = now + 2.0
                    emit("  waiting %s" % state(sm))
            if dt is None:
                emit("pass GP%d %s TIMEOUT %s" % (gp, label, state(sm)))
                sm.deinit()
                return None
            measured = dt / 1e9 * clock
            sm.deinit()
            emit("pass GP%d %s clock=%d high=%d low=%d ms=%.3f cycles=%.1f expect=%d" % (
                gp, label, clock, high, low, dt / 1e6, measured, expect))
            emit("  -> %.6g Hz duty=%.6f%% per_tick=%.4f steps=%d" % (
                1e9 / float(dt), 100.0 * high / (high + low),
                (measured - CYCLES_FIXED) / float(high + low), high + low))
            return measured
        except Exception as e:
            emit("pass GP%d %s -> %s" % (gp, label, brief(e)))
            return None

    if floor_req:
        ticks = int(floor_actual * 10.0)  # a 10 s period, i.e. the 0.1 Hz target
        half = max(1, min(MAX_COUNT, (ticks - CYCLES_FIXED) // 2))
        one_pass(floor_req, half, half, "target0.1Hz")

    # A mid-range clock so the per-tick cost is checked with a short, cheap pass.
    one_pass(100000, 5000, 5000, "midrange")

    emit("END")
    while True:
        for line in lines:
            emit("R %s" % line)
        time.sleep(1)


try:
    run()
except BaseException as e:
    lines.append("FATAL %s" % brief(e))
    while True:
        for line in lines:
            emit("R %s" % line)
        time.sleep(1)
