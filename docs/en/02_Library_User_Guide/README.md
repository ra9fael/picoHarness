# PicoHarness Protocol Reference

This is a quick reference, not a tutorial. If you want to know how to use the harness, read the [01 User Manual](../01_GUIApp_FW_Manual/README.md) first.

Every external interface of firmware version 0.1.16-spi.

---

## 1. Transport Layer

One serial byte stream carries two kinds of frames. That stream runs on the `usb_cdc.data` port, opened by `usb_cdc.enable(console=True, data=True)` in `boot.py`; the `console` port belongs to CircuitPython again and only carries the banner, `print`, tracebacks and the REPL — never protocol bytes. Without `boot.py` on the board, `usb_cdc.data` is `None` and the protocol falls back to the single CDC port with the same framing.

### 1.1 Text Frames (JSON-lines)

One JSON object per line, terminated by `\n`. The device always writes with compact separators (`,` and `:`), so the same data looks like `{"a":1,"b":2}` rather than `{"a": 1, "b": 2}` and costs about 15% fewer bytes.

Three message types:

```jsonc
// request (host → device)
{"id": 12, "cmd": "gpio.out", "args": {"mask": 4, "vals": 4}}

// reply (device → host), id echoed back unchanged
{"id": 12, "ok": true, "data": { ... }}
{"id": 12, "ok": false, "error": "RuntimeError: pin GP7 busy"}

// event (device → host, no id, may arrive at any time)
{"evt": "gpio_in", "in": 128}
```

`error` is always a string of the form `exception class name: message`. The host does not need to parse the type; show it as is.

### 1.2 Binary Frames

Used only by the waveform stream. Frame layout:

```
0xAA  'W'  <u16le length>  <payload>
```

The first byte of the payload is the **kind**, which says which stream this is:

| kind | meaning | payload |
| --- | --- | --- |
| 1 | ADC waveform batch | `struct.pack("<BBHH", 1, nch, ms, nrows)` + `u16le[nch]` pin numbers + `u16le[nrows*nch]` sample values (row-major, one row = one sample instant) |

The device writes each whole frame atomically with `usb_cdc.data.write()`, the same port that carries the text frames, so the two kinds are ordered by construction and never interleave. Without `boot.py` the fallback writes the whole frame to `usb_cdc.console`, sharing one CDC endpoint with `print`, which preserves the same ordering guarantee.

The host does **byte-level demultiplexing of the mixed stream**: it scans for the `0xAA 'W'` magic; bytes before the magic are framed as text lines as usual, and after the magic the frame is taken by its length field. Text JSON is pure ASCII and never contains `0xAA`, so the magic cannot be mistaken for content. A frame that has not arrived in full is stashed until the next chunk completes it. Binary frames bypass the JSON layer and go straight to the handler registered for their kind.

**To add a new stream**: the firmware and the host each keep a `kind -> handler` table. Register the new kind there; the framing pipeline does not change.

---

## 2. Handshake

The device sends one event on startup:

```json
{"evt":"ready","app":"PicoHarness","version":"0.1.16-spi",
 "cp":[10,3,1],"pins":29,"gp":[0,1,2,...,22,26,27,28],
 "caps":{"pwm":[...],"adc":[...],"i2c_pairs":[[scl,sda],...],
         "uart":{"tx":[...],"rx":[...],"pairs":[[tx,rx],...]},
         "spi":{"groups":[{"sck":[...],"mosi":[...],"miso":[...]},...],
                "max_buses":2,"max_cs":4,"baud_ceiling":75000000},
         "usb":{"data":true}}}
```

| field | meaning |
| --- | --- |
| `version` | Firmware version. Check this first whenever the UI reports an error |
| `cp` | CircuitPython version as a triple |
| `pins` | Highest addressable pin number + 1 (it sizes the arrays); **not** a count of pins |
| `gp` | Array of the pin numbers this board can actually **reach** — computed from the Pin objects `board` declares, numbered out of the declared name, with an alias-only ADC pin (here `A3`) numbered `ADC_BASE + channel`; may have holes, and the UI chip pool follows it |
| `caps.pwm` | Array of pin numbers capable of PWM |
| `caps.adc` | Array of pin numbers capable of ADC, including the virtual channel `100` (internal temperature) |
| `caps.i2c_pairs` | Array of **ordered pairs**, each pair `[SCL, SDA]` |
| `caps.uart` | `tx` array, `rx` array, and `pairs`, an array of ordered pairs (`[TX, RX]`) |
| `caps.spi` | `groups`, the `sck/mosi/miso` pin arrays of each group, plus `max_buses`, `max_cs` and `baud_ceiling` |
| `caps.usb.data` | Whether the protocol runs on its own data port (true once `boot.py` has taken effect) |

