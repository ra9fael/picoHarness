# PicoHarness firmware — IO workbench stage
# JSON-lines command loop over USB CDC. With the shipped boot.py the protocol
# runs on the second CDC port (usb_cdc.data) and the CircuitPython console keeps
# print()/REPL to itself; without it everything falls back to the console, i.e.
# the pre-0.1.12 single-port behaviour.
# Architecture: a command dispatch table routes to per-function drivers
# (gpio / pwm / ...). Every driver must claim(n, who) a pin before touching
# it and release(n) when done — the owner table is the single arbiter of pin
# ownership, so functions can never fight over a pin implicitly. The PWM lane has two
# generators behind the same command: the rp2 hardware slice, and a PIO countdown whose
# floor is the SM clock over the longest legal period (0.0175 Hz measured; see
# caps["pwm_pio"]); the host picks one per channel and the device reports which one is
# running.
# Main loop is an asyncio task group: command_reader + gpio_monitor, which
# pushes {"evt":"gpio_in","in":mask} on input level *edges* but only while the
# host is subscribed to topic "gpio.in" (see SUBS / cmd_sub — MQTT-style, with
# a retained snapshot on subscribe), + adc_monitor, which pushes
# {"evt":"adc","vals":{pin:raw}} when any configured channel moves more than
# its (per-subscription overridable) deadband vs the last sent value, + adc_streamer, which (while
# adc.stream is on, and keeping adc_monitor quiet) ships batched waveform
# frames {"evt":"adc_w","pins":[...],"ms":dt,"v":[[...],...]} — or, with
# adc.stream fmt="bin", the same batch as a compact 0xAA'W'-framed struct
# payload written atomically to the protocol port (see send_bin). The on-die
# temperature sensor participates as virtual ADC channel 100 (TEMP_PIN) — same
# claim/monitor/stream path as a GP channel, host-side converted to °C.
# Real-hardware lessons, in the order they bit us:
# 1. sys.stdin.read(1) BLOCKS until at least one byte arrives — it is NOT the
#    non-blocking idiom. A bare read(1) poll in command_reader froze the whole
#    loop and starved both monitors (binary-searched A-F on live hardware).
#    Gate every read with select.poll() on stdin (POLLIN, timeout 0).
# 2. read(n>1) blocks until n chars arrive, so replies only flush when the
#    NEXT request shows up (earlier log showed 3s command timeouts).
# 3. This port's gather() accepts Task objects only — passing bare coroutines
#    trips sleep_ms's "missing await" assertion. Follow the official asyncio
#    guide: create_task each coroutine, then await gather(task1, task2, ...).
#    (An earlier "gather awaits children in order" diagnosis was WRONG; the
#    mpy port is a plain queue-rotation scheduler and create_task concurrency
#    works.)
# 4. print(..., flush=True) raises OSError Errno 22 on USB CDC after the text
#    is already written — never flush explicitly.
# 5. usb_cdc.Serial (the data port) is a BINARY stream: read() -> bytes,
#    write(bytes) -> int, and read() waits unless timeout == 0. That is not the
#    text object sys.stdin is, so the data-port path buffers bytes and decodes
#    one line at a time.
import sys
import select
import time
import json
import struct
import array
import asyncio

import board
import digitalio
import analogio
import microcontroller
import busio
from pwmio import PWMOut

try:
    import rp2pio  # frozen into the rp2 builds: the PIO core needs no library to copy
    import adafruit_pioasm  # the ONE third-party file this needs: lib/adafruit_pioasm.mpy
except ImportError:
    rp2pio = None
    adafruit_pioasm = None

try:
    import usb_cdc
except ImportError:  # no USB CDC console on this build — binary frames off
    usb_cdc = None

# The port the protocol talks on. Set once at import: boot.py decides it, so it
# never changes while code.py runs. None => no boot.py on the volume (or a build
# without the second CDC interface) => fall back to the console.
DATA = getattr(usb_cdc, "data", None) if usb_cdc is not None else None
if DATA is not None:
    DATA.timeout = 0  # read() returns immediately instead of waiting for bytes

APP = "PicoHarness"
VERSION = "0.1.18-pio"
# Which GPIOs this harness may touch is decided by two things stacked on top of
# each other: the CHIP PACKAGE and, narrower still, the BOARD DEFINITION.
#  * pico-sdk src/rp2350/hardware_regs/include/hardware/platform_defs.h sets
#    NUM_BANK0_GPIOS to 30 for the RP2350A QFN-60 (GP0..GP29) and 48 for the
#    RP2350B QFN-80 (GP0..GP47), and the same file puts the ADC at
#    ADC_BASE_PIN=26/NUM_ADC_CHANNELS=5 on RP2350A (ADC0..ADC3 = GP26..GP29) and
#    ADC_BASE_PIN=40/9 on RP2350B (ADC0..ADC8 = GP40..GP47 plus temperature,
#    VREF+ and VBAT).
#  * CircuitPython can only hand out a pin the board's pins.c DECLARES, and a Pin
#    object exposes no number -- only its identity -- so the number has to be read
#    off the attribute names. The official tables are narrower than the package
#    and they skip numbers: raspberry_pi_pico2_w names GP0..GP22 and GP26..GP28
#    but NOT GP23/GP24/GP25 (on that board those are the CYW43 SMPS_MODE / LED /
#    VBUS_SENSE pins), and neither board names GP30..GP47 at all.
#    GP29 on the Pico 2 is the instructive case. It exists and every function
#    works on it -- measured on the board: ADC3 reads VSYS/3, PWMOut builds and
#    reports its divided frequency, DigitalInOut drives it, busio.I2C(SCL=GP29,
#    SDA=GP28) is accepted, UART(TX=GP28, RX=GP29) builds -- but pins.c declares
#    it as board.A3 / VOLTAGE_MONITOR, with no "GP" token in the name. So a pin
#    whose only names are ADC aliases is numbered ADC_BASE + channel, ADC_BASE
#    being the pin behind A0; every rp2 board does spell A0 with a GP token
#    (board.GP26_A0 here, GP40_A0 on a QFN-80 part), which keeps the rule data
#    driven instead of hardcoded per board.
# So the addressable set is read off `board` at import, and it may legitimately
# have HOLES -- which is why this is a sparse map of number -> attribute name
# rather than a count, and why _pin() refuses a number that has no name instead
# of raising AttributeError. Everything downstream (owner[], the sweeps,
# caps.pins) sizes itself from the highest addressable number.
def _pin_names():
    objs = {}  # id(pin object) -> the attribute names that reach it
    for attr in dir(board):
        obj = getattr(board, attr)
        if type(obj).__name__ != "Pin":
            continue
        objs.setdefault(id(obj), []).append(attr)
    numbers = {}
    aliases = []
    adc_base = None
    for attrs in objs.values():
        gp = [a for a in attrs if a.startswith("GP") and a[2:].isdigit()]
        if gp:
            numbers[int(gp[0][2:])] = gp[0]
            if "A0" in attrs:
                adc_base = int(gp[0][2:])
        else:
            aliases.append(attrs)
    for attrs in aliases:
        a = [x for x in attrs if x.startswith("A") and x[1:].isdigit()]
        if a and adc_base is not None:
            numbers[adc_base + int(a[0][1:])] = a[0]
    return numbers


GP_NAMES = _pin_names()
GPS = sorted(GP_NAMES)
NUM_PINS = GPS[-1] + 1 if GPS else 0

# Virtual ADC channel id for the on-die temperature sensor. It is not a GP pin,
# so it lives outside the owner[] arbiter (tracked by the temp_on flag) and is
# addressed on the wire as pin 100. This build (rp2350 Pico 2, CP 10.3.1) does
# NOT expose board.TEMPERATURE_SENSOR, but microcontroller.cpu.temperature
# reports °C directly; _temp_raw16() inverts the datasheet curve to emit the
# 16-bit ADC code the sensor would have produced, so the temperature channel
# rides the exact same raw u16 pipeline as a GP channel. The host recovers °C
# via its per-channel k·x+b calibration (forward: V = raw16 * 3.3 / 65535,
# °C = 27 - (V - 0.706) / 0.001721).
TEMP_PIN = 100

MODE_UNUSED, MODE_IN, MODE_OUT = 0, 1, 2


def send(obj):
    # compact separators: no spaces after , and : — ~15% smaller on the wire
    line = json.dumps(obj, separators=(",", ":"))
    if DATA is None:
        print(line)
    else:
        DATA.write((line + "\n").encode())


# —— binary waveform frames (optional adc.stream fmt="bin") ——
# Frame = 0xAA 'W' + u16le(payload_len) + payload. payload for the ADC
# waveform kind (1) = struct "<BBHH"(kind, nch, ms, nrows) + u16le[nch] pins
# + u16le[nrows*nch] samples (row-major, one row per sample instant).
# The 0xAA magic never occurs in our ASCII text stream, so the host can
# byte-scan for it and keep both formats interleaved on one port.
# write() is atomic per call, so a frame never interleaves with a JSON line.
BIN_MAGIC = b"\xaaW"


