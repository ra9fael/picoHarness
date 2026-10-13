# Stage 0b probe: can a PIO PWM free-run without the host feeding its TX FIFO?
#
# The chosen backend shape is X=high ticks / Y=low ticks loaded from one TX word, so the
# state machine consumes a word every period. This probe decides whether CircuitPython's
# background write keeps that FIFO full on its own, which is what turns a slow PIO PWM into
# a set-and-forget channel instead of something the event loop has to babysit.
#
# The API on this build (read off the docs, then confirmed on-board) is
#     background_write(*once=None, *, loop=None, loop2=None, swap=False)
# so a buffer passed positionally is the *once* argument and `loop` wants a buffer, not a
# boolean. Passing loop=True therefore fails with "object with buffer protocol required",
# which looks like a rejected buffer and is really a rejected flag.
#
# Deploy as code.py on the CIRCUITPY drive, then read the DATA CDC port:
#     python tools/pio_pwm_read.py COM7 120
#
# What it reports:
#   1. once= as a control: exactly one period runs, then the state machine sits txstalled
#   2. loop=: many periods with uniform push intervals while the host only timestamps
#   3. reconfigure: stop_background_write + a new loop buffer, without restart() (restart
#      clears the FIFOs and starves the machine), and how many periods the switch takes
#   4. the same swap with restart() in between, to see whether clearing the FIFO removes
#      that tail, and whether the loop write has to be re-armed after a restart
#   5. a rebuilt machine armed with the new word, which is the reconfiguration the
#      backend will use if restart() cannot shorten the tail
#   6. which half of the packed TX word drives the pin HIGH, because every earlier
#      test word was symmetric enough that the packing order was not observable
#
# Honest limits: phases 1-5 time the *period* through the single push at the end of each
# pass, so their duty figures are by construction only; phase 6 is the one place the high
# and low halves are measured on the pin, by timing the two pushes that end them.
#
# Reuses the Stage 0 shape and its lessons: bounded waits that announce themselves, a fresh
# pin per attempt because a failed constructor keeps its pin claimed for the rest of the
# run, results streamed over usb_cdc.data (CIRCUITPY is read-only for the device and the
# console port's host->device direction can wedge), and a per-line tag so the host reader
# can tell re-runs apart.
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
CYCLES_FIXED = 9
CLOCK = 100000

# Same countdown, but each phase announces its own end, so the host can time the two
# halves of the waveform separately.
PWM_MARK_ASM = """
.program pwmmark
  pull block
  out x, 16
  out y, 16
  set pins, 1
high:
  jmp x-- high
  push
  set pins, 0
low:
  jmp y-- low
  push
  jmp 0
"""


def log(msg):
    lines.append(str(msg))


def emit(msg):
    try:
        usb_cdc.data.write(("%s %s\n" % (msg, time.monotonic() - started)).encode())
    except OSError:
        pass


def brief(e):
    return "%s: %s" % (type(e).__name__, str(e).splitlines()[0][:160])


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
        return adc_base + int(name[1:])
    return None


def word(high, low):
    return array.array("I", [((low << 16) | high) & 0xFFFFFFFF])