### 2.0 Where the pin numbers come from: package × board definition

Two layers decide "which pins does this board have", and the UI only draws pins that pass both:

1. **The chip package.** `src/rp2350/hardware_regs/include/hardware/platform_defs.h` in pico-sdk sets `NUM_BANK0_GPIOS` to 30 for RP2350A (QFN-60, GP0..GP29) and 48 for RP2350B (QFN-80, GP0..GP47). The same file declares the ADC as `ADC_BASE_PIN=26 / NUM_ADC_CHANNELS=5` and `40 / 9` — i.e. **ADC0..ADC3 = GP26..GP29 on RP2350A, GP40..GP47 on RP2350B**. CircuitPython's `common-hal/analogio/AnalogIn.c` tests exactly that window and raises `Invalid pin` outside it.
2. **The board definition.** CircuitPython only hands you the pins that the board's `pins.c` **declares**, and a `Pin` object carries no number attribute — the number has to be read off the name. Declared names come in three shapes on the rp2350 boards: `board.GP13` (a plain GPIO), `board.GP26_A0` (the same pin, also bound as ADC channel 0) and `board.A3` (ADC channel 3, **with no `GP` token at all**). So a pin whose only names are ADC aliases is numbered `ADC_BASE + channel`, where `ADC_BASE` is the pin behind `A0` — every rp2 board spells `A0` with a GP token (`board.GP26_A0` here, `GP40_A0` on a QFN-80 part), which keeps the rule data-driven instead of hardcoded per board. On the real Pico 2 that makes the set GP0..GP29 even though `dir(board)` never shows a `GP29` attribute: GP29 is `A3` / `VOLTAGE_MONITOR`, and measured on the board it really does everything — ADC3 reads VSYS/3 (raw 31815 → 1.600 V → VSYS ≈ 4.80 V), `PWMOut` builds, `DigitalInOut` drives it, `busio.I2C(SCL=GP29, SDA=GP28)` is accepted, `busio.UART(TX=GP28, RX=GP29)` builds.
   The tables still have holes and are still narrower than the package: `raspberry_pi_pico2_w/pins.c` declares no GP23/GP24/GP25 (on that board they are `SMPS_MODE` / `LED` / `VBUS_SENSE`, names that carry neither a GP token nor an ADC channel, so they stay unreachable), and neither Raspberry Pi board table declares GP30..GP47 at all.

The firmware reads this set off `board` at boot (`gp`), and every capability array below is a subset of it: an unreachable pin appears in no pool and in no `caps` array. **So "does a Pico 2 W have GP30..GP47" answers itself: the silicon does (RP2350B package), your CircuitPython board definition does not declare it, so the harness cannot reach it — and the day a build you use declares it, the pool grows on its own, because nothing in the firmware hardcodes a pin count.**

How a hole behaves on the wire: the range check uses the contiguous bound `0..NUM_PINS-1`, so a number inside that span that the board definition never declared passes the range check and then fails in `_pin()` as `ValueError: board has no GP23`; the `gpio.cfg` mask expands pin by pin and simply skips a hole, no error. The UI renders from `caps.gp`, so ordinary use never reaches either path.

The PWM / ADC / I2C-pair parts of `caps` are **probed** — build an object on every pin, enumerate the candidate ordered pairs and actually build them — while UART is **computed from the documentation** at boot: even pins TX, odd pins RX, instance `((n+4)//8) % NUM_UARTS`, all three taken from CircuitPython's own algorithm in `common-hal/busio/UART.c`. SPI is covered below. The sweep runs once at boot and the result is cached; `hello` serves that cache.