def send_bin(payload):
    frame = BIN_MAGIC + struct.pack("<H", len(payload)) + payload
    if DATA is not None:
        DATA.write(frame)
        return
    if usb_cdc is None or usb_cdc.console is None:
        raise RuntimeError("no CDC port available for bin frames")
    usb_cdc.console.write(frame)


def parse_req(line):
    # A stray control byte can glue onto a request line; recover by parsing
    # the outermost {...} substring before giving up.
    try:
        return json.loads(line)
    except ValueError:
        s = line.find("{")
        e = line.rfind("}")
        if 0 <= s < e:
            return json.loads(line[s : e + 1])
        raise


def _pin(n):
    # A GPIO the board definition never named is unreachable, not illegal: raise
    # the same ValueError the CP constructors raise for an unusable pin, so the
    # capability sweeps and the command handlers both treat a hole the way they
    # already treat "this pin cannot do that".
    name = GP_NAMES.get(n)
    if name is None:
        raise ValueError("board has no GP%d" % n)
    return getattr(board, name)


# —— pin ownership arbiter ——
owner = [None] * NUM_PINS  # None | "gpio" | "pwm" | ...


def claim(n, who, force=False):
    o = owner[n]
    if o == who:
        return True
    if o is not None:
        if not force:
            return False
        release(n)
    owner[n] = who
    return True


def release(n):
    o = owner[n]
    if o == "gpio":
        gpio_release(n)
    elif o == "pwm":
        pwm_release(n)
    elif o == "adc":
        adc_release(n)
    elif o == "i2c":
        i2c_release(n)
    elif o == "uart":
        uart_release(n)
    elif o == "spi":
        spi_release(n)
    owner[n] = None


# —— digital GPIO driver ——
pin_obj = [None] * NUM_PINS
pin_mode = [MODE_UNUSED] * NUM_PINS
pin_pull = [0] * NUM_PINS  # valid for inputs: 0 = up, 1 = down, 2 = none
out_bits = 0
in_idx = ()
out_idx = ()


def _reindex():
    global in_idx, out_idx
    in_idx = tuple(n for n in range(NUM_PINS) if pin_mode[n] == MODE_IN)
    out_idx = tuple(n for n in range(NUM_PINS) if pin_mode[n] == MODE_OUT)


def _mask_of(idxs):
    m = 0
    for n in idxs:
        m |= 1 << n
    return m


def gpio_release(n):
    global out_bits
    if pin_obj[n]:
        pin_obj[n].deinit()
        pin_obj[n] = None
    if pin_mode[n] != MODE_UNUSED:
        pin_mode[n] = MODE_UNUSED
        pin_pull[n] = 0
        out_bits &= ~(1 << n)
        _reindex()


def apply_cfg(in_mask, out_mask, pd_mask=0, pn_mask=0):
    # Incremental: only pins whose direction (or input pull) changed are
    # reconfigured, so untouched outputs never glitch. Output wins over input.
    # Pull: DOWN if pd bit, NONE if pn bit, else UP.
    global out_bits
    for n in range(NUM_PINS):
        if n not in GP_NAMES:
            continue  # not on this module's board table at all
        if owner[n] in ("pwm", "adc", "i2c", "spi"):
            continue  # other drivers own this pin; host must stop them first
        want = MODE_OUT if (out_mask >> n) & 1 else (MODE_IN if (in_mask >> n) & 1 else MODE_UNUSED)
        if want == MODE_UNUSED:
            if owner[n] == "gpio":
                release(n)
            continue
        claim(n, "gpio")
        pull = 1 if (pd_mask >> n) & 1 else (2 if (pn_mask >> n) & 1 else 0)
        if want == pin_mode[n] and (want != MODE_IN or pull == pin_pull[n]):
            continue
        if pin_obj[n]:
            pin_obj[n].deinit()
            pin_obj[n] = None
        pin_mode[n] = want
        pin_pull[n] = pull if want == MODE_IN else 0
        if want == MODE_IN:
            d = digitalio.DigitalInOut(_pin(n))
            if pull == 1:
                d.switch_to_input(pull=digitalio.Pull.DOWN)
            elif pull == 2:
                d.switch_to_input()
            else:
                d.switch_to_input(pull=digitalio.Pull.UP)
        else:
            d = digitalio.DigitalInOut(_pin(n))
            d.switch_to_output(value=bool((out_bits >> n) & 1))
        pin_obj[n] = d
    _reindex()
    kept = 0
    for n in out_idx:
        pin_obj[n].value = bool((out_bits >> n) & 1)
        if (out_bits >> n) & 1:
            kept |= 1 << n
    out_bits = kept


def set_out(mask, vals):
    global out_bits
    out_bits = (out_bits & ~mask) | (vals & mask)
    for n in out_idx:
        if (mask >> n) & 1:
            pin_obj[n].value = bool((out_bits >> n) & 1)


# —— PWM: the PIO backend ——
# PWMOut cannot go slow: its divider works in whole hertz, and measured on this build
# every request from 1..8 Hz lands on 9 Hz. A PIO countdown can: one TX word carries the
# high and low tick counts of a whole period, so the floor is the SM clock floor divided
# by the longest legal period -- 2288 / (2*65535 + 8) = 0.0175 Hz, 5.7x below the 0.1 Hz
# this lane was asked to reach (measured end to end at 0.100053 Hz).
#
# Every figure below was measured on the board with tools/pio_pwm_probe.py and
# tools/pio_bg_probe.py, and they ship in one place on purpose: caps["pwm_pio"] is what
# the UI reads to decide the floor, the step count and whether the button exists at all,
# so no second copy of these numbers exists anywhere.
#
# The program is 8 words and each period re-arms the counters from the FIFO, so the whole
# PIO budget belongs to this lane (I2C / UART / SPI are all hardware peripherals here) and
# the 12 state machines RP2350 offers (3 blocks x 4) are 12 PWM channels. It differs from
# the 9-word program the probes measured in one place: the probe ended each pass with a
# push so the host could timestamp the period, and the shipped version has no push, because
# a machine that nobody drains would stall on a full RX FIFO within eight periods.
PIO_ASM = """
.program pwmpio
  pull block
  out x, 16
  out y, 16
  set pins, 1
high:
  jmp x-- high
  set pins, 0
low:
  jmp y-- low
  jmp 0
"""
# Words outside the two loops, all executed once per period (including the two countdown
# jumps that finally fail). Measured: `jmp x--` costs exactly 1 SM cycle, so a period is
# high + low + PIO_FIXED_CYCLES cycles and one tick is one SM cycle.
PIO_FIXED_CYCLES = 8
# Each counter is one 16-bit half of the TX word. Which half lands where was measured, not
# assumed: `out x,16` reads the LOW half, and x drives the high phase, hence the packing in
# _pio_word(). A symmetric test word cannot see this, so getting it wrong is a silent duty
# inversion. One consequence of the shape: an empty phase still spends a cycle, so PIO duty
# spans one tick to period-minus-one-tick rather than a true 0 % and 100 %.
PIO_MAX_COUNT = 65535
PIO_MAX_SM = 12
# SM clock window this build accepts; requests outside it raise ValueError. The divider is
# much wider than rp2040's 8.4 bits (measured divisor ~65560 at the floor), so the usual
# "586 kHz floor" reasoning does not apply.
PIO_CLK_MIN = 2288
PIO_CLK_MAX = 150000000

# Assembled once at import: adafruit_pioasm runs on the device, so there is no host build
# step and no generated-bytes artifact to keep in the repo.
PIO_WORDS = None
if rp2pio is not None and adafruit_pioasm is not None:
    try:
        PIO_WORDS = adafruit_pioasm.assemble(PIO_ASM)
    except Exception:
        PIO_WORDS = None

pio_sm_used = 0


def _pio_word(high, low):
    return array.array("I", [((low << 16) | high) & 0xFFFFFFFF])