def run():
    log("probe v16c start")
    log("CP %s" % ".".join(str(x) for x in sys.implementation.version))
    words = adafruit_pioasm.assemble(PWM_ASM)
    log("pwmprobe words=%d" % len(words))

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

    used = set()

    def fresh_pin():
        for n in numbers:
            if n >= 2 and n not in used:
                used.add(n)
                return n, pins[n]
        return None, None

    def make(pin, freq=CLOCK):
        return rp2pio.StateMachine(
            words, frequency=freq, first_set_pin=pin, wait_for_txstall=False)

    def expect_ms(high, low):
        return (CYCLES_FIXED + high + low) * 1000.0 / CLOCK

    def drain_intervals(sm, count, cap_s, label, want_ms):
        """Time up to count RX words; report the spread against the expected period."""
        gaps = []
        prev = time.monotonic_ns()
        deadline = time.monotonic() + cap_s
        while len(gaps) < count and time.monotonic() < deadline:
            if sm.in_waiting:
                now = time.monotonic_ns()
                gaps.append((now - prev) / 1e6)
                prev = now
                sm.readinto(array.array("I", [0]))
        near = [g for g in gaps[1:] if abs(g - want_ms) <= want_ms * 0.05]
        emit("%s got=%d/%d min=%.3f max=%.3f within5%%=%d/%d want=%.3f ms tx=%s pend=%d" % (
            label, len(gaps), count,
            min(gaps) if gaps else -1, max(gaps) if gaps else -1,
            len(near), max(1, len(gaps) - 1), want_ms, sm.txstall,
            sm.pending_write))
        return gaps

    emit("BEGIN")
    for line in lines:
        emit(line)
    lines.clear()

    # ---- 1. control: a positional buffer is once=, so one period and no more ----
    sm = None
    gp, pin = fresh_pin()
    want = expect_ms(200, 200)
    try:
        sm = make(pin)
        sm.clear_rxfifo()
        sm.background_write(word(200, 200))
        emit("once GP%d started, want %.3f ms" % (gp, want))
        drain_intervals(sm, 6, 1.0, "once", want)
        sm.deinit()
    except Exception as e:
        emit("once -> %s" % brief(e))
        if sm:
            try:
                sm.deinit()
            except Exception:
                pass

    # ---- 2. loop= : does one 4-byte buffer keep the machine running by itself? ----
    # 40 periods of 4.09 ms is 164 ms; the host only timestamps the pushes, it never
    # touches the TX FIFO, so a refill happening at all is proof the loop argument works.
    sm2 = None
    gp2, pin2 = fresh_pin()
    try:
        sm2 = make(pin2)
        sm2.clear_rxfifo()
        sm2.background_write(loop=word(200, 200))
        emit("loop GP%d started, want %.3f ms" % (gp2, want))
        drain_intervals(sm2, 40, 2.0, "loop", want)
        # Long enough that a one-shot refill would have starved by now.
        time.sleep(0.5)
        sm2.clear_rxfifo()
        drain_intervals(sm2, 40, 2.0, "loop-still", want)

        # ---- 3. reconfigure in place: swap the loop buffer, no restart() ----
        want_b = expect_ms(600, 200)
        sm2.stop_background_write()
        sm2.background_write(loop=word(600, 200))
        emit("reconf GP%d swapped to want %.3f ms" % (gp2, want_b))
        gaps = drain_intervals(sm2, 20, 2.0, "reconf", want_b)
        switched = 0
        for i, g in enumerate(gaps):
            if abs(g - want_b) <= want_b * 0.05:
                switched = i
                break
        emit("reconf first-new-period after %d gaps (FIFO+buffer tail)" % switched)
        sm2.deinit()
    except Exception as e:
        emit("loop -> %s" % brief(e))
        if sm2:
            try:
                sm2.deinit()
            except Exception:
                pass

    # ---- 4. reconfigure with the FIFOs cleared: does restart() kill the tail? ----
    # Phase 3 showed a new word only taking effect after ~5 periods, which is the 4-deep
    # TX FIFO plus the period already running. Clearing the FIFO between stop and re-arm
    # should collapse that to the next period, but restart() also resets the machine, so
    # whether the loop write survives it (or has to be re-armed after) is a board fact.
    sm3 = None
    gp3, pin3 = fresh_pin()
    want_b = expect_ms(600, 200)
    try:
        sm3 = make(pin3)
        sm3.clear_rxfifo()
        sm3.background_write(loop=word(200, 200))
        emit("restart-order GP%d armed, want %.3f ms first" % (gp3, want))
        drain_intervals(sm3, 10, 2.0, "restart-order base", want)
        sm3.stop_background_write()
        sm3.restart()
        try:
            sm3.background_write(loop=word(600, 200))
            emit("restart-order re-armed after restart")
        except Exception as e:
            emit("restart-order re-arm after restart -> %s" % brief(e))
        gaps = drain_intervals(sm3, 10, 2.0, "restart-order new", want_b)
        switched = 0
        for i, g in enumerate(gaps):
            if abs(g - want_b) <= want_b * 0.05:
                switched = i
                break
        emit("restart-order first-new-period after %d gaps (phase 3 needed 5)" % switched)
        sm3.deinit()
    except Exception as e:
        emit("restart-order -> %s" % brief(e))
        if sm3:
            try:
                sm3.deinit()
            except Exception:
                pass

    # ---- 5. the reconfiguration Stage 1 would actually use: rebuild the machine ----
    # Phase 4 says a running machine cannot be re-timed sooner than its 4-deep TX FIFO
    # drains, so the switch is a new StateMachine armed with the new word before it is
    # allowed to run. Its very first period must already be the new length.
    sm4 = None
    gp4, pin4 = fresh_pin()
    try:
        sm4 = make(pin4)
        sm4.clear_rxfifo()
        sm4.background_write(loop=word(600, 200))
        # gaps[0] carries the start-in-flight latency, so judge the batch from gaps[1:].
        drain_intervals(sm4, 10, 2.0, "rebuild want=%.3f" % want_b, want_b)
        sm4.deinit()
    except Exception as e:
        emit("rebuild -> %s" % brief(e))
        if sm4:
            try:
                sm4.deinit()
            except Exception:
                pass

    # ---- 6. which half of the TX word lands on the HIGH phase? ----
    # Every Stage 0 number came from a symmetric or near-symmetric word, so the packing
    # order was never observable, and a wrong guess silently inverts duty. Marking the
    # end of each phase with a push turns the two host-side intervals into the high and
    # low durations themselves, so this is also the first actual on-pin duty
    # measurement rather than a by-construction one.
    mark_words = adafruit_pioasm.assemble(PWM_MARK_ASM)
    emit("mark words=%d" % len(mark_words))
    gp6, pin6 = fresh_pin()
    sm6 = None
    # Each counter field is 16 bits, so the asymmetric pair has to fit there: 60000 ticks
    # of SM clock is a 0.6 s high phase and 100 is a 1 ms low phase, which the host can
    # tell apart at a glance.
    hi_ticks, lo_ticks = 60000, 100
    want_hi = hi_ticks * 1000.0 / CLOCK
    want_lo = lo_ticks * 1000.0 / CLOCK
    try:
        sm6 = rp2pio.StateMachine(
            mark_words, frequency=CLOCK, first_set_pin=pin6, wait_for_txstall=False)
        sm6.clear_rxfifo()
        sm6.background_write(loop=array.array("I", [(hi_ticks << 16) | lo_ticks]))
        prev = time.monotonic_ns()
        seq = []
        deadline = time.monotonic() + 20.0
        while len(seq) < 6 and time.monotonic() < deadline:
            if sm6.in_waiting:
                now = time.monotonic_ns()
                seq.append((now - prev) / 1e6)
                prev = now
                sm6.readinto(array.array("I", [0]))
        emit("halforder GP%d upper=%d lower=%d want %.3f/%.3f ms gaps=%s" % (
            gp6, hi_ticks, lo_ticks, want_hi, want_lo,
            " ".join("%.3f" % g for g in seq)))
        # The first push ends the HIGH phase, so gaps[0] says which 16-bit half `out x,16`
        # fed: the low half, measured. The packing the other phases use is therefore right.
        emit("halforder verdict: high phase = %.3f ms, high-phase count = %s 16 bits" % (
            seq[0] if seq else -1,
            "LOWER (out x,16 reads the LSB half; pack (low<<16)|high)"
            if len(seq) > 1 and seq[0] < seq[1]
            else "UPPER (pack (high<<16)|low)"))
        sm6.deinit()
    except Exception as e:
        emit("halforder -> %s" % brief(e))
        if sm6:
            try:
                sm6.deinit()
            except Exception:
                pass

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