**SPI is the one static table**: the GP0..GP28 rows of `SPI_GROUPS` were measured combination by combination with `tools/spi_probe.py` on CircuitPython 10.3.1 / Pico 2 (53 accepted, 1571 `Invalid pins`) and agree **row for row** with the F1 column of pico-sdk `hardware/gpio.h`; the GP30..GP47 rows come from that same table (QFN-80-only rows), cannot be reached on a 30-pin board and therefore never reach the UI — the firmware projects the table onto `gp` before sending `caps.spi`. There is no boot-time SPI sweep: the exhaustive version is 1600+ constructor calls and takes minutes, while the answer is a property of the silicon, not of the wiring, so scanning would never change it.

On connect, the two CDC ports share one VID/PID, so `getInfo()` cannot tell them apart: the host pings **all** already-authorized ports in parallel and takes the one that echoes its nonce back as the protocol port (zero clicks). Connection starts on the first positive answer instead of waiting the silent ports out to their timeout. Role verdicts are cached for 4 s, so asking about the same ports again in one connect (the log-port attach right after) costs no new probe and a reconnect does not pay another round of timeouts. It then sends `hello` to fetch the payload above, without restarting the device; when `hello` is not answered (older firmware), reading the payload takes the restart path below too. When none of the authorized ports replies — `code.py` is not running, stopped at the REPL or crashed — it falls back to the legacy path: send `Ctrl+C` and `Ctrl+D` to the port that actually showed device traffic during the probe (`usb_cdc.data` ignores control bytes, which is why the candidate is ranked by who made noise), then wait for the `ready` line. That restart invalidates the "not the protocol port" verdicts, so the cache is dropped and the ports are asked again — no second port picker in between. If the device program restarts while the link is already up (RESET button, or `code.py` saved from Explorer), it broadcasts another `ready`; the UI shows it as "device program restarted" and refreshes the capability table.

### 2.1 Pin Legality for I2C, UART and SPI

For these functions the pins **do not combine freely**, and legality is a property of the set, not of a single pin:

- **I2C (rp2 uses the hardware peripheral, not PIO)**: `common-hal/busio/I2C.c` only knows the two Synopsys DW_apb_i2C hardware instances (`NUM_I2CS = 2`), and the test it applies is that one line in its own source: `scl % 2 == 1 && sda % 2 == 0 && (scl / 2) % 2 == (sda / 2) % 2` — SCL an odd GP, SDA an even GP, both on the same instance (equivalent to `SDA ≡ SCL-1 (mod 4)`, but **the two pins do not have to be adjacent**: GP1/GP0, GP1/GP4 and GP1/GP8 are all legal pairs). Anything else raises `Invalid pins`; there is no PIO or bit-bang fallback. So GP8/GP10 (both even) can never form a bus. The frequency ceiling is 1 MHz, validated in that same source. On this board the rule also reaches GP29: `busio.I2C(SCL=GP29, SDA=GP28)` was measured as accepted (it then reports the missing pull-up, which is a wiring condition), and `caps.i2c_pairs` accordingly carries the eight pairs with SCL 29.
- **UART (rp2 hardware peripheral, not PIO)**: there are only two instances, UART0 and UART1. The rule lives in `common-hal/busio/UART.c`: **every even pin can be TX, every odd pin can be RX**, and the mux function is chosen by the pin number — `n % 4 == 0` (TX) or `n % 4 == 1` (RX) uses F2 `GPIO_FUNC_UART`, `n % 4 == 2` (TX) or `n % 4 == 3` (RX) uses F11 `GPIO_FUNC_UART_AUX` (this second mux group only exists on RP2350). The instance number is `((n + 4) / 8) % NUM_UARTS`, and both ends of a full-duplex pair must land on the same one — measured on this board: `busio.UART(TX=GP28, RX=GP29)` builds, while `busio.UART(TX=GP28, RX=GP27)` raises `Invalid pins` because 28 lands on UART0 and 27 on UART1. Taken one at a time each pin is fine, and that is what `caps.uart.tx` / `caps.uart.rx` list; only `caps.uart.pairs` applies the instance test. **GP0(TX) / GP1(RX) belong to UART0**: under the old single-port build they measured as taken by the CircuitPython serial console, while on this dual-CDC firmware they build a bus normally, so they are listed in `caps.uart` like any other pin.

