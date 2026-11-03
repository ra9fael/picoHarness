# PicoHarness

<details>

   <summary>Screenshots</summary>

   <img width="1394" height="1395" alt="Image" src="https://github.com/user-attachments/assets/6e4d0473-2a05-473c-8dbf-81bb1f20107a" />

</details>

[![中文](https://img.shields.io/badge/Lang-中文-green.svg)](./README.md) [![English](https://img.shields.io/badge/Lang-English-blue.svg)](./README.en.md)

A Pico running CircuitPython, one HTML file, the browser talking straight to the USB serial port.
This is the English copy; the Chinese version is [README.md](./README.md).

**Live** (GitHub Pages, rebuilt on every push to main): [index.html](https://ra9fael.github.io/picoHarness/)
(real hardware, needs Web Serial) · [mock.html](https://ra9fael.github.io/picoHarness/mock.html)
(no-hardware demo, works in any browser)

---

## Documentation

| Document | Contents |
| :--- | :--- |
| [User Manual](./docs/en/01_GUIApp_FW_Manual/README.md) | Setup, UI, feature-by-feature usage |
| [Protocol Reference](./docs/en/02_Library_User_Guide/README.md) | Commands, events, binary frames |
| [Example Workflows](./docs/en/03_Sample_Program_User_Guide/README.md) | Hands-on recipes and troubleshooting |
| [Build Guide](./docs/en/04_FW_Build_Guide.txt) | Build, deploy, verification chain, firmware notes |
| [Release Notes](./docs/en/05_Release_Notes.txt) | Version history |

---

## 1. Overview

A single-page browser test harness. The page talks to the board's USB CDC ports through the
**Web Serial API** — one data port for the protocol, one console port for CircuitPython; the board
runs `boot.py` plus `code.py`, and the two speak JSON-lines.
Nothing is installed on the PC, and no server is started: the deliverable is one self-contained HTML file.

Verified on Raspberry Pi Pico 2 (rp2350a), CircuitPython 10.3.1, desktop Chrome / Edge.

## 2. Features

Digital input / output, PWM, ADC (including the on-die temperature as a virtual channel), raw I2C bus
transactions, UART with live terminal tabs (hex or text rendering), raw SPI bus transactions with up to
four chip selects per bus, a scope panel for the ADC waveform
stream, and a debug console (raw serial monitor plus REPL passthrough, on the separate console port,
so a REPL session costs no port re-picking even though entering the REPL stops code.py). The UI is bilingual, flat, and
corner-free.

## 3. Quick start

```bash
npm install
npm run build          # -> dist/index.html (self-contained single file)
```

1. Flash a CircuitPython UF2 to get the CIRCUITPY volume.
2. `circup install asyncio adafruit_pioasm` — the firmware's event loop needs the first; CircuitPython does not ship
   it. The second is the PIO PWM generator's assembler and is optional: without it the hardware slices work as before
   and the UI simply hides the HW / PIO choice.
3. Copy `src/fw/boot.py` and `src/fw/code.py` to the root of the volume (remove any `main.py` there, it would win over
   `code.py`), then press RESET — `boot.py` only takes effect on a hard reset, and it is what opens the second CDC port
   and lets the board write `config.json` to its own volume. That first time needs a finger on the button; once the
   link is up the UI's **Reboot board** does the same thing, since it sends exactly the `reset` command.
4. Open `dist/index.html` in Chrome or Edge, click **Connect**, and select every entry of the board in the port picker.

Full setup, including the board-side checks: [User Manual §2](./docs/en/01_GUIApp_FW_Manual/README.md#2-prepare-the-board).

## 4. Repository layout

```
src/fw/        CircuitPython firmware (deployed to the CIRCUITPY volume)
src/ui/        UI sources (TS + CSS + HTML templates)
docs/          bilingual documentation
tools/         PC-side probe scripts (needs .venv)
build.mjs      esbuild bundling and inlining
```

## 5. Architecture

The firmware is `boot.py` plus `code.py`: boot.py only opens the second CDC port, the protocol lives in
code.py. A `COMMANDS` dispatch table routes each command to its driver, and the
`claim(n, who, force)` / `release(n)` ownership arbiter is the only entry point for hardware work, so
"one pin, one function at a time" is guaranteed by the device rather than by UI discipline. The main
loop is an asyncio task group: command reader, input-edge monitor, ADC deadband monitor, waveform
streamer, and UART RX drain. Commands and telemetry therefore never queue behind each other.

The UI is layered, and dependencies point one way, downward:

```
serial.ts             Session facade: port discovery, handshake, REPL, state machine
├─ core/ports.ts      Port identity: the two CDC ports share one VID/PID, so probe with a nonce ping
├─ core/transport.ts  Byte pipe: port ownership, mixed-stream framing (text lines + 0xAA'W' binary frames)
├─ core/rpc.ts        JSON-lines protocol: request/reply pairing, event dispatch, ready wait
model/pins.ts         Single source of truth for the workbench
workbench/            Engine + FunctionDef plugins (digital / pwm / adc / i2c / uart / scope / uartterm)
                      A new function = one def (+ driver) module registered in the defs array
core/events.ts        Minimal event emitter
```

Scheduler traps found on real hardware (blocking `stdin.read(1)`, `busio.UART` default timeout,
`flush=True` on USB CDC, the binary `usb_cdc.Serial` stream) are written up in
[04 Build Guide](./docs/en/04_FW_Build_Guide.txt); the wire format is in
[02 Protocol Reference](./docs/en/02_Library_User_Guide/README.md).

## 6. Performance limits and improvement paths

### 6.1 Why it is slow (causes)

Three ceilings stack on top of each other, bottom up:

| Layer | What the code does | Consequence |
| :--- | :--- | :--- |
| Interpreter | Everything runs on one CircuitPython VM thread; ADC sampling is per-point Python calls (`_adc_val` → `analogio.value`), never touching FIFO/DMA | The waveform stream's `ms` floor is 10 ms — row rate caps at 100 Hz, and multi-channel is just row-by-row round-robin; roughly three orders of magnitude off a DMA capture path |
| Scheduling | All five asyncio tasks are sleep-polled: commands 2 ms, UART 10 ms, GPIO 50 ms, ADC 100 ms | GPIO edges resolve at 50 ms granularity — short pulses are always missed; any one command's processing time squeezes every other task's response |
| Transport | USB full-speed 12 Mbit/s shared by both CDC ports; commands/events are JSON-lines text, and `uart_rx` ships bytes as a `list(payload)` number array | One data byte inflates to 3–4 text bytes; at high UART baud rates JSON encoding/decoding eats both CPU and bandwidth |

Only the PWM generator uses PIO (and only as an output); ADC and digital inputs have no hardware
capture path at all. So this project's strength is **determinism** (pin arbitration, protocol,
config persistence), not **throughput** — that is the product positioning, not purely an
implementation flaw.

### 6.2 Improvement paths (by increasing effort)

| Stage | What to do | What you get | What it costs |
| :--- | :--- | :--- | :--- |
| A Protocol slimming (stay on CircuitPython) | Move `uart_rx` / `spi.xfer` / `i2c.xfer` to binary frames (the kind registry already exists), batch high-rate events | CPU and bandwidth free up immediately under load | New frame kinds must land in the protocol docs too |
| B Native module | Sink the capture path into C (CircuitPython native module), raise batched samples from a DMA ring buffer | Scope bandwidth in the 10–100 kHz class | You own a C build chain; ABI risk across CircuitPython versions |
| C New firmware stack: Pico SDK + virtual NIC | TinyUSB RNDIS/ECM + lwIP + on-device HTTP/SSE (the PicoLab route); split cores: core0 serves network/UI, core1 does DMA capture; PIO for a logic analyzer | Instrument-class capture (~400 kHz analog, 100 MS/s digital), any browser, no Web Serial, works on phones | Full firmware rewrite; lose the REPL and the "copy .py and go" iteration speed; the dev cycle becomes compile-and-flash |
| D Hybrid: C firmware, same protocol | Rewrite code.py in C but keep dual CDC + JSON-lines, protocol unchanged | Capture performance up a notch; all 7220 lines of TS UI, tooling and workbench survive | No virtual-NIC browser-compatibility dividend; still a full C rewrite |

The UI already isolates the byte pipe in `core/transport.ts`, so neither C nor D touches the
workbench or model layers; under C, `mock_serial.js` also stays valid as a regression reference.
Do A first (about a week, zero hardware risk), then decide between C and D — A's binary frames
carry over into D unchanged, so it is not throwaway work.

### 6.3 Honest notes

- **Code facts**: the poll periods (2/10/50/100 ms), `ms ≥ 10`, the `uart_rx` `list(payload)`
  encoding and the shared dual-CDC link all read directly off `src/fw/code.py`; PWM down to 0.1 Hz
  is a measured value recorded in this README's roadmap.
- **Inference, not measured**: the JSON inflation is estimated at a typical 3–4 bytes per data
  byte for number arrays; "three orders of magnitude" is an architectural comparison between
  per-point Python reads and a DMA stream, not a benchmark from this repository; the 10–100 kHz
  figure for path B is industry-typical, not a measured promise.
- **External claims**: the ~400 kHz / 100 MS/s figures in the path-C row come from the PicoLab
  README's own claims and have not been re-measured here.
- Theoretical USB full-speed 12 Mbit/s is not the same as usable throughput (roughly 0.5–1
  MByte/s, shared by both ports); any bandwidth gains in the table above must be discounted to
  the latter.

## 7. Development and verification

```bash
uv venv -p 3.12 --seed -n .venv
. .venv/Scripts/activate && uv pip install pyserial
.venv/Scripts/python.exe tools/serial_probe.py        # finds both ports, picks the data one itself
```

There is no `tsconfig.json` in this repository, so `npx tsc` alone fails; the explicit type-check
command, the build/deploy steps, and the full verification chain are in
[04 Build Guide](./docs/en/04_FW_Build_Guide.txt). `npm run build` uses esbuild and does not type-check.

## 8. Roadmap

Done: Web Serial handshake loop, IO-assignment workbench (pin pool + lanes, drag to bind, automatic
displacement, instant dispatch), GPIO / PWM / ADC lanes (PWM selectable per channel between a hardware slice and a PIO state machine, measured down to 0.1 Hz), batched ADC waveform stream plus scope,
on-die temperature virtual channel, MQTT-style event subscriptions, binary-frame kind registry,
I2C bus lane with raw transactions and legal-pair probing, UART bus lane with live console terminal
tabs, SPI bus lane on the measured rp2 pin groups (half buses, up to 4 CS per bus, raw byte bench),
debug console (monitor / REPL / copy and export), browser-side configuration persistence with an
export/import/clear menu, bilingual UI, dual CDC (protocol on its own port, parallel nonce-ping port
identification with cached roles shown in the status bar and an auto-attached log port, REPL without
re-picking ports), and a device-side `config.json` — a third copy on the board's volume, written only
when you save it, resolved at connect time as board > browser > empty with a question only on a real conflict, and with
save/delete folded away when the board reports its own volume read-only (`caps.cfg.writable`) — plus a **Reboot board**
button that runs the `reset` command.

Next: standalone error panel. For the performance-limit analysis and the four improvement paths
(including the trade-offs of moving to a Pico SDK + virtual NIC stack), see
[§6 Performance limits and improvement paths](#6-performance-limits-and-improvement-paths).

## 9. License

GPL-3.0, see [LICENSE](./LICENSE). Copyright (C) 2026 ra9fael.
