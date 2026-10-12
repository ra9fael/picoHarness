"""Audit the pin-legality tables against the official documentation.

Three halves, so the offline ones run without a free COM port:

  --self    check the CLOSED RULES the firmware now generates its tables from
            (probe_uart's instance formula, CP's I2C pin test, the PWM slice
            mapping, the ADC window) against DOC below. Catches a wrong formula.
  --static  parse what still ships as DATA inside src/fw/code.py (SPI_GROUPS) and
            diff it against DOC.
  (default) self + static + live: open the protocol port, send {"cmd":"hello"}
            and diff the device's caps against DOC for the GPIOs the board can
            name.

DOC is not invented here. It is a row-by-row transcription of the official
RP2350 GPIO function table -- Raspberry Pi RP2350 datasheet, "GPIO Bank 0
Functions", mirrored verbatim in pico-sdk
src/rp2_common/hardware_gpio/include/hardware/gpio.h under "On RP2350 the
function selects are" (rows 0-29) and "GPIOs 30 through 47 are QFN-80 only"
(rows 30-47). Columns kept: F1=SPI, F2=UART, F3=I2C, F4=PWM, F11=the AUX UART
TX/RX pair. F5..F10 (SIO/PIO/clock/trace/USB) are dropped because no lane here
uses them, and the F1 CSn cells are dropped because busio.SPI takes no CS pin.
Package limits come from pico-sdk
src/rp2350/hardware_regs/include/hardware/platform_defs.h:
NUM_BANK0_GPIOS = 30 (RP2350A) / 48 (RP2350B), and the ADC window is
ADC_BASE_PIN=26 with NUM_ADC_CHANNELS=5 on RP2350A vs 40/9 on RP2350B.

Exit code is non-zero when any table disagrees with the documentation.
"""

import argparse
import json
import re
import sys
import time

SRC = r"C:\Users\renfei\Downloads\PicoJig-CP\src\fw\code.py"
NUM_GPIO = 48  # RP2350B QFN-80; RP2350A stops at 29