- **SPI (rp2 hardware peripheral)**: `caps.spi.groups` lists two pin groups, and **SCK/MOSI/MISO must all come from one group** — a set that spans groups makes `busio.SPI()` raise `Invalid pins`. The two groups are also the two peripherals (`NUM_SPIS = 2`), so at most `caps.spi.max_buses` buses can be live at once (a third measured as `SPI peripheral in use`). SCK is mandatory: passing it alone measures as `Must provide MISO or MOSI pin`, while a half bus that has SCK and only MOSI, or only MISO, builds fine. The complete table over all RP2350 pin numbers is:

  | peripheral | SCK | MOSI(TX) | MISO(RX) |
  | --- | --- | --- | --- |
  | SPI0 | 2, 6, 18, 22, 34, 38 | 3, 7, 19, 23, 35, 39 | 0, 4, 16, 20, 32, 36 |
  | SPI1 | 10, 14, 26, 30, 42, 46 | 11, 15, 27, 31, 43, 47 | 8, 12, 24, 28, 40, 44 |

  The 30..47 entries are QFN-80-only rows and never show up on a 30-pin board (`caps.spi.groups` has already been projected onto `gp`). **CS is not in that table**: this port's `busio.SPI` does not handle chip select, so the firmware drives each CS as a plain output, which means any free GP can be a CS, up to `caps.spi.max_cs` of them.

The host-side rule:

| function | is one pin enough | when the set is checked |
| --- | --- | --- |
| I2C | No, both SDA and SCL must be filled | Only when both are filled, via `i2cPairOk` |
| UART | **Yes**, send-only or receive-only is a legitimate use | Only when both are filled, via `uartPairOk` |
| SPI | **Half**: SCK is mandatory, one of MOSI/MISO is enough | Every time a data pin is filled, via `spiSetOk` (same group) |

---

## 3. Command Reference

24 commands. Except for `ping` / `echo`, the `data` of a successful reply is normally the state object described in section 4.

### 3.1 General

| command | arguments | returns |
| --- | --- | --- |
| `ping` | none (`t` echoed back) | `{"pong": <t>}` |
| `hello` | none | `data` = the boot `ready` payload (app/version/cp/pins/gp/caps), so a host that joined after startup can learn the capabilities without rebooting the device |
| `echo` | anything | The args echoed back verbatim; for self-tests |

### 3.2 GPIO

| command | arguments | notes |
| --- | --- | --- |
| `gpio.cfg` | `in` `out` `pd` `pn` (all bit masks) | Incremental configuration of direction and pulls. Pins held by PWM/ADC/I2C/UART are skipped automatically and never stolen |
| `gpio.out` | `mask` `vals` | Bitwise output write: `mask` selects which pins to touch, `vals` supplies their values |
| `gpio.state` | none | Returns the full state object; the host uses it for reconciliation |

A mask bit is `1 << pin number`. The pulls are tri-state: a bit set in `pd` is pull-down, a bit set in `pn` is none, and a bit clear in both is pull-up (the default).

### 3.3 PWM

| command | arguments | notes |
| --- | --- | --- |
| `pwm.cfg` | `pin`, `freq`(default 1000), `duty`(default 0.5) | Start or re-parameterize. `freq` is in Hz and takes integer values only; below 1 it is rejected outright. `duty` takes 0..1 |
| `pwm.stop` | `pin` | Stop and release the pin |

When the frequency changes, the firmware `deinit`s the object and rebuilds it. On rp2, writing `.frequency` directly raises `Invalid variable_frequency`, so this works around a defect in the hardware library.

The rp2 divider cannot honour every integer you ask for: it only generates 125 MHz/(div×(top+1)), so the measured floor is 9 Hz (1..8 Hz all land on 9) and higher requests quantize (1000→990, 2000→2035). The reply therefore carries `pwm.<pin>.hfreq` = the frequency the slice really runs at, next to `freq` = what you requested; the UI turns the box amber and writes one log line when they differ.

Two pins of one slice (GP24/GP25 = slice 4, since slice = `(n // 2) mod 8`) cannot hold separate frequencies: the second `pwm.cfg` fails with `RuntimeError: Conflicting settings for shared resource`, and the firmware hands the pin's ownership back instead of leaving it half-claimed. See [01 User Manual](../01_GUIApp_FW_Manual/README.md#43-pwm).

### 3.4 ADC