def _pio_solve(freq, duty):
    # A period is high + low + PIO_FIXED_CYCLES SM cycles, so the longest waveform the two
    # counters can describe is 2*65535+8 ticks. Take the longest period whose clock still
    # fits under the ceiling: a 1 kHz channel then keeps all 131070 duty steps and only the
    # MHz end has to give resolution away.
    counts = min(2 * PIO_MAX_COUNT, int(PIO_CLK_MAX // freq) - PIO_FIXED_CYCLES)
    if counts < 2:
        raise ValueError(
            "freq above PIO ceiling %d Hz" % (PIO_CLK_MAX // (PIO_FIXED_CYCLES + 2)))
    # The LONGER half has to fit in 16 bits, so an extreme duty shortens the period instead
    # of clipping the waveform -- clipping would silently move the frequency as well.
    counts = min(counts, int(PIO_MAX_COUNT / max(duty, 1.0 - duty)))
    high = min(PIO_MAX_COUNT, int(round(counts * duty)))
    low = counts - high
    # Truncated, not rounded: counts already came out of the ceiling, so rounding up can
    # ask for a clock just over 150 MHz, which the constructor rejects.
    clock = int(freq * (counts + PIO_FIXED_CYCLES))
    if clock < PIO_CLK_MIN:
        raise ValueError("clock %d Hz below PIO floor %d Hz: %.6g Hz at duty %.4g is out "
                         "of PIO range" % (clock, PIO_CLK_MIN, freq, duty))
    return clock, high, low, counts + PIO_FIXED_CYCLES


def _pio_start(n, freq, duty):
    """Arm a fresh state machine on this pin. Rebuilding is not a stylistic choice: a
    running machine keeps honouring the 4-deep TX FIFO, so new counts measured 5 periods
    later (4 even after restart()). A rebuilt machine armed before it runs is on the new
    period from its very first cycle."""
    global pio_sm_used
    if PIO_WORDS is None:
        raise RuntimeError("PIO PWM unavailable: copy lib/adafruit_pioasm.mpy")
    if pio_sm_used >= PIO_MAX_SM:
        raise RuntimeError(
            "no free PIO state machine (%d/%d in use)" % (pio_sm_used, PIO_MAX_SM))
    clock, high, low, cycles = _pio_solve(freq, duty)
    try:
        sm = rp2pio.StateMachine(
            PIO_WORDS, frequency=clock, first_set_pin=_pin(n), wait_for_txstall=False)
    except ValueError as e:
        # A constructor that raises still leaves its pin claimed by the PIO block until the
        # board resets, so say so: the UI must show which GP is now unusable rather than
        # let the next attempt on it look like a new, unrelated failure.
        raise RuntimeError("GP%d PIO start refused: %s" % (n, e))
    pio_sm_used += 1
    try:
        sm.background_write(loop=_pio_word(high, low))
    except Exception:
        sm.deinit()
        pio_sm_used -= 1
        raise
    return sm, cycles


def pio_caps():
    # None rather than an empty dict when the library is missing: the UI then hides the
    # backend control instead of offering a mode the firmware cannot honour.
    if PIO_WORDS is None:
        return None
    return {
        # PIO matrices exist on every RP2350 GPIO, so this is the addressable set itself;
        # GP2..GP29 were each confirmed to accept first_set_pin on the board, GP0/GP1 by
        # the datasheet and the Stage 5 check.
        "pins": GPS,
        "max_sm": PIO_MAX_SM,
        "tick_cycles": 1,
        "fixed_cycles": PIO_FIXED_CYCLES,
        "counters": PIO_MAX_COUNT,
        "clk_min": PIO_CLK_MIN,
        "clk_max": PIO_CLK_MAX,
    }


# —— PWM driver ——
pwm_obj = [None] * NUM_PINS
pwm_sm = [None] * NUM_PINS  # set instead of pwm_obj[n] while the channel runs on PIO
pwm_par = [None] * NUM_PINS  # (requested freq, actual freq, duty 0..1, backend)


def pwm_release(n):
    # Both backends are torn down on every path that loses the pin, or the orphaned state
    # machine keeps toggling a GPIO the new owner thinks it controls -- and burns one of
    # the 12 for the rest of the session.
    global pio_sm_used
    if pwm_sm[n]:
        pwm_sm[n].deinit()
        pwm_sm[n] = None
        pio_sm_used -= 1
    if pwm_obj[n]:
        pwm_obj[n].deinit()
        pwm_obj[n] = None
    pwm_par[n] = None


def pwm_start(pin, freq, duty, backend="hw"):
    n = int(pin)
    if not 0 <= n < NUM_PINS:
        raise ValueError("pin out of range")
    if backend not in ("hw", "pio"):
        raise ValueError("unknown pwm backend %r" % backend)
    if not claim(n, "pwm", force=True):  # steals plain-GPIO pins on purpose
        raise RuntimeError("pin busy")
    duty = max(0.0, min(1.0, float(duty)))
    freq = float(freq)
    # Two generators cannot share one pad, and a PIO channel is rebuilt even for a
    # duty-only change: a running machine keeps honouring its 4-deep TX FIFO, so new counts
    # measured five periods late. owner[] keeps saying "pwm" straight through both.
    if backend == "pio" or (pwm_par[n] and pwm_par[n][3] != backend):
        pwm_release(n)
    if backend == "pio":
        # An SM whose constructor raised leaves its pin claimed by the PIO block until the
        # board resets, so drop the harness claim too and let the message name the GP.
        try:
            sm, total = _pio_start(n, freq, duty)
        except Exception:
            release(n)
            raise
        pwm_sm[n] = sm
        # sm.frequency is the clock the divider actually produced, so the reported figure
        # is what the pin does, not what was asked for.
        pwm_par[n] = (freq, sm.frequency / float(total), duty, "pio")
        return
    if freq < 1:
        raise ValueError("freq < 1 Hz: PWMOut takes whole hertz")
    freq = int(freq)
    dc = int(duty * 65535)
    if pwm_obj[n] and pwm_par[n] and pwm_par[n][0] == freq:
        pwm_obj[n].duty_cycle = dc
    else:
        # rp2 fixed-frequency PWMOut refuses .frequency writes ("Invalid
        # variable_frequency", real-hardware log), so change of freq means
        # tearing the object down and rebuilding it.
        if pwm_obj[n]:
            pwm_obj[n].deinit()
            pwm_obj[n] = None
        try:
            obj = PWMOut(_pin(n), frequency=freq, duty_cycle=dc)
        except Exception:
            # GP24/GP25 (and every other slice pair) raise "Conflicting settings
            # for shared resource" when the partner already runs another
            # frequency. Drop the claim on the way out: an owner of "pwm" with
            # no object behind it makes read_state crash and blinds the UI.
            release(n)
            raise
        pwm_obj[n] = obj
    # The getter answers with the frequency the slice really runs at, and the
    # rp2 divider cannot follow every request: 1..8 Hz all land on 9 Hz and
    # 1000 Hz lands on 990 (CircuitPython 10.3.1, measured on GP25/GP2/GP12/GP0).
    pwm_par[n] = (freq, int(pwm_obj[n].frequency), duty, "hw")


def pwm_stop(pin):
    n = int(pin)
    if owner[n] == "pwm":
        release(n)


# —— ADC driver ——
adc_obj = [None] * NUM_PINS
temp_on = False  # True while the virtual temperature channel (TEMP_PIN) is claimed


def _temp_raw16():
    # board.TEMPERATURE_SENSOR is not exposed on this build (rp2350 Pico 2,
    # CircuitPython 10.3.1), but microcontroller.cpu.temperature reports °C
    # directly. Invert the datasheet curve to synthesize the 16-bit ADC code the
    # internal sensor would have produced, so the temperature channel rides the
    # exact same raw u16 pipeline as a GP channel; the host recovers °C with its
    # per-channel k·x+b calibration. Forward: V = raw*3.3/65535,
    # °C = 27 - (V - 0.706)/0.001721. Inverse below (0.03 °C/LSB, plenty).
    t = microcontroller.cpu.temperature
    v = 0.706 - (t - 27.0) * 0.001721
    return max(0, min(65535, int(v / 3.3 * 65535.0 + 0.5)))


def _adc_configured(n):
    return temp_on if n == TEMP_PIN else (adc_obj[n] is not None)


def _adc_val(n):
    return _temp_raw16() if n == TEMP_PIN else adc_obj[n].value


def adc_release(n):
    global temp_on
    if n == TEMP_PIN:
        temp_on = False
        return
    if adc_obj[n]:
        adc_obj[n].deinit()
        adc_obj[n] = None


def adc_start(pin):
    global temp_on
    n = int(pin)
    if n == TEMP_PIN:
        _ = microcontroller.cpu.temperature  # probe: raises if unsupported
        temp_on = True
        return
    if not 0 <= n < NUM_PINS:
        raise ValueError("pin out of range")
    if not claim(n, "adc", force=True):  # steals gpio pins, like pwm does
        raise RuntimeError("pin busy")
    if not adc_obj[n]:
        adc_obj[n] = analogio.AnalogIn(_pin(n))


def adc_stop(pin):
    n = int(pin)
    if n == TEMP_PIN:
        adc_release(TEMP_PIN)
    elif owner[n] == "adc":
        release(n)


# —— I2C bus driver ——
# Unlike gpio/pwm/adc (one owner per pin), an I2C bus owns a PAIR of pins, so it
# lives in its own table keyed by a host-assigned bus id and registers both
# members in owner[] under "i2c". Releasing either pin tears the whole bus down.
# The rp2 hardware I2C (Synopsys DW_apb_i2c, NUM_I2CS = 2, NOT PIO) only accepts
# certain pin pairs (real-hardware: GP8/GP10 was rejected with "Invalid pins"), so
# probe_caps().i2c lists the pins that can be in at least one valid bus; the host
# greys the rest. Final legality is still decided when the object is constructed
# and reported back.
i2c_bus = {}  # id -> {"obj": I2C, "sda": n, "scl": m, "freq": hz}


def _i2c_bus_on(n):
    for bid, b in i2c_bus.items():
        if b["sda"] == n or b["scl"] == n:
            return bid
    return None


def i2c_release(n):
    bid = _i2c_bus_on(n)
    if bid is None:
        return
    b = i2c_bus.pop(bid)
    # drop the sibling pin's ownership too (this call only carried one of them)
    for p in (b["sda"], b["scl"]):
        if owner[p] == "i2c":
            owner[p] = None
    try:
        b["obj"].deinit()
    except Exception:
        pass


def i2c_cfg(args):
    bid = int(args.get("id", 0))
    sda = int(args.get("sda"))
    scl = int(args.get("scl"))
    freq = int(args.get("freq", 100000))
    if sda == scl:
        raise ValueError("SDA and SCL must be different pins")
    for n in (sda, scl):
        if not 0 <= n < NUM_PINS:
            raise ValueError("pin out of range")
    prev = i2c_bus.get(bid)
    if prev is not None and prev["sda"] == sda and prev["scl"] == scl and prev["freq"] == freq:
        return {"ok": True, "data": read_state()}  # already live with these params
    if prev is not None:  # changing pins or speed: tear down before rebuilding
        i2c_bus.pop(bid)
        for p in (prev["sda"], prev["scl"]):
            if owner[p] == "i2c":
                owner[p] = None
        try:
            prev["obj"].deinit()
        except Exception:
            pass
    for n in (sda, scl):
        if not claim(n, "i2c", force=True):  # steals gpio/pwm/adc pins, like pwm does
            raise RuntimeError("pin GP%d busy" % n)
    try:
        obj = busio.I2C(_pin(scl), _pin(sda), frequency=freq)
    except ValueError as e:
        for n in (sda, scl):
            if owner[n] == "i2c":
                owner[n] = None
        # "Invalid pins" is the rp2 hardware-I2C mux refusing the ordered pair:
        # SCL must be odd, SDA even, and sda ≡ scl-1 (mod 4). Name the rule so the
        # host can guide the user instead of showing a bare ValueError.
        raise ValueError(
            "I2C pin pair GP%d(SCL)/GP%d(SDA) not routable to one hardware I2C "
            "(need SCL odd, SDA even, sda==scl-1 mod 4): %s" % (scl, sda, e)
        )
    except RuntimeError as e:
        # Pins are legal but the bus idles low — no pull-up / no device attached.
        for n in (sda, scl):
            if owner[n] == "i2c":
                owner[n] = None
        raise RuntimeError("I2C GP%d/GP%d bus check failed (attach a device or "
                           "pull-ups on SDA/SCL): %s" % (scl, sda, e))
    i2c_bus[bid] = {"obj": obj, "sda": sda, "scl": scl, "freq": freq}
    return {"ok": True, "data": read_state()}


def i2c_release_cmd(args):
    bid = int(args.get("id", 0))
    b = i2c_bus.pop(bid, None)
    if b is not None:
        for p in (b["sda"], b["scl"]):
            if owner[p] == "i2c":
                owner[p] = None
        try:
            b["obj"].deinit()
        except Exception:
            pass
    return {"ok": True, "data": read_state()}


def _i2c_get(args):
    b = i2c_bus.get(int(args.get("id", 0)))
    if b is None:
        raise RuntimeError("no such bus (configure it first)")
    return b


def i2c_scan(args):
    b = _i2c_get(args)["obj"]
    found = []
    with b as bus:
        for addr in bus.scan():
            found.append(int(addr))
    return {"ok": True, "data": {"addrs": found}}


def i2c_xfer(args):
    b = _i2c_get(args)["obj"]
    addr = int(args.get("addr"))
    if not 0 <= addr <= 127:
        raise ValueError("addr must be a 7-bit address (0..127)")
    w = bytearray([int(x) & 0xFF for x in (args.get("w") or [])])
    rlen = int(args.get("r", 0))
    if rlen < 0 or rlen > 4096:
        raise ValueError("r out of range")
    rep = bool(args.get("rep_start"))
    rd = None
    with b as bus:
        if rlen and w and rep:
            # write a register pointer then repeated-start straight into the read
            buf = bytearray(rlen)
            bus.writeto_then_readfrom(addr, w, buf)
            rd = buf
        else:
            if w:
                bus.writeto(addr, w)
            if rlen:
                rd = bus.readfrom(addr, rlen)
    return {"ok": True, "data": {"rd": list(rd) if rd is not None else []}}


# —— UART bus driver ——
# Like I2C, a UART owns a pin PAIR, but either member may be absent: TX-only
# (write) and RX-only (read) buses are legal, so a bus is "complete" when at
# least one of tx/rx is bound. rp2 hardware UART (UART0/UART1) only exposes a
# fixed set of TX and RX pins, and a full-duplex pair must land on the same
# instance, so legality is pair-based — probe_uart() discovers the usable TX
# pins, RX pins, and ordered (tx,rx) pairs and the host greys the rest.
uart_bus = {}  # id -> {"obj": UART, "tx": n|-1, "rx": m|-1, "baud": hz}


def _uart_bus_on(n):
    for bid, b in uart_bus.items():
        if b["tx"] == n or b["rx"] == n:
            return bid
    return None


def uart_release(n):
    bid = _uart_bus_on(n)
    if bid is None:
        return
    b = uart_bus.pop(bid)
    for p in (b["tx"], b["rx"]):
        if p >= 0 and owner[p] == "uart":
            owner[p] = None
    try:
        b["obj"].deinit()
    except Exception:
        pass


def uart_cfg(args):
    bid = int(args.get("id", 0))
    tx = int(args.get("tx", -1))
    rx = int(args.get("rx", -1))
    baud = int(args.get("baud", 115200))
    if tx < 0 and rx < 0:
        raise ValueError("a UART bus needs at least a TX or an RX pin")
    for n in (tx, rx):
        if n >= 0 and not 0 <= n < NUM_PINS:
            raise ValueError("pin out of range")
    if tx >= 0 and tx == rx:
        raise ValueError("TX and RX must be different pins")
    prev = uart_bus.get(bid)
    if prev is not None and prev["tx"] == tx and prev["rx"] == rx and prev["baud"] == baud:
        return {"ok": True, "data": read_state()}
    if prev is not None:
        uart_bus.pop(bid)
        for p in (prev["tx"], prev["rx"]):
            if p >= 0 and owner[p] == "uart":
                owner[p] = None
        try:
            prev["obj"].deinit()
        except Exception:
            pass
    for n in (tx, rx):
        if n >= 0 and not claim(n, "uart", force=True):
            raise RuntimeError("pin GP%d busy" % n)
    try:
        obj = busio.UART(
            _pin(tx) if tx >= 0 else None,
            _pin(rx) if rx >= 0 else None,
            baudrate=baud,
            # Non-blocking by default: the streaming uart_monitor polls every
            # tick, and CircuitPython's 1000 ms read timeout would freeze the
            # whole cooperative loop waiting for the first byte. uart_read
            # bumps this back to a bounded wait for the manual capture button.
            timeout=0,
        )
    except Exception as e:
        for n in (tx, rx):
            if n >= 0 and owner[n] == "uart":
                owner[n] = None
        raise ValueError(
            "UART GP%d(TX)/GP%d(RX) not routable — rp2 hardware UART pins are fixed "
            "and a full-duplex pair must share one UART instance (see caps.uart): %s"
            % (tx, rx, e)
        )
    uart_bus[bid] = {"obj": obj, "tx": tx, "rx": rx, "baud": baud}
    return {"ok": True, "data": read_state()}


def uart_release_cmd(args):
    bid = int(args.get("id", 0))
    b = uart_bus.pop(bid, None)
    if b is not None:
        for p in (b["tx"], b["rx"]):
            if p >= 0 and owner[p] == "uart":
                owner[p] = None
        try:
            b["obj"].deinit()
        except Exception:
            pass
    return {"ok": True, "data": read_state()}


def _uart_get(args):
    b = uart_bus.get(int(args.get("id", 0)))
    if b is None:
        raise RuntimeError("no such bus (configure it first)")
    return b


def uart_write(args):
    b = _uart_get(args)
    if b["tx"] < 0:
        raise RuntimeError("this bus has no TX pin — bind one first")
    data = bytearray([int(x) & 0xFF for x in (args.get("data") or [])])
    if not data:
        raise ValueError("no data to write")
    n = b["obj"].write(data)
    return {"ok": True, "data": {"written": int(n) if n is not None else 0}}


def uart_read(args):
    b = _uart_get(args)
    if b["rx"] < 0:
        raise RuntimeError("this bus has no RX pin — bind one first")
    n = max(0, min(4096, int(args.get("n", 64))))
    # The bus object is created non-blocking (timeout=0) for the streaming
    # monitor; the manual capture wants a short bounded wait so a Read click
    # can actually gather freshly-arriving bytes instead of returning empty.
    try:
        b["obj"].timeout = 200
    except Exception:
        pass
    try:
        data = b["obj"].read(n)
    finally:
        # Restore the non-blocking default so the streaming monitor's next
        # read() never inherits this wait and stalls the loop.
        try:
            b["obj"].timeout = 0
        except Exception:
            pass
    return {"ok": True, "data": {"rd": list(data) if data else []}}


# —— SPI bus driver ——
# A third multi-pin bus, same arbiter rule as I2C/UART: every member (SCK, MOSI,
# MISO and each CS) is claimed under owner[] = "spi", and releasing any one of
# them tears the whole bus down, because busio.SPI has no per-pin release.
#
# Two properties of the rp2 port shaped this API and both were measured with
# tools/spi_probe.py on CircuitPython 10.3.1 / Pico 2:
#  * the constructor takes the pins POSITIONALLY, accepts no baudrate= or
#    half_duplex= keyword, and refuses a bare SCK, so speed and mode are set
#    afterwards with configure() -- which only works while the bus is locked
#    ("Function requires lock" otherwise).
#  * .frequency reports the clock the divider actually reached. rp2 SPI can only
#    divide the 150 MHz system clock by an even integer, so 75 MHz is the ceiling
#    and a request for 2 MHz lands on 1973684 Hz. hbaud echoes that truth, exactly
#    like the PWM hfreq field.
# CS is not part of busio.SPI on this port: the lines are plain digitalio outputs
# that idle high and are pulled low around one transaction, which is also what
# lets one bus serve up to SPI_MAX_CS devices.
spi_bus = {}  # id -> {"obj": SPI, "sck": n, "mosi": m|-1, "miso": k|-1, "baud": hz,
#             "hbaud": hz, "mode": 0..3, "cs": [n, ...], "cs_obj": [DigitalOut, ...]}

SPI_MAX_CS = 4

# Which (SCK, MOSI, MISO) sets the port accepts. tools/spi_probe.py swept every
# ordered (SCK, partner) pair in both roles on CircuitPython 10.3.1 / Pico 2:
# 53 accepted pairs, falling in exactly two groups, and 1571 pairs raised "Invalid
# pins". Those two groups are the two SPI peripherals -- the same split the
# datasheet draws -- and they agree row for row with pico-sdk
# src/rp2_common/hardware_gpio/include/hardware/gpio.h ("On RP2350 the function
# selects are", F1 = SPI; F1 CSn rows are ignored because busio.SPI takes no CS
# pin). A second live bus therefore has to take the other group or the port
# answers "SPI peripheral in use".
# This is a static table like probe_uart()'s, deliberately not a boot-time sweep:
# the sweep is 1600+ constructor calls and takes minutes, and the answer is a
# property of the silicon, not of the wiring.
# Entries 30..47 are the RP2350B (QFN-80) rows of the same table: they are
# documented, NOT measured, because this harness runs an RP2350A. They are inert
# on a 30-GPIO board -- the host only offers pins below caps.pins -- and they turn
# the SPI lane from a Pico-2-only table into the full RP2350 one.
SPI_GROUPS = [
    {"sck": [2, 6, 18, 22, 34, 38], "mosi": [3, 7, 19, 23, 35, 39],
     "miso": [0, 4, 16, 20, 32, 36]},
    {"sck": [10, 14, 26, 30, 42, 46], "mosi": [11, 15, 27, 31, 43, 47],
     "miso": [8, 12, 24, 28, 40, 44]},
]


def _spi_group(sck, mosi, miso):
    # The group a requested pin set belongs to, or None if it spans two groups.
    # Absent half-bus members (-1) simply do not participate.
    for g in SPI_GROUPS:
        ok = sck in g["sck"]
        if mosi >= 0:
            ok = ok and mosi in g["mosi"]
        if miso >= 0:
            ok = ok and miso in g["miso"]
        if ok:
            return g
    return None


def _spi_members(b):
    return [b["sck"], b["mosi"], b["miso"]] + list(b["cs"])


def _spi_bus_on(n):
    # -1 marks an absent half-bus member, which is stored in the bus record and must
    # never match a real pin.
    if n < 0:
        return None
    for bid, b in spi_bus.items():
        if n in _spi_members(b):
            return bid
    return None


def _spi_free(b):
    # Drop every claim and every object behind them. Used both for a configured bus
    # and for a half-built one, so a failed spi_cfg can never leave owner="spi"
    # pointing at nothing (the pattern that blinds read_state, see pwm_start).
    for p in _spi_members(b):
        if p >= 0 and owner[p] == "spi":
            owner[p] = None
    for c in b["cs_obj"]:
        try:
            c.deinit()
        except Exception:
            pass
    try:
        b["obj"].deinit()
    except Exception:
        pass


def _spi_teardown(bid):
    _spi_free(spi_bus.pop(bid))


def spi_release(n):
    bid = _spi_bus_on(n)
    if bid is None:
        return
    _spi_teardown(bid)


def spi_cfg(args):
    bid = int(args.get("id", 0))
    sck = int(args.get("sck"))
    mosi = int(args.get("mosi", -1))
    miso = int(args.get("miso", -1))
    cs = [int(x) for x in (args.get("cs") or [])]
    baud = int(args.get("baud", 100000))
    mode = int(args.get("mode", 0))
    if mosi < 0 and miso < 0:
        raise ValueError("busio.SPI on rp2 needs at least a MOSI or a MISO pin")
    if not 0 <= mode <= 3:
        raise ValueError("mode must be 0..3 (CPOL/CPHA)")
    if len(cs) > SPI_MAX_CS:
        raise ValueError("at most %d CS lines per bus" % SPI_MAX_CS)
    for n in [sck, mosi, miso] + cs:
        if n >= 0 and not 0 <= n < NUM_PINS:
            raise ValueError("pin out of range")
    seen = set()
    for n in [sck, mosi, miso] + cs:
        if n < 0:
            continue
        if n in seen:
            raise ValueError("one pin cannot hold two SPI roles")
        seen.add(n)
    if _spi_group(sck, mosi, miso) is None:
        raise ValueError(
            "SPI GP%d(SCK)/GP%d(MOSI)/GP%d(MISO) is not a routable set: rp2 SPI pins "
            "come in fixed groups, pick all three from one entry of caps.spi.groups"
            % (sck, mosi, miso)
        )
    prev = spi_bus.get(bid)
    # A pin that another live bus already holds must be refused here, not by
    # claim(): owner[] says "spi" for both, so the claim would silently succeed and
    # the digitalio/busio construction afterwards would fail -- and the rollback
    # would then clear owner[] for a pin the OTHER bus is still driving.
    for p in [sck, mosi, miso] + cs:
        ob = _spi_bus_on(p)
        if ob is not None and ob != bid:
            raise RuntimeError("GP%d already belongs to SPI bus %d — release it first" % (p, ob))
    if (
        prev is not None
        and prev["sck"] == sck
        and prev["mosi"] == mosi
        and prev["miso"] == miso
        and prev["cs"] == cs
        and prev["baud"] == baud
        and prev["mode"] == mode
    ):
        return {"ok": True, "data": read_state()}
    if prev is not None:
        _spi_teardown(bid)
    claimed = [n for n in [sck, mosi, miso] + cs if n >= 0]
    for n in claimed:
        if not claim(n, "spi", force=True):  # steals gpio/pwm/adc/i2c pins, like pwm
            raise RuntimeError("pin GP%d busy" % n)
    try:
        # positional: (sck, mosi, miso); a half bus passes None for the absent one
        obj = busio.SPI(
            _pin(sck),
            _pin(mosi) if mosi >= 0 else None,
            _pin(miso) if miso >= 0 else None,
        )
    except Exception as e:
        for n in claimed:
            if owner[n] == "spi":
                owner[n] = None
        # Two live buses need two SPI peripherals; the port says "SPI peripheral
        # in use" when the pins resolve to an instance that is already taken.
        raise ValueError("could not build SPI on GP%d/GP%d/GP%d: %s" % (sck, mosi, miso, e))
    cs_obj = []
    try:
        for n in cs:
            d = digitalio.DigitalInOut(_pin(n))
            d.switch_to_output(value=True)  # CS idles deasserted
            cs_obj.append(d)
        if not obj.try_lock():
            raise RuntimeError("SPI bus is locked by another holder")
        try:
            obj.configure(baudrate=baud, polarity=(mode >> 1) & 1, phase=mode & 1)
            hbaud = int(obj.frequency)
        finally:
            obj.unlock()
    except Exception as e:
        _spi_free({"obj": obj, "sck": sck, "mosi": mosi, "miso": miso,
                   "cs": cs, "cs_obj": cs_obj})
        raise ValueError("SPI GP%d configure failed: %s" % (sck, e))
    spi_bus[bid] = {
        "obj": obj,
        "sck": sck,
        "mosi": mosi,
        "miso": miso,
        "cs": cs,
        "cs_obj": cs_obj,
        "baud": baud,
        "hbaud": hbaud,
        "mode": mode,
    }
    return {"ok": True, "data": read_state()}


def spi_release_cmd(args):
    bid = int(args.get("id", 0))
    if bid in spi_bus:
        _spi_teardown(bid)
    return {"ok": True, "data": read_state()}


def _spi_get(args):
    b = spi_bus.get(int(args.get("id", 0)))
    if b is None:
        raise RuntimeError("no such bus (configure it first)")
    return b


def spi_xfer(args):
    b = _spi_get(args)
    obj = b["obj"]
    w = bytearray([int(x) & 0xFF for x in (args.get("w") or [])])
    rlen = int(args.get("r", 0))
    if rlen < 0 or rlen > 4096:
        raise ValueError("r out of range")
    if not w and not rlen:
        raise ValueError("nothing to transfer")
    csi = int(args.get("cs", 0))
    if csi >= 0:
        if csi >= len(b["cs_obj"]):
            raise ValueError("no CS %d on this bus (it has %d)" % (csi, len(b["cs_obj"])))
        csn = b["cs_obj"][csi]
    else:
        csn = None  # transaction with every CS left high
    hold = bool(args.get("hold"))
    rd = b""
    if rlen and b["miso"] < 0:
        raise RuntimeError("this bus has no MISO pin — nothing to read")
    if w and b["mosi"] < 0:
        raise RuntimeError("this bus has no MOSI pin — nothing to write")
    if not obj.try_lock():
        raise RuntimeError("SPI bus is locked by another holder")
    try:
        if csn is not None:
            csn.value = 0
        if b["mosi"] >= 0 and b["miso"] >= 0:
            # write_readinto() is the only full-duplex call this port has, and it
            # wants equal buffers: pad a short write with 0xFF idle clocks, and
            # hand back only the first rlen bytes of a longer read.
            n = max(len(w), rlen)
            tx = bytearray(b"\xff" * n)
            tx[: len(w)] = w
            rx = bytearray(n)
            obj.write_readinto(tx, rx)
            rd = rx[:rlen]
        elif b["mosi"] >= 0:
            obj.write(w)
        else:
            buf = bytearray(rlen)
            obj.readinto(buf)
            rd = buf
    finally:
        if csn is not None and not hold:
            csn.value = 1
        obj.unlock()
    return {
        "ok": True,
        "data": {
            "rd": list(rd),
            "cs": csi,
            "held": hold,
            "hbaud": b["hbaud"],
            "mode": b["mode"],
        },
    }


# —— ADC waveform streaming (scope feed) ——
# While STREAM is active the deadband adc_monitor stays quiet and the
# adc_streamer task ships whole batches instead: one event per batch keeps
# the wire (and the browser) at ~1Hz no matter how many channels run.
STREAM = None  # {"pins": tuple, "ms": int, "batch": int, "fmt": "json"|"bin"} | None


def adc_stream(args):
    global STREAM
    if not args.get("on"):
        STREAM = None
        return {"ok": True, "data": {"stream": None}}
    ps = []
    for p in args.get("pins") or []:
        n = int(p)
        if n != TEMP_PIN and not 0 <= n < NUM_PINS:
            raise ValueError("pin out of range")
        if not _adc_configured(n):
            raise ValueError(
                "adc not configured on %s" % ("TEMP" if n == TEMP_PIN else "GP%d" % n)
            )
        ps.append(n)
    if not ps:
        raise ValueError("no pins given")
    ms = max(10, int(args.get("ms", 50)))
    batch = max(1, min(100, int(args.get("batch", 20))))
    fmt = args.get("fmt", "json")
    if fmt not in ("json", "bin"):
        raise ValueError("fmt must be json or bin")
    if fmt == "bin" and DATA is None and (usb_cdc is None or usb_cdc.console is None):
        raise ValueError("no CDC port available for bin frames")
    STREAM = {"pins": tuple(ps), "ms": ms, "batch": batch, "fmt": fmt}
    return {"ok": True, "data": {"stream": {"pins": ps, "ms": ms, "batch": batch, "fmt": fmt}}}


# —— event subscriptions (MQTT-style sub/unsub + retained) ——
# A topic only emits while it is subscribed; unsubscribed topics stay silent so
# the wire carries just what the host asked for. Subscribing immediately
# replays one "retained" snapshot, so the host never waits for the next edge.
#   gpio.in   params {mask:int = all inputs, min_ms:int = 0}
#   adc.<n>   params {deadband:int = ADC_DEADBAND}   (n = wire pin, 100 = temp)
SUBS = {}


def _adc_topic_pin(topic):
    # "adc.<wirepin>" -> int pin, or None for any other topic
    if not topic.startswith("adc."):
        return None
    try:
        return int(topic[4:])
    except ValueError:
        return None


def _adc_val_of(n):
    # bounds-safe raw reading for an arbitrary wire pin from a subscription,
    # or None if the pin is out of range / not configured
    if n == TEMP_PIN or 0 <= n < NUM_PINS:
        if _adc_configured(n):
            return _adc_val(n)
    return None


def _gpio_in_masked():
    sub = SUBS.get("gpio.in") or {}
    cur = read_inputs()
    mask = sub.get("mask")
    if isinstance(mask, int):
        cur &= mask
    return cur


def _emit_retained(topic):
    if topic == "gpio.in":
        if in_idx:
            send({"evt": "gpio_in", "in": _gpio_in_masked(), "retained": True})
        return
    n = _adc_topic_pin(topic)
    if n is None:
        return
    v = _adc_val_of(n)
    if v is not None:
        send({"evt": "adc", "vals": {str(n): v}, "retained": True})


def cmd_sub(args):
    topic = args.get("topic")
    if not isinstance(topic, str) or not topic:
        raise ValueError("topic required")
    params = args.get("params")
    SUBS[topic] = params if isinstance(params, dict) else {}
    _emit_retained(topic)
    return {"ok": True, "data": {"sub": topic}}


def cmd_unsub(args):
    topic = args.get("topic")
    if topic in SUBS:
        del SUBS[topic]
    return {"ok": True, "data": {"unsub": topic}}


# —— capability probe ——
# rp2 I2C legality is a property of the ORDERED (scl, sda) pair, not of any single
# pin, and two documented sources agree on the rule: CircuitPython
# ports/raspberrypi/common-hal/busio/I2C.c accepts a pair only when
#     scl % 2 == 1 && sda % 2 == 0 && (scl / 2) % 2 == (sda / 2) % 2
# i.e. SCL odd, SDA even, both on the same one of the two HARDWARE I2C
# peripherals (NUM_I2CS = 2, pico-sdk platform_defs.h) — which is exactly the F3
# column of the pico-sdk gpio.h RP2350 function table (I2C0 SCL on 1, 5, …, 29 and
# I2C1 SCL on 3, 7, …, 47, each SDA the number below it). We still PROBE rather
# than ship the formula, for one reason only: the port's own answer is what this
# firmware has to match, and asking it is cheap.
# We deliberately do NOT probe per-pin I2C "capability": on a bare harness
# busio.I2C raises "No pull up found" for legal-but-unwired pairs, which is a
# wiring condition, not a pin limit, so a per-pin list would wrongly mark every
# pin unusable.
def probe_i2c_pairs():
    # Each ordered (scl, sda) that CircuitPython will ACCEPT (i.e. does not raise
    # "Invalid pins") is legal — a "No pull up" RuntimeError still proves the pin
    # pair is routable, just not wired to a bus. Returned as [[scl,sda], ...].
    # The candidates come from the documented rule above (SCL odd, SDA even, both
    # on the same peripheral), which is a sixth of the product; sweeping the
    # product would mean NUM_PINS^2 constructors at import -- 2304 on a 48-GPIO
    # board, against the 288 a 30-GPIO board already pays. The probe is still the
    # arbiter of the answer, and the candidate filter is CP's OWN condition, so no
    # legal pair can be missed by it.
    pairs = []
    for scl in GPS:
        if scl % 2 != 1:
            continue
        for sda in GPS:
            if sda % 2 != 0 or (scl // 2) % 2 != (sda // 2) % 2:
                continue
            try:
                o = busio.I2C(_pin(scl), _pin(sda), frequency=100000)
                o.deinit()
                pairs.append([scl, sda])  # bus actually came up
            except ValueError:
                pass  # "Invalid pins" → genuinely illegal pair, skip
            except RuntimeError:
                pairs.append([scl, sda])  # "No pull up" → pins are legal
            except Exception:
                pass
    return pairs


def probe_uart():
    # Deterministic, generated from the documentation rather than hand-copied.
    # Two sources pin this down completely:
    #  * pico-sdk src/rp2_common/hardware_gpio/include/hardware/gpio.h, the
    #    "On RP2350 the function selects are" table (RP2350 datasheet, GPIO Bank 0
    #    Functions): every even GPIO carries a UART TX (F2 GPIO_FUNC_UART when
    #    n % 4 == 0, F11 GPIO_FUNC_UART_AUX when n % 4 == 2) and every odd GPIO a
    #    UART RX (F2 when n % 4 == 1, F11 when n % 4 == 3).
    #  * CircuitPython ports/raspberrypi/common-hal/busio/UART.c, which picks the
    #    function exactly that way and takes the instance from the pin number:
    #        inst = ((n + 4) / 8) % NUM_UARTS      (NUM_UARTS = 2, platform_defs.h)
    # Checked row by row against all 30 RP2350A GPIOs: 0/12/16/28 -> UART0 TX,
    # 4/8/20/24 -> UART1 TX, 2/14/18 -> UART0 AUX TX, 6/10/22/26 -> UART1 AUX TX,
    # 1/13/17/29 -> UART0 RX, 5/9/21/25 -> UART1 RX, 3/15/19 -> UART0 AUX RX,
    # 7/11/23/27 -> UART1 AUX RX. A full-duplex pair is legal when both members
    # land on the same instance; single-pin buses (TX-only or RX-only) are fine.
    NUM_UARTS = 2

    def inst(n):
        return ((n + 4) // 8) % NUM_UARTS

    tx_ok = [n for n in GPS if n % 2 == 0]
    rx_ok = [n for n in GPS if n % 2 == 1]
    pairs = [[t, r] for t in tx_ok for r in rx_ok if inst(t) == inst(r)]
    return {"tx": tx_ok, "rx": rx_ok, "pairs": pairs}


def probe_caps():
    # Ask CircuitPython itself which pins support PWM / ADC, plus the legal I2C
    # pin PAIRS, instead of hard-coding tables that drift with CP releases.
    # Every list here is in terms of GPS — the GPIOs this board can actually name —
    # so the host never offers a pin the firmware would refuse.
    caps = {
        # The addressable set itself, holes and all: caps.pins is only the highest
        # id + 1, and a board table like raspberry_pi_pico2_w has gaps in it.
        "gp": GPS,
        "pwm": [],
        "adc": [],
        "i2c_pairs": [],
        "uart": {"tx": [], "rx": [], "pairs": []},
        # SPI pins are a static table (SPI_GROUPS): measured on this RP2350A and
        # extended with the documented RP2350B rows, not a sweep — see the comment
        # there. baud_ceiling is 150MHz/2, the smallest even divider the
        # rp2 SPI clock prescaler can produce (measured: .frequency never exceeded
        # 75000000 no matter how high the request).
        "spi": {
            "groups": SPI_GROUPS,
            "max_buses": 2,
            "max_cs": SPI_MAX_CS,
            "baud_ceiling": 75000000,
        },
        # The slow-frequency PIO backend: one static table of measured numbers, no per-pin
        # sweep (see pio_caps()). None when lib/adafruit_pioasm.mpy is not on the volume,
        # which is how the host learns not to offer the mode at all.
        "pwm_pio": pio_caps(),
        # Which CDC topology the board came up with: true = boot.py enabled the
        # second port and the protocol is on it, false = single-port console
        # fallback. The host needs this to know whether a console port exists.
        "usb": {"data": DATA is not None},
    }
    for n in GPS:
        try:
            p = PWMOut(_pin(n), duty_cycle=0)
            p.deinit()
            caps["pwm"].append(n)
        except ValueError:
            pass
    for n in GPS:
        try:
            a = analogio.AnalogIn(_pin(n))
            a.deinit()
            caps["adc"].append(n)
        except ValueError:
            pass
    caps["i2c_pairs"] = probe_i2c_pairs()
    caps["uart"] = probe_uart()
    # The static SPI table covers the whole RP2350, so project it onto GPS before
    # shipping it: on a board that cannot name GP30..GP47 those entries would offer
    # pins the very next command rejects.
    gps = set(GPS)
    caps["spi"]["groups"] = [
        {role: [n for n in pins if n in gps] for role, pins in g.items()}
        for g in SPI_GROUPS
    ]
    try:
        _ = microcontroller.cpu.temperature
        caps["adc"].append(TEMP_PIN)
    except Exception:
        pass
    return caps


# —— state reporting & command table ——
def read_inputs():
    b = 0
    for n in in_idx:
        if pin_obj[n].value:
            b |= 1 << n
    return b


def read_state():
    pd = 0
    pn = 0
    for n in in_idx:
        if pin_pull[n] == 1:
            pd |= 1 << n
        elif pin_pull[n] == 2:
            pn |= 1 << n
    pwm_m = 0
    pio_m = 0
    pw = {}
    adc_m = 0
    for n in range(NUM_PINS):
        if owner[n] == "pwm":
            pwm_m |= 1 << n
            if pwm_sm[n]:
                pio_m |= 1 << n
            pw[str(n)] = {
                "freq": pwm_par[n][0],
                "hfreq": pwm_par[n][1],
                "duty": pwm_par[n][2],
                "be": pwm_par[n][3],
            }
        elif owner[n] == "adc":
            adc_m |= 1 << n
    i2c_m = 0
    i2c_list = []
    for bid in sorted(i2c_bus):
        b = i2c_bus[bid]
        i2c_m |= (1 << b["sda"]) | (1 << b["scl"])
        i2c_list.append({"id": bid, "sda": b["sda"], "scl": b["scl"], "freq": b["freq"]})
    uart_m = 0
    uart_list = []
    for bid in sorted(uart_bus):
        b = uart_bus[bid]
        if b["tx"] >= 0:
            uart_m |= 1 << b["tx"]
        if b["rx"] >= 0:
            uart_m |= 1 << b["rx"]
        uart_list.append({"id": bid, "tx": b["tx"], "rx": b["rx"], "baud": b["baud"]})
    spi_m = 0
    spi_list = []
    for bid in sorted(spi_bus):
        b = spi_bus[bid]
        # CS pins count as owned: a GPIO write to a line that is acting as CS would
        # drive a device select, and the UI must see it as taken.
        for p in _spi_members(b):
            if p >= 0:
                spi_m |= 1 << p
        spi_list.append(
            {
                "id": bid,
                "sck": b["sck"],
                "mosi": b["mosi"],
                "miso": b["miso"],
                "cs": b["cs"],
                "baud": b["baud"],
                "hbaud": b["hbaud"],
                "mode": b["mode"],
            }
        )
    return {
        "in": read_inputs(),
        "out": out_bits,
        "cfg_in": _mask_of(in_idx),
        "cfg_out": _mask_of(out_idx),
        "cfg_pd": pd,
        "cfg_pn": pn,
        "cfg_pwm": pwm_m,
        # Which of those channels the PIO generator is driving, and how many state machines
        # are still free -- the host needs the second number to explain a refusal, since
        # the budget is per chip, not per pin.
        "cfg_pio_pwm": pio_m,
        "pio_sm_free": PIO_MAX_SM - pio_sm_used,
        "cfg_adc": adc_m,
        "cfg_i2c": i2c_m,
        "i2c": i2c_list,
        "cfg_uart": uart_m,
        "uart": uart_list,
        "cfg_spi": spi_m,
        "spi": spi_list,
        "adc_temp": 1 if temp_on else 0,
        "pwm": pw,
    }


def cmd_ping(args):
    return {"ok": True, "data": {"pong": args.get("t")}}


def cmd_hello(args):
    # A host that opens the protocol port after the board booted missed the
    # broadcast ready line, so it asks for the same payload as a reply.
    return {"ok": True, "data": boot_info()}


def cmd_echo(args):
    return {"ok": True, "data": {"echo": args.get("msg")}}


def cmd_gpio_cfg(args):
    apply_cfg(
        int(args.get("in", 0)),
        int(args.get("out", 0)),
        int(args.get("pd", 0)),
        int(args.get("pn", 0)),
    )
    return {"ok": True, "data": read_state()}


def cmd_gpio_out(args):
    set_out(int(args.get("mask", 0)), int(args.get("vals", 0)))
    return {"ok": True, "data": read_state()}


def cmd_gpio_state(args):
    return {"ok": True, "data": read_state()}


def cmd_pwm_cfg(args):
    # backend defaults to "hw": a config saved before the PIO lane existed, or a hand-typed
    # request that names nothing, must keep behaving exactly as it did.
    pwm_start(
        args.get("pin"),
        args.get("freq", 1000),
        args.get("duty", 0.5),
        args.get("backend") or "hw",
    )
    return {"ok": True, "data": read_state()}


def cmd_pwm_stop(args):
    pwm_stop(args.get("pin"))
    return {"ok": True, "data": read_state()}


def cmd_adc_cfg(args):
    adc_start(args.get("pin"))
    return {"ok": True, "data": read_state()}


def cmd_adc_stop(args):
    adc_stop(args.get("pin"))
    return {"ok": True, "data": read_state()}


COMMANDS = {
    "ping": cmd_ping,
    "hello": cmd_hello,
    "echo": cmd_echo,
    "gpio.cfg": cmd_gpio_cfg,
    "gpio.out": cmd_gpio_out,
    "gpio.state": cmd_gpio_state,
    "pwm.cfg": cmd_pwm_cfg,
    "pwm.stop": cmd_pwm_stop,
    "adc.cfg": cmd_adc_cfg,
    "adc.stop": cmd_adc_stop,
    "adc.stream": adc_stream,
    "i2c.cfg": i2c_cfg,
    "i2c.release": i2c_release_cmd,
    "i2c.scan": i2c_scan,
    "i2c.xfer": i2c_xfer,
    "uart.cfg": uart_cfg,
    "uart.release": uart_release_cmd,
    "uart.write": uart_write,
    "uart.read": uart_read,
    "spi.cfg": spi_cfg,
    "spi.release": spi_release_cmd,
    "spi.xfer": spi_xfer,
    "sub": cmd_sub,
    "unsub": cmd_unsub,
}


def dispatch(req):
    rid = req.get("id")
    handler = COMMANDS.get(req.get("cmd"))
    if not handler:
        resp = {"ok": False, "error": "unknown cmd: %s" % req.get("cmd")}
    else:
        try:
            resp = handler(req.get("args") or {})
        except Exception as e:
            resp = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    resp["id"] = rid
    send(resp)


# Caps are probed once at boot: the I2C sweep touches every legal pin pair, so
# a host that connects after startup asks for the cached copy instead of paying
# for it again.
CAPS = probe_caps()


def boot_info():
    return {
        "app": APP,
        "version": VERSION,
        "cp": list(sys.implementation.version[0:3]),
        "pins": NUM_PINS,
        "caps": CAPS,
    }


_ready = boot_info()
_ready["evt"] = "ready"
send(_ready)


_stdin_poll = select.poll()
_stdin_poll.register(sys.stdin, select.POLLIN)
_rx = b""


def _read_lines():
    # Yield whole lines already buffered on the command port, then stop. Both
    # gates are mandatory: an ungated read blocks the task group (lesson 1), and
    # on the data port read(n) would wait for n bytes (lesson 5), so ask only
    # for what in_waiting already promises.
    global _rx
    if DATA is not None:
        n = DATA.in_waiting
        if n:
            chunk = DATA.read(n if n < 512 else 512)
            if chunk:
                _rx += chunk
    else:
        while _stdin_poll.poll(0):
            ch = sys.stdin.read(1)
            if not ch:
                break
            _rx += ch.encode()
    while True:
        i = _rx.find(b"\n")
        if i < 0:
            return
        line, _rx = _rx[:i], _rx[i + 1 :]
        s = line.decode("utf-8", "replace").strip()
        if s:
            yield s


async def command_reader():
    while True:
        for line in _read_lines():
            try:
                dispatch(parse_req(line))
            except ValueError:
                send({"id": None, "ok": False, "error": "bad json"})
        await asyncio.sleep(0.002)


async def gpio_monitor():
    last = None
    alive = False
    next_ms = 0
    while True:
        try:
            if not alive:
                alive = True
                send({"evt": "dbg", "task": "gpio", "alive": True})
            # Only push while gpio.in is subscribed; the host still catches up
            # via the 1 s gpio.state poll if a subscription is ever missed.
            if in_idx and "gpio.in" in SUBS:
                sub = SUBS["gpio.in"]
                cur = _gpio_in_masked()
                now = time.monotonic() * 1000
                if cur != last and now >= next_ms:
                    send({"evt": "gpio_in", "in": cur})
                    last = cur
                    next_ms = now + int(sub.get("min_ms", 0))
        except Exception as e:  # never let a task die silently under gather
            send({"evt": "dbg", "task": "gpio", "err": "%s: %s" % (type(e).__name__, e)})
        await asyncio.sleep(0.05)


ADC_DEADBAND = 328  # ~0.5% of the 16-bit span; keeps noise off the wire


def _adc_deadband(n):
    # A subscription to "adc.<n>" may override the deadband for that channel;
    # otherwise the global default applies. ADC has no poll fallback, so the
    # monitor always reports configured channels — the subscription only tunes
    # sensitivity (and delivers the retained snapshot on sub).
    sub = SUBS.get("adc.%d" % n)
    if isinstance(sub, dict):
        db = sub.get("deadband")
        if isinstance(db, int) and db >= 0:
            return db
    return ADC_DEADBAND


async def adc_monitor():
    sent = {}
    alive = False
    while True:
        try:
            if not alive:
                alive = True
                send({"evt": "dbg", "task": "adc", "alive": True})
            if STREAM is None:
                vals = {}
                dbs = {}
                for n in range(NUM_PINS):
                    if adc_obj[n] is not None:
                        vals[str(n)] = adc_obj[n].value
                        dbs[str(n)] = _adc_deadband(n)
                if temp_on:
                    vals[str(TEMP_PIN)] = _temp_raw16()
                    dbs[str(TEMP_PIN)] = _adc_deadband(TEMP_PIN)
                if vals:
                    moved = set(vals) != set(sent) or any(
                        abs(v - sent.get(k, -98304)) > dbs[k] for k, v in vals.items()
                    )
                    if moved:
                        send({"evt": "adc", "vals": vals})
                        sent = vals
                else:
                    sent = {}
        except Exception as e:
            send({"evt": "dbg", "task": "adc", "err": "%s: %s" % (type(e).__name__, e)})
        await asyncio.sleep(0.1)


def _emit_wave(s, rows):
    # rows: list of per-instant channel readings (row-major), len == batch
    if s["fmt"] == "bin":
        pins = s["pins"]
        nch = len(pins)
        head = struct.pack("<BBHH", 1, nch, s["ms"], len(rows))
        flat = []
        for r in rows:
            flat.extend(r)
        body = struct.pack("<%dH" % len(flat), *flat)
        send_bin(head + struct.pack("<%dH" % nch, *pins) + body)
    else:
        send({"evt": "adc_w", "pins": list(s["pins"]), "ms": s["ms"], "v": rows})


async def adc_streamer():
    global STREAM
    buf = []
    while True:
        s = STREAM
        if not s:
            buf = []
            await asyncio.sleep(0.1)
            continue
        t0 = time.monotonic()
        try:
            buf.append([_adc_val(n) for n in s["pins"]])
            if len(buf) >= s["batch"]:
                _emit_wave(s, buf)
                buf = []
        except Exception as e:
            send({"evt": "dbg", "task": "stream", "err": "%s: %s" % (type(e).__name__, e)})
            STREAM = None
            buf = []
        dt = s["ms"] / 1000.0 - (time.monotonic() - t0)
        await asyncio.sleep(dt if dt > 0.001 else 0.001)


def _uart_topic_id(topic):
    # "uart.<id>" -> int bus id, or None for any other topic.
    if not topic.startswith("uart."):
        return None
    try:
        return int(topic[5:])
    except ValueError:
        return None


async def uart_monitor():
    # Streams RX bytes of any bus the host subscribed to (topic "uart.<id>") as
    # uart_rx events, so the console can show a live serial terminal. Non-blocking
    # read() each tick; only emits when bytes actually arrived, so an idle wire
    # stays silent. A bus that disappears (released / reconfigured away) drops its
    # subscription automatically.
    alive = False
    while True:
        try:
            if not alive:
                alive = True
                send({"evt": "dbg", "task": "uart", "alive": True})
            for topic in list(SUBS):
                bid = _uart_topic_id(topic)
                if bid is None:
                    continue
                b = uart_bus.get(bid)
                if b is None or b["rx"] < 0:
                    SUBS.pop(topic, None)
                    continue
                # Drain the whole RX buffer each tick, not just 256 bytes: a
                # single capped read leaves leftovers in the hardware FIFO that
                # only surface on the NEXT tick, which looks like multi-second
                # "batch" lag whenever the loop is briefly starved. Collect until
                # read() returns empty (bounded so a flood can't wedge the loop).
                chunks = []
                total = 0
                for _ in range(16):
                    data = b["obj"].read(256)
                    if not data:
                        break
                    chunks.append(data)
                    total += len(data)
                    if total >= 4096:
                        break
                if chunks:
                    payload = chunks[0] if len(chunks) == 1 else b"".join(chunks)
                    send({"evt": "uart_rx", "id": bid, "data": list(payload)})
        except Exception as e:  # never let a task die silently under gather
            send({"evt": "dbg", "task": "uart", "err": "%s: %s" % (type(e).__name__, e)})
        await asyncio.sleep(0.01)


async def main():
    send({"evt": "dbg", "task": "main", "alive": True})
    # Official asyncio guide pattern: create_task each coroutine, gather the
    # Task handles (gather rejects bare coroutines on this port).
    t_cmd = asyncio.create_task(command_reader())
    t_gpio = asyncio.create_task(gpio_monitor())
    t_adc = asyncio.create_task(adc_monitor())
    t_stream = asyncio.create_task(adc_streamer())
    t_uart = asyncio.create_task(uart_monitor())
    await asyncio.gather(t_cmd, t_gpio, t_adc, t_stream, t_uart)


asyncio.run(main())