# (gpio, F1 SPI, F2 UART, F3 I2C, F4 PWM, F11 AUX UART)
DOC = [
    (0,  "SPI0 RX",  "UART0 TX",  "I2C0 SDA", "PWM0 A",  ""),
    (1,  "SPI0 CSn", "UART0 RX",  "I2C0 SCL", "PWM0 B",  ""),
    (2,  "SPI0 SCK", "UART0 CTS", "I2C1 SDA", "PWM1 A",  "UART0 TX"),
    (3,  "SPI0 TX",  "UART0 RTS", "I2C1 SCL", "PWM1 B",  "UART0 RX"),
    (4,  "SPI0 RX",  "UART1 TX",  "I2C0 SDA", "PWM2 A",  ""),
    (5,  "SPI0 CSn", "UART1 RX",  "I2C0 SCL", "PWM2 B",  ""),
    (6,  "SPI0 SCK", "UART1 CTS", "I2C1 SDA", "PWM3 A",  "UART1 TX"),
    (7,  "SPI0 TX",  "UART1 RTS", "I2C1 SCL", "PWM3 B",  "UART1 RX"),
    (8,  "SPI1 RX",  "UART1 TX",  "I2C0 SDA", "PWM4 A",  ""),
    (9,  "SPI1 CSn", "UART1 RX",  "I2C0 SCL", "PWM4 B",  ""),
    (10, "SPI1 SCK", "UART1 CTS", "I2C1 SDA", "PWM5 A",  "UART1 TX"),
    (11, "SPI1 TX",  "UART1 RTS", "I2C1 SCL", "PWM5 B",  "UART1 RX"),
    (12, "SPI1 RX",  "UART0 TX",  "I2C0 SDA", "PWM6 A",  ""),
    (13, "SPI1 CSn", "UART0 RX",  "I2C0 SCL", "PWM6 B",  ""),
    (14, "SPI1 SCK", "UART0 CTS", "I2C1 SDA", "PWM7 A",  "UART0 TX"),
    (15, "SPI1 TX",  "UART0 RTS", "I2C1 SCL", "PWM7 B",  "UART0 RX"),
    (16, "SPI0 RX",  "UART0 TX",  "I2C0 SDA", "PWM0 A",  ""),
    (17, "SPI0 CSn", "UART0 RX",  "I2C0 SCL", "PWM0 B",  ""),
    (18, "SPI0 SCK", "UART0 CTS", "I2C1 SDA", "PWM1 A",  "UART0 TX"),
    (19, "SPI0 TX",  "UART0 RTS", "I2C1 SCL", "PWM1 B",  "UART0 RX"),
    (20, "SPI0 RX",  "UART1 TX",  "I2C0 SDA", "PWM2 A",  ""),
    (21, "SPI0 CSn", "UART1 RX",  "I2C0 SCL", "PWM2 B",  ""),
    (22, "SPI0 SCK", "UART1 CTS", "I2C1 SDA", "PWM3 A",  "UART1 TX"),
    (23, "SPI0 TX",  "UART1 RTS", "I2C1 SCL", "PWM3 B",  "UART1 RX"),
    (24, "SPI1 RX",  "UART1 TX",  "I2C0 SDA", "PWM4 A",  ""),
    (25, "SPI1 CSn", "UART1 RX",  "I2C0 SCL", "PWM4 B",  ""),
    (26, "SPI1 SCK", "UART1 CTS", "I2C1 SDA", "PWM5 A",  "UART1 TX"),
    (27, "SPI1 TX",  "UART1 RTS", "I2C1 SCL", "PWM5 B",  "UART1 RX"),
    (28, "SPI1 RX",  "UART0 TX",  "I2C0 SDA", "PWM6 A",  ""),
    (29, "SPI1 CSn", "UART0 RX",  "I2C0 SCL", "PWM6 B",  ""),
    (30, "SPI1 SCK", "UART0 CTS", "I2C1 SDA", "PWM7 A",  "UART0 TX"),
    (31, "SPI1 TX",  "UART0 RTS", "I2C1 SCL", "PWM7 B",  "UART0 RX"),
    (32, "SPI0 RX",  "UART0 TX",  "I2C0 SDA", "PWM8 A",  ""),
    (33, "SPI0 CSn", "UART0 RX",  "I2C0 SCL", "PWM8 B",  ""),
    (34, "SPI0 SCK", "UART0 CTS", "I2C1 SDA", "PWM9 A",  "UART0 TX"),
    (35, "SPI0 TX",  "UART0 RTS", "I2C1 SCL", "PWM9 B",  "UART0 RX"),
    (36, "SPI0 RX",  "UART1 TX",  "I2C0 SDA", "PWM10 A", ""),
    (37, "SPI0 CSn", "UART1 RX",  "I2C0 SCL", "PWM10 B", ""),
    (38, "SPI0 SCK", "UART1 CTS", "I2C1 SDA", "PWM11 A", "UART1 TX"),
    (39, "SPI0 TX",  "UART1 RTS", "I2C1 SCL", "PWM11 B", "UART1 RX"),
    (40, "SPI1 RX",  "UART1 TX",  "I2C0 SDA", "PWM8 A",  ""),
    (41, "SPI1 CSn", "UART1 RX",  "I2C0 SCL", "PWM8 B",  ""),
    (42, "SPI1 SCK", "UART1 CTS", "I2C1 SDA", "PWM9 A",  "UART1 TX"),
    (43, "SPI1 TX",  "UART1 RTS", "I2C1 SCL", "PWM9 B",  "UART1 RX"),
    (44, "SPI1 RX",  "UART0 TX",  "I2C0 SDA", "PWM10 A", ""),
    (45, "SPI1 CSn", "UART0 RX",  "I2C0 SCL", "PWM10 B", ""),
    (46, "SPI1 SCK", "UART0 CTS", "I2C1 SDA", "PWM11 A", "UART0 TX"),
    (47, "SPI1 TX",  "UART0 RTS", "I2C1 SCL", "PWM11 B", "UART0 RX"),
]
assert [r[0] for r in DOC] == list(range(NUM_GPIO)), "DOC must cover every GPIO"

# What CircuitPython accepts as ADC pins, from ports/raspberrypi/common-hal/
# analogio/AnalogIn.c:
#     pin->number < ADC_BASE_PIN || pin->number > ADC_BASE_PIN + NUM_ADC_CHANNELS - 1
# -> invalid pin. The window therefore covers the internal channels too, which
# have no GPIO number, so the addressable ADC pins are the intersection with the
# package's GPIOs.
ADC_WINDOW = {"rp2350a": (26, 26 + 5 - 1), "rp2350b": (40, 40 + 9 - 1)}
MAX_GPIO = {"rp2350a": 29, "rp2350b": 47}

SPI_ROLES = {"RX": "miso", "TX": "mosi", "SCK": "sck"}