| command | arguments | notes |
| --- | --- | --- |
| `adc.cfg` | `pin` | Claim as AnalogIn. `pin=100` is the virtual channel for the internal temperature |
| `adc.stop` | `pin` | Stop and release |
| `adc.stream` | `on`, `pins[]`, `ms`(≥10, default 50), `batch`(1..100, default 20), `fmt`(`json`\|`bin`) | Turn the waveform stream on or off. `on:false` stops it. `pins` may include 100 |

While `adc.stream` is running, the deadband push events (`adc`) are muted automatically and data comes from `adc_w` batch frames instead, so the two paths never flood the link at the same time.

**Temperature channel**: this CircuitPython build does not expose `board.TEMPERATURE_SENSOR`. The firmware reads `microcontroller.cpu.temperature` (degrees Celsius, float) and inverts the datasheet curve into an equivalent raw16:

```
v = 0.706 - (t - 27) * 0.001721
raw = v / 3.3 * 65535
```

Temperature then reuses the existing u16 pipeline unchanged: events, stream, binary frames and the waveform buffer all keep the same data shape. The host recovers degrees Celsius with per-channel `k·x+b` correction. Resolution is about 0.03°C/LSB.

### 3.5 I2C

| command | arguments | notes |
| --- | --- | --- |
| `i2c.cfg` | `id`, `sda`, `scl`, `freq`(default 100000) | Create the bus. If the parameters match the current ones exactly, return directly without rebuilding |
| `i2c.release` | `id` | Release the bus and its two pins |
| `i2c.scan` | `id` | `{"addrs": [address...]}` |
| `i2c.xfer` | `id`, `addr`(0..127), `w`(byte array), `r`(byte count to read, 0..4096), `rep_start`(bool) | Raw transaction |

The three shapes of `i2c.xfer`:

| `w` | `r` | `rep_start` | bus action |
| --- | --- | --- | --- |
| yes | 0 | — | `writeto` |
| 0 | yes | — | `readfrom` |
| yes | yes | true | `writeto_then_readfrom` (write the register pointer, repeated start, then read) |

The reply is `{"rd": [byte...]}`; if nothing was read it is an empty array.

If the bus is created while both lines are idle and not high, the device reports `No pull up found`. That is a **wiring or pull-up resistor problem**, not a wrong pin choice, and the UI says so.

### 3.6 UART

| command | arguments | notes |
| --- | --- | --- |
| `uart.cfg` | `id`, `tx`(-1 means not connected), `rx`(-1 likewise), `baud`(default 115200) | Create the bus. An error if `tx` and `rx` are both -1 |
| `uart.release` | `id` | Release |
| `uart.write` | `id`, `data`(byte array) | Returns `{"written": n}` |
| `uart.read` | `id`, `n`(0..4096) | Returns `{"rd": [byte...]}` |

Bus objects are created **non-blocking** (`timeout=0`), so `uart.read` returns whatever has already arrived and never waits idle. Internally, manual reads briefly set a bounded 200 ms wait and restore non-blocking immediately afterwards; otherwise the read would hold up the event-stream task.

With `tx` = -1, `uart.write` reports `this bus has no TX pin`; the same applies to `uart.read` with `rx` = -1.

### 3.7 SPI

| command | arguments | notes |
| --- | --- | --- |
| `spi.cfg` | `id`, `sck`, `mosi`(-1 means not connected), `miso`(-1 likewise), `cs`(array of pins, at most `caps.spi.max_cs`), `baud`(default 100000), `mode`(default 0, CPOL/CPHA) | Create the bus. Arguments identical to the current bus return immediately without rebuilding |
| `spi.release` | `id` | Release the bus and every one of its members, including each CS |
| `spi.xfer` | `id`, `w`(byte array), `r`(byte count 0..4096), `cs`(index into `cs`, -1 keeps every CS high), `hold`(bool, leave CS low afterwards) | Full-duplex raw transaction |

`spi.cfg` validates in this order, and errors arrive in the same order:

| # | exact message | when |
| --- | --- | --- |
| 1 | `busio.SPI on rp2 needs at least a MOSI or a MISO pin` | `mosi` and `miso` are both -1 (a lone SCK cannot run) |
| 2 | `mode must be 0..3 (CPOL/CPHA)` | `mode` out of range |
| 3 | `at most %d CS lines per bus` | more `cs` entries than `SPI_MAX_CS` |
| 4 | `pin out of range` | a pin number outside 0..`NUM_PINS-1` (`NUM_PINS` = highest named pin + 1, see 2.0) |
| 5 | `one pin cannot hold two SPI roles` | the same pin appears twice among SCK/MOSI/MISO/CS |
| 6 | `SPI GP%d(SCK)/GP%d(MOSI)/GP%d(MISO) is not a routable set: ...` | the three data pins do not come from one group |
| 7 | `GP%d already belongs to SPI bus %d — release it first` | the pin is held by another live SPI bus |
| 8 | `could not build SPI on GP%d/GP%d/GP%d: ...` | the underlying `busio.SPI` construction failed; the usual inner message is `SPI peripheral in use` |
| 9 | `SPI GP%d configure failed: ...` | `configure()` failed once the lock was held |

Rule 7 cannot be left to `claim()`: both buses would write `owner[] = "spi"`, so the claim
would succeed silently, the construction afterwards would fail, and the rollback would clear
the claim on a pin **the other bus is still driving**.

`spi.xfer` replies with:

```json
{"rd": [byte...], "cs": selected index, "held": whether CS stayed low, "hbaud": actual clock, "mode": mode}
```

`w` and `r` may be given singly or together (write N bytes while reading N back). `cs` is an **index**, not a pin number: `0` drives the first entry of the `cs` array, and `-1` keeps every CS high, which is what you want for a pure clock grab. `hold: true` is for segmented transactions — CS does not come up, so the next `spi.xfer` continues the same selection; send one more with `hold: false` afterwards to put it back.

This port has exactly one full-duplex call, `write_readinto()`, and it wants two equal-length buffers, so the firmware pads a short write with `0xFF` idle clocks and hands back only the first `r` bytes of a longer read:

```python
n = max(len(w), rlen)          # clock count is the larger of the two
tx = bytearray(b"\xff" * n); tx[:len(w)] = w
obj.write_readinto(tx, rx); rd = rx[:rlen]
```

`hbaud` is **the clock the divider actually produced**, not the one you requested. The rp2 divides the 150 MHz system clock by an **even** integer, ceiling 75 MHz (`caps.spi.baud_ceiling`), so 9600 comes out as 9599 Hz, 2 MHz as 1973684 Hz, and 10 MHz as 9375000 Hz. The same honesty the PWM lane applies with `hfreq`.

### 3.8 Event Subscription

MQTT-style switches that control what the device pushes on its own.

| command | arguments | notes |
| --- | --- | --- |
| `sub` | `topic`(string), `params`(optional object) | Subscribe. **Replies with a retained snapshot immediately**, so the host need not wait for the next change |
| `unsub` | `topic` | Unsubscribe; returns `{"unsub": topic}` |

| topic | parameters | what it gates |
| --- | --- | --- |
| `gpio.in` | `mask`, `min_ms` | Input-level events. **Strictly gated**: no subscription, no push at all |
| `adc.<pin>` | `deadband` | Deadband sensitivity of that channel's ADC events |
| `uart.<bus id>` | none | The RX byte stream of that bus |

Note the asymmetry in the ADC design: ADC has **no** polling fallback, so `adc_monitor` always reports every configured channel; subscribing only tunes the deadband and triggers the retained snapshot, it is not a switch. GPIO is strictly gated, because the 1 s `gpio.state` reconciliation poll refreshes input state anyway.

---

## 4. The state Object

What `gpio.state` returns, and the `data` of most other commands.

| field | type | meaning |
| --- | --- | --- |
| `in` | bit mask | Current input levels (only pins configured as inputs) |
| `out` | bit mask | Current output latch values |
| `cfg_in` | bit mask | Pins configured as inputs |
| `cfg_out` | bit mask | Pins configured as outputs |
| `cfg_pd` | bit mask | Input pins with pull-down enabled |
| `cfg_pn` | bit mask | Input pins set to no pull |
| `cfg_pwm` | bit mask | Pins held by PWM |
| `pwm` | object | `{"<pin>": {"freq": f, "hfreq": h, "duty": d}}` — `hfreq` is what the slice actually generates |
| `cfg_adc` | bit mask | Pins held by ADC, **physical** pins only (the virtual temperature channel is excluded) |
| `adc_temp` | bool | Whether the temperature channel is enabled |
| `cfg_i2c` | bit mask | Pins held by I2C |
| `i2c` | array | `[{"id":i,"sda":n,"scl":n,"freq":h}, ...]` |
| `cfg_uart` | bit mask | Pins held by UART |
| `uart` | array | `[{"id":i,"tx":n,"rx":m,"baud":h}, ...]` (the side that is not connected is -1) |
| `cfg_spi` | bit mask | Pins held by SPI, **including every CS** |
| `spi` | array | `[{"id":i,"sck":n,"mosi":n,"miso":n,"cs":[n,...],"baud":h,"hbaud":h,"mode":m}, ...]` (a side that is not connected is -1) |

