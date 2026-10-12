# PicoHarness Protocol Reference

This is a quick reference, not a tutorial. If you want to know how to use the harness, read the [01 User Manual](../01_GUIApp_FW_Manual/README.md) first.

Every external interface of firmware version 0.1.14-uart01.

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
{"evt":"ready","app":"PicoHarness","version":"0.1.14-uart01",
 "cp":[10,3,1],"pins":29,
 "caps":{"pwm":[...],"adc":[...],"i2c_pairs":[[scl,sda],...],
         "uart":{"tx":[...],"rx":[...],"pairs":[[tx,rx],...]},
         "usb":{"data":true}}}
```

| field | meaning |
| --- | --- |
| `version` | Firmware version. Check this first whenever the UI reports an error |
| `cp` | CircuitPython version as a triple |
| `pins` | Total pin count; the UI chip count follows this value |
| `caps.pwm` | Array of pin numbers capable of PWM |
| `caps.adc` | Array of pin numbers capable of ADC, including the virtual channel `100` (internal temperature) |
| `caps.i2c_pairs` | Array of **ordered pairs**, each pair `[SCL, SDA]` |
| `caps.uart` | `tx` array, `rx` array, and `pairs`, an array of ordered pairs (`[TX, RX]`) |
| `caps.usb.data` | Whether the protocol runs on its own data port (true once `boot.py` has taken effect) |

`caps` is **probed**, not hardcoded: PWM and ADC are found by trying to build an object on every pin, I2C by exhausting the ordered pairs, UART from the fixed pin table in the RP2350 datasheet. So a different board, or pins claimed by someone else, is reflected in the UI as the board's true capability. The sweep runs once at boot and the result is cached; `hello` serves that cache.

On connect, the two CDC ports share one VID/PID, so `getInfo()` cannot tell them apart: the host pings **all** already-authorized ports in parallel and takes the one that echoes its nonce back as the protocol port (zero clicks). Connection starts on the first positive answer instead of waiting the silent ports out to their timeout. Role verdicts are cached for 4 s, so asking about the same ports again in one connect (the log-port attach right after) costs no new probe and a reconnect does not pay another round of timeouts. It then sends `hello` to fetch the payload above, without restarting the device; when `hello` is not answered (older firmware), reading the payload takes the restart path below too. When none of the authorized ports replies — `code.py` is not running, stopped at the REPL or crashed — it falls back to the legacy path: send `Ctrl+C` and `Ctrl+D` to the port that actually showed device traffic during the probe (`usb_cdc.data` ignores control bytes, which is why the candidate is ranked by who made noise), then wait for the `ready` line. That restart invalidates the "not the protocol port" verdicts, so the cache is dropped and the ports are asked again — no second port picker in between. If the device program restarts while the link is already up (RESET button, or `code.py` saved from Explorer), it broadcasts another `ready`; the UI shows it as "device program restarted" and refreshes the capability table.

### 2.1 Pin Legality for I2C and UART

For these two functions the pins **do not combine freely**, and legality is a property of the pair, not of a single pin:

- **I2C (rp2 goes through PIO)**: `SCL` must be an odd GP, `SDA` must be an even GP, and `SDA ≡ SCL-1 (mod 4)` must hold. So GP8/GP10 (both even) can never form a bus.
- **UART (rp2 hardware peripheral, not PIO)**: there are only two instances, UART0 and UART1. Even pins can be TX, odd pins can be RX; for full duplex the two pins must sit on the same instance. **GP0(TX) / GP1(RX) belong to UART0**: under the old single-port build they measured as taken by the CircuitPython serial console, while on this dual-CDC firmware they build a bus normally, so they are listed in `caps.uart` like any other pin.

The host-side rule:

| function | is one pin enough | when the pair is checked |
| --- | --- | --- |
| I2C | No, both SDA and SCL must be filled | Only when both are filled, via `i2cPairOk` |
| UART | **Yes**, send-only or receive-only is a legitimate use | Only when both are filled, via `uartPairOk` |

---

## 3. Command Reference

21 commands. Except for `ping` / `echo`, the `data` of a successful reply is normally the state object described in section 4.

### 3.1 General

| command | arguments | returns |
| --- | --- | --- |
| `ping` | none (`t` echoed back) | `{"pong": <t>}` |
| `hello` | none | `data` = the boot `ready` payload (app/version/cp/pins/caps), so a host that joined after startup can learn the capabilities without rebooting the device |
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
| `pwm.cfg` | `pin`, `freq`(default 1000), `duty`(default 0.5) | Start or re-parameterize. `freq` is in Hz and takes integer values only, with a physical floor of about 7.4; `duty` takes 0..1 |
| `pwm.stop` | `pin` | Stop and release the pin |

When the frequency changes, the firmware `deinit`s the object and rebuilds it. On rp2, writing `.frequency` directly raises `Invalid variable_frequency`, so this works around a defect in the hardware library.

Two pins in the same slice share one frequency and overwrite each other; see [01 User Manual](../01_GUIApp_FW_Manual/README.md#43-pwm).

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

### 3.7 Event Subscription

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
| `pwm` | object | `{"<pin>": {"freq": f, "duty": d}}` |
| `cfg_adc` | bit mask | Pins held by ADC, **physical** pins only (the virtual temperature channel is excluded) |
| `adc_temp` | bool | Whether the temperature channel is enabled |
| `cfg_i2c` | bit mask | Pins held by I2C |
| `i2c` | array | `[{"id":i,"sda":n,"scl":n,"freq":h}, ...]` |
| `cfg_uart` | bit mask | Pins held by UART |
| `uart` | array | `[{"id":i,"tx":n,"rx":m,"baud":h}, ...]` (the side that is not connected is -1) |

The host compares this state against its own expectations and re-sends the configuration whenever it finds drift. That is the mechanism that lets the board heal itself even after it was rebooted. The bus arrays (`i2c` / `uart`) take part in the drift comparison as a signature built from sorted `id:primary,secondary,clock` entries.

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

---

## 7. Versioning and Compatibility

The `version` field is the first thing to compare when deciding whether the device lags the host.

If the UI reports `unknown cmd: xxx`, or the `gpio.state` reply is missing fields such as `cfg_uart` / `uart`, then almost always **the board is still running an old `code.py`**; the host is not at fault. Check `version` first, and re-copy `code.py` if needed.

When an old firmware has no `caps.i2c_pairs` / `caps.uart`, the host's pin validation relaxes and lets the choice pass. The device is the final arbiter anyway, and a pairing that does not work reports a clear error.