def doc_adc(package):
    lo, hi = ADC_WINDOW[package]
    return [n for n in range(lo, min(hi, MAX_GPIO[package]) + 1)]


def doc_uart(package=None):
    """pin -> (instance, 'tx'|'rx') straight out of the F2/F11 cells."""
    tx, rx = {}, {}
    for row in DOC:
        n, f2, f11 = row[0], row[2], row[5]
        for cell in (f2, f11):  # F2 wins; CTS/RTS are hardware-optional, not our lanes
            if not cell:
                continue
            m = re.match(r"UART(\d) (TX|RX)", cell)
            if not m:
                continue
            inst, role = int(m.group(1)), m.group(2)
            (tx if role == "TX" else rx).setdefault(n, inst)
    if package:
        keep = [n for n in range(MAX_GPIO[package] + 1)]
        tx = {k: v for k, v in tx.items() if k in keep}
        rx = {k: v for k, v in rx.items() if k in keep}
    return tx, rx


def doc_i2c(package=None):
    """[(scl, sda), ...] every ordered pair the F3 column can route on one instance."""
    inst = {"0": {"scl": [], "sda": []}, "1": {"scl": [], "sda": []}}
    for row in DOC:
        m = re.match(r"I2C(\d) (SCL|SDA)", row[3])
        inst[m.group(1)][m.group(2).lower()].append(row[0])
    pairs = [(s, d) for k in inst for s in inst[k]["scl"] for d in inst[k]["sda"]]
    pairs.sort()
    if package:
        pairs = [p for p in pairs if max(p) <= MAX_GPIO[package]]
    return [list(p) for p in pairs]


def doc_spi(package=None):
    groups = [{"sck": [], "mosi": [], "miso": []}, {"sck": [], "mosi": [], "miso": []}]
    for row in DOC:
        m = re.match(r"SPI(\d) (RX|TX|SCK|CSn)", row[1])
        if not m or m.group(2) == "CSn":
            continue
        groups[int(m.group(1))][SPI_ROLES[m.group(2)]].append(row[0])
    if package:
        groups = [{r: [n for n in v if n <= MAX_GPIO[package]] for r, v in g.items()}
                  for g in groups]
    return groups


def doc_pwm(package=None):
    """pin -> (slice, channel) from the F4 column. 12 slices, A = even pin."""
    out = {}
    for row in DOC:
        m = re.match(r"PWM(\d+) ([AB])", row[4])
        out[row[0]] = (int(m.group(1)), 0 if m.group(2) == "A" else 1)
    if package:
        out = {k: v for k, v in out.items() if k <= MAX_GPIO[package]}
    return out


# --- the closed rules the firmware uses ----------------------------------------