The host compares this state against its own expectations and re-sends the configuration whenever it finds drift. That is the mechanism that lets the board heal itself even after it was rebooted. The bus arrays (`i2c` / `uart` / `spi`) take part in the drift comparison as a signature built from sorted `id:member,member,...` entries; the SPI signature carries the CS order, `baud` and `mode`, so losing one CS line also reads as drift. `hbaud` is the clock the divider actually reached, while the value you requested stays in `baud` — the two may differ.

---

## 5. Event Overview

| event | payload | trigger |
| --- | --- | --- |
| `ready` | see section 2 | Device startup |
| `gpio_in` | `{"in": mask}` | `gpio.in` subscribed and the level changed |
| `adc` | `{"vals": {"pin": raw}}` | Any configured channel moved past its deadband since the last push (about 0.5% by default, overridable per subscription) |
| `adc_w` | `{"pins":[], "ms":n, "v":[[..]]}` or a binary frame | Waveform stream running; one frame per `batch` rows collected |
| `uart_rx` | `{"id": bus id, "data": [byte...]}` | That bus subscribed and bytes arrived |
| `dbg` | `{"task":name, "alive":true}` or `{"task":name,"err":"..."}` | Task liveness report / exception inside a task |

`dbg` is for debugging, and it exists for a concrete reason: `gather` swallows exceptions from child tasks, so a dead monitor coroutine shows no symptom on the surface. Each task reports `alive` once when it first enters its loop, and `err` when it catches an exception. When a feature suddenly stops moving, look for `dbg` events first.

On startup the device also emits one terminal-title escape sequence (OSC, `ESC ] 0 ; ... ESC \`), glued to the front of `ready` and carrying no newline. Strip the ANSI codes before extracting the JSON; the host does this by finding the first `{` and parsing from there.

---

## 6. Pin Ownership

Every hardware operation is arbitrated through one `owner[]` table:

- `claim(pin, function, force)` — take the pin. With `force=true` you may steal a pin from its current owner (PWM/ADC/bus configuration uses this).
- `release(pin)` — release it.
- When a function releases its bus or channel, it clears only the entries where `owner[pin]` is itself, so it never frees another function's pins.

So "a pin belongs to one function" is guaranteed by the firmware, not by UI discipline. Reloading the page or opening two windows at once cannot leave both sides convinced the pin is theirs.

The three bus functions are named `"i2c"`, `"uart"` and `"spi"`. SPI registers SCK, MOSI, MISO and **each CS line** under the same `owner="spi"`, because `busio.SPI` has no per-pin release — letting go of any one member tears the whole bus down, and `spi.release` only accepts a bus id. CS counting as "occupied" has a concrete reason: it is an ordinary output line, so if the UI allowed `gpio.set` on it, the host could select or release a device in the middle of a transaction.

---

## 7. Versioning and Compatibility

The `version` field is the first thing to compare when deciding whether the device lags the host.

If the UI reports `unknown cmd: xxx`, or the `gpio.state` reply is missing fields such as `cfg_uart` / `uart`, then almost always **the board is still running an old `code.py`**; the host is not at fault. Check `version` first, and re-copy `code.py` if needed.

When an old firmware has no `caps.i2c_pairs` / `caps.uart` / `caps.spi`, the host's pin validation relaxes and lets the choice pass. The device is the final arbiter anyway, and a pairing that does not work reports a clear error. SPI is the clearest case: without `caps.spi.groups` any pin combination can be placed, and it is `spi.cfg`'s "not a routable set" error that closes the loop; the CS and bus limits fall back to their defaults of 4 lines and 2 buses, and the UI stops filtering the clock presets by ceiling.