def rule_uart_inst(n):
    # CircuitPython ports/raspberrypi/common-hal/busio/UART.c: ((n + 4) / 8) % NUM_UARTS
    return ((n + 4) // 8) % 2


def rule_tx(n):
    return n % 2 == 0 and (n % 4 == 0 or n % 4 == 2)


def rule_rx(n):
    return n % 2 == 1


def rule_i2c_pair(scl, sda):
    # common-hal/busio/I2C.c: scl % 2 == 1 && sda % 2 == 0 && (scl / 2) % 2 == (sda / 2) % 2
    return scl % 2 == 1 and sda % 2 == 0 and (scl // 2) % 2 == (sda // 2) % 2


def rule_pwm(n):
    # pico-sdk hardware/pwm.h: GPIO 0..31 -> slice (n / 2) % 8, channel n % 2;
    # GPIO 32..47 continue on slices 8..11, two pins each.
    if n < 32:
        return ((n >> 1) % 8, n & 1)
    return (8 + ((n - 32) % 8) // 2, n & 1)


# --- comparison helpers --------------------------------------------------------

bad = []


def report(label, expected, actual):
    e, a = set(expected), set(actual)
    missing = sorted(e - a)
    extra = sorted(a - e)
    if missing or extra:
        bad.append(label)
        print("MISMATCH %s" % label)
        if missing:
            print("   docs allow, table/caps do not : %s" % fmt(missing))
        if extra:
            print("   table/caps allow, docs do not : %s" % fmt(extra))
    else:
        print("ok  %s (%d entries)" % (label, len(a)))


def fmt(items):
    return ", ".join(str(i) for i in items)


def pair_set(pairs):
    return ["%s:%s" % (p[0], p[1]) for p in pairs]


# --- self half: rules vs the transcribed table ---------------------------------

def audit_self():
    for package in ("rp2350a", "rp2350b"):
        tx, rx = doc_uart(package)
        report("%s docs TX pins vs rule(parity)" % package,
               sorted(tx), [n for n in range(MAX_GPIO[package] + 1) if rule_tx(n)])
        report("%s docs RX pins vs rule(parity)" % package,
               sorted(rx), [n for n in range(MAX_GPIO[package] + 1) if rule_rx(n)])
        report("%s docs UART0/1 split vs ((n+4)/8)%%2" % package,
               sorted(tx.items()), sorted((n, rule_uart_inst(n)) for n in tx))
        report("%s docs UART RX instance vs rule" % package,
               sorted(rx.items()), sorted((n, rule_uart_inst(n)) for n in rx))

        pins = range(MAX_GPIO[package] + 1)
        exp_pairs = {(p[0], p[1]) for p in doc_i2c(package)}
        rule_pairs = {(s, d) for s in pins for d in pins if rule_i2c_pair(s, d)}
        report("%s docs I2C pairs vs CP test" % package, sorted(exp_pairs), sorted(rule_pairs))

        report("%s docs PWM slice/channel vs rule" % package,
               sorted(doc_pwm(package).items()),
               sorted((n, rule_pwm(n)) for n in pins))

        report("%s docs ADC window vs AnalogIn.c test" % package,
               doc_adc(package),
               [n for n in pins
                if ADC_WINDOW[package][0] <= n <= ADC_WINDOW[package][1]])

    # SPI needs no rule: the firmware ships the table, --static diffs it.


# --- static half: what still ships as data in code.py --------------------------

def parse_spi_groups(src):
    m = re.search(r"SPI_GROUPS\s*=\s*\[(.*?)\n\]", src, re.S)
    if not m:
        raise SystemExit("could not find SPI_GROUPS")
    groups = []
    for block in re.findall(r"\{[^{}]*\}", m.group(1), re.S):
        g = {}
        for key in ("sck", "mosi", "miso"):
            km = re.search(r'"\s*%s"\s*:\s*\[([^\]]*)\]' % key, block)
            g[key] = sorted(int(x) for x in re.findall(r"\d+", km.group(1))) if km else []
        groups.append(g)
    return groups


def parse_uart_inst(src):
    # probe_uart() derives the instance from a formula, so audit the formula text
    # rather than a table: pull the expression out of `def inst(n)` and evaluate it.
    m = re.search(r"def inst\(n\):\s*return ([^\n]+)", src)
    if not m:
        raise SystemExit("could not find probe_uart's inst() in %s -- the UART "
                         "instance rule is no longer where this audit reads it" % SRC)
    expr = m.group(1).strip()
    NUM_UARTS = 2  # the constant right above it in code.py; platform_defs.h says 2
    return {n: eval(expr, {}, {"n": n, "NUM_UARTS": NUM_UARTS}) for n in range(NUM_GPIO)}


def audit_static():
    src = open(SRC, encoding="utf-8").read()
    groups = parse_spi_groups(src)
    for name, exp in zip(("SPI0", "SPI1"), doc_spi()):
        i = ("SPI0", "SPI1").index(name)
        got = groups[i] if i < len(groups) else {}
        for role in ("sck", "mosi", "miso"):
            report("SPI_GROUPS[%d].%s (%s)" % (i, role, name), exp[role], got.get(role, []))

    inst = parse_uart_inst(src)
    doc_tx, doc_rx = doc_uart()
    report("code.py probe_uart instance formula (TX)",
           sorted(doc_tx.items()), sorted((n, v) for n, v in inst.items() if n in doc_tx))
    # RX rows carry the same instance in the docs, so one check covers both lanes.
    for n, v in doc_rx.items():
        if inst[n] != v:
            bad.append("probe_uart RX instance")
            print("MISMATCH probe_uart RX GP%d: docs UART%d, formula UART%d" % (n, v, inst[n]))


# --- live half: caps off the device --------------------------------------------

PROBE = '{"id":987654,"cmd":"ping","args":{"t":"AUDITNONCE"}}\r\n'
HELLO = '{"id":1,"cmd":"hello"}\r\n'


def read_all(s, secs):
    end = time.time() + secs
    buf = b""
    while time.time() < end:
        n = s.in_waiting
        buf += s.read(n) if n else b""
        if not n:
            time.sleep(0.02)
    return buf


def find_protocol_port(serial):
    for p in serial.tools.list_ports.comports():
        if p.vid != 0x2E8A:
            continue
        try:
            s = serial.Serial(p.device, 115200, timeout=0.2, write_timeout=0.5)
        except Exception:
            continue
        try:
            s.reset_input_buffer()
            s.write(PROBE.encode())
            buf = read_all(s, 0.7)
        except Exception:
            s.close()
            continue
        s.close()
        if b"AUDITNONCE" in buf:
            return p.device
    return None


def fetch_caps(serial, port):
    s = serial.Serial(port, 115200, timeout=0.2, write_timeout=0.5)
    time.sleep(0.15)
    s.reset_input_buffer()
    s.write(HELLO.encode())
    buf = read_all(s, 3.0)
    s.close()
    # The device may still be mid-broadcast; take the first complete object.
    start = buf.find(b"{")
    if start < 0:
        raise SystemExit("no JSON on %s" % port)
    return json.loads(buf[start:].split(b"\n")[0].decode("utf-8", "replace"))


def audit_live():
    try:
        import serial
        import serial.tools.list_ports  # noqa: F401  (imported for the submodule)
    except ImportError:
        raise SystemExit("pyserial missing; run with the project .venv")
    port = find_protocol_port(serial)
    if not port:
        print("NO PROTOCOL PORT - close the browser's Web Serial session, then re-run.")
        return False
    msg = fetch_caps(serial, port)
    data = msg.get("data") or (msg.get("result") or {}).get("data") or msg
    caps = data.get("caps")
    if not caps:
        print("hello reply had no caps:", json.dumps(msg)[:200])
        return False
    print("device %s version %s" % (port, data.get("version") or msg.get("version")))

    # GPS is what the BOARD DEFINITION declares as a pin, which is narrower than
    # the package: every expectation below is filtered through it, so a pin the
    # module does not bond out (or the port does not name) is not counted missing.
    gps = caps.get("gp")
    if not gps:
        # Pre-sparse-model firmware: caps.pins was a count, so the hole layout is
        # unknown and a diff against the docs would be meaningless.
        print("caps has no 'gp' - G:\\code.py predates the sparse pin model;"
              " deploy it before auditing")
        gps = list(range(caps.get("pins", NUM_GPIO)))
    print("addressable GPIOs: %s" % fmt(gps))
    print("not addressable on this board (package or board table): %s"
          % fmt([n for n in range(NUM_GPIO) if n not in gps]))
    # The ADC window is the one expectation that differs by package; pick it from
    # what the board can name (GP40 only exists on the QFN-80 part).
    package = "rp2350b" if max(gps) >= 40 else "rp2350a"
    print("package assumed from the GPIO range: %s" % package)

    exp_pairs = [p for p in doc_i2c() if p[0] in gps and p[1] in gps]
    report("caps.i2c_pairs", pair_set(exp_pairs), pair_set(caps.get("i2c_pairs", [])))
    # Every row of the F4 column carries a PWM channel, so the expectation is just
    # "whatever the board can name" -- the probe is there to catch a port change.
    report("caps.pwm", gps, caps.get("pwm", []))
    report("caps.adc (GP channels)", [n for n in gps if n in doc_adc(package)],
           [c for c in caps.get("adc", []) if c < 100])
    tx, rx = doc_uart()
    u = caps.get("uart") or {}
    report("caps.uart.tx", [n for n in sorted(tx) if n in gps], u.get("tx", []))
    report("caps.uart.rx", [n for n in sorted(rx) if n in gps], u.get("rx", []))
    got = (caps.get("spi") or {}).get("groups", [])
    for i, exp in enumerate(doc_spi(package)):
        for role in ("sck", "mosi", "miso"):
            report("caps.spi.groups[%d].%s" % (i, role),
                   [n for n in exp[role] if n in gps],
                   (got[i] if i < len(got) else {}).get(role, []))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--static", action="store_true", help="skip the live half")
    ap.add_argument("--self", dest="self_only", action="store_true",
                    help="only check the rules against the transcribed table")
    a = ap.parse_args()
    audit_self()
    if not a.self_only:
        audit_static()
        if not a.static:
            if not audit_live():
                print("(live half skipped; the static halves still ran)")
    print()
    if bad:
        print("%d check(s) disagree with the documentation: %s"
              % (len(set(bad)), fmt(sorted(set(bad)))))
        return 1
    print("All audited tables agree with the RP2350 function table / CircuitPython sources.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
