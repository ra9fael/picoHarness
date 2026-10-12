# PicoHarness User Manual

This manual gets PicoHarness running from an empty desk and walks each feature in turn.
If you only care about connecting wires and driving the UI, this is the only document you need.
For protocol details see [02 Protocol Reference](../02_Library_User_Guide/README.md). For recipes and error lookups see [03 Example Workflows](../03_Sample_Program_User_Guide/README.md).

---

## 1. What PicoHarness Is

One Pico board plus one web page make a desktop test fixture.

- The PC-side deliverable is a **single HTML file**. Double-click it and you are working: no Python, no drivers, no local server.
- The page connects to the Pico's USB serial ports through the browser's **Web Serial API**.
  The board exposes two CDC ports: the data port carries the JSON protocol between the page and the
  board, the console port stays CircuitPython's own (`print`, tracebacks, REPL). The page works out
  which is which on its own — you never have to guess a COM number.
- The board runs one CircuitPython `code.py`. It receives JSON commands, drives pins, and pushes readings back.

What you can do: switch pins, measure voltage, generate PWM, scan an I2C bus, and send UART, plus a scope panel and a debug console you can type into.

Verified environment: Raspberry Pi Pico 2 (rp2350a), CircuitPython 10.3.1, desktop Chrome or Edge.

---

## 2. Prepare the Board

### 2.1 Flash CircuitPython

Download the UF2 from <https://circuitpython.org/board/raspberry_pi_pico2/>. Use the matching board page if you are on different hardware.

1. Power the board off: unplug the USB cable.
2. Hold the BOOTSEL button on the board, plug the cable back into the PC, then release the button.
3. A USB drive named `RPI-RP2` appears on the PC.
4. Drag the `.uf2` file onto that drive. The board reboots on its own.
5. After the reboot a drive named `CIRCUITPY` appears. That means the flash succeeded.

### 2.2 Install Firmware Dependencies

The event loop in `code.py` needs the `asyncio` library, which CircuitPython does not ship. Without it, a serial terminal
reports `ImportError: no module named 'asyncio'`.

The least effort route is circup, installed once on the PC:

```bash
pip install circup
circup install asyncio
```

circup puts `asyncio` and its dependency `adafruit_ticks` into the `lib/` directory of the CIRCUITPY volume, in versions that
match your CircuitPython.

If you would rather not install circup, download the [Library Bundle](https://circuitpython.org/libraries) by hand and copy the
`asyncio` directory and `adafruit_ticks.mpy` into `CIRCUITPY/lib/`.

### 2.3 Deploy the Firmware

The firmware is two files; copy both into the root of the CIRCUITPY volume, overwriting files of the same name:

- `src/fw/boot.py` does exactly one thing — `usb_cdc.enable(console=True, data=True)` — which splits the USB serial into a
  "console" port and a "data" port.
- `src/fw/code.py` is the fixture itself. It receives JSON commands, drives pins, and pushes readings back.

`boot.py` **only takes effect after a hard reset**: press the board's RESET button, or unplug and replug the USB cable. A
Ctrl-D soft reboot does not re-run it, so hard-reset once after copying — Device Manager showing two COM ports means it worked.

If the root contains a `main.py`, delete it or rename it: CircuitPython runs `main.py` and would never touch `code.py`.

When the copy finishes, the board reboots and starts running. This step installs nothing on the PC.

> Every later change to `code.py` is the same move: copy it over and the board reboots itself.
> The reboot drops the browser's serial connection, so reconnect. Changing `boot.py` needs one extra step: a hard reset.

---

## 3. Open the Host App

Take `dist/index.html` (see [04 Build Guide](../04_FW_Build_Guide.txt) for how to build it yourself) and open it in Chrome or Edge
by double-clicking. It works straight from `file://`; you do not need a local server.

Click **Connect** at the top of the page. Both CDC ports share one vendor/product ID, so the browser cannot name them and
the page identifies them by asking: it pings **every** authorized port at once and keeps the one that echoes back its nonce —
that is the data port. Verdicts are cached for 4 seconds, so reconnecting is near-instant.

- First time: the browser opens a port picker. Select **every** entry of the board (usually shown as
  `USB Serial Device`, or as entries carrying the `2E8A` vendor ID — a dual-CDC board lists two), so the page is authorized
  for both and the picker never appears again.
- Later visits: reconnection costs zero clicks, the ports are already authorized.
- If the device program is not running (stopped at the REPL, or crashed): the page sends `Ctrl+C` + `Ctrl+D` on the port
  that actually showed device traffic during the probe — the data port ignores control bytes, which is why the candidate is
  picked by who made noise — then looks for the protocol port again. It does **not** open a second picker: authorized ports
  that stay silent only mean `code.py` is not running.

The handshake reads the board's capability table with the `hello` command, so the device program does not have to restart.

After a successful connection:

- The status light turns green, reading e.g. `Connected · dual CDC · log port ✓`. The middle segment tells you whether the
  board really is dual-CDC or `single port (legacy)`; the last is the log port, and `log port not attached` means one click
  on **Attach log port** is left to do. On a dual-CDC board the page attaches the log port by itself right after the
  handshake, so normally you touch nothing.
- The console below prints the handshake.
- The pin chips on the workbench gain capability badges (P = PWM, A = ADC, S/D = I2C, T/R = UART).

Those badges come **from the board itself**; they are not hardcoded in the page. Swap in another board, or let some other owner
claim a pin, and the UI reflects it truthfully. You never get a pin that looks usable but is not.

A board with a single CDC port (no `boot.py`, or one that never got a hard reset) shows `Connected · single port (legacy)`
plus a standing banner at the top of the page:

> Legacy mode: this board exposes one CDC port, so the device's print() output shares it with the protocol. Put boot.py on CIRCUITPY and press RESET (hard reset) to split it in two; single-port mode is not supported in the next release.

Single-port still works in this release — protocol and `print` squeeze through one port, and the log-port button stays
disabled with "A single-port board has no separate console port; install boot.py and press RESET (hard reset) to get one" —
but do not build on that shape: the next release is dual-port only.

To disconnect, click the same button again (its label changes to "Disconnect").

---

## 4. The Workbench

The workbench is the main view, split into a top half and a bottom half:

- On top, the **pin pool** lays out every GP pin the board can **reach**. Each chip shows the pin name and its capability badges.
  The list comes from the device's boot-time `caps.gp` (see [02 §2.0](../02_Library_User_Guide/README.md)), so the pool may have
  holes: on a Pico 2 W, GP23/GP24/GP25 belong to the CYW43 and that board's table does not declare them at all. GP29 is the other
  direction — it is never spelled "GP29" on a Pico 2 (its names are `A3` / `VOLTAGE_MONITOR`), yet the firmware works out its
  number from the ADC alias, so it is in the pool. A pin the pool does not have is a pin the UI never offers you.
- Below it, the **lanes**, one per function: digital input, digital output, PWM, ADC, I2C, UART, SPI.

Binding a pin has two forms, pick whichever you prefer:

| Action | Result |
| --- | --- |
| Drag a chip into a lane | Binds that pin to the function |
| Click a chip, then click the lane | Same |
| Click the × on a chip | Releases that pin |
| Drag a chip back into the pin pool | Same |

There is one rule: **a pin belongs to one function at a time**. Drag a pin that is already doing PWM into the ADC lane and it
leaves the PWM lane by itself; you do not unbind it first. The firmware does this arbitration, so two people can keep two pages
open against the same board without both believing the pin is theirs.

Every change **takes effect immediately and is sent to the board**. There is no Save or Apply button.

### 4.1 Digital Input

Drag a pin into the digital input lane. A small dot appears on the chip and follows the pin level in real time (lit = high).

Click the dropdown on the chip to choose pull-up / pull-down / none. The default is pull-up, which means a floating pin reads high.

Level changes are pushed by the board to the page, so the response is fast. The page also reconciles once per second, so if the
board was rebooted the configuration is replayed back to it automatically.

### 4.2 Digital Output

Drag a pin into the digital output lane. A clickable level block appears on the chip; click it to toggle between high and low.

### 4.3 PWM

Drag a pin into the PWM lane, then set the frequency and the duty cycle.

The ▾ button next to the frequency field opens a preset grid from 1 to 1000. Pick a number, then set the magnitude with the unit
dropdown on the right (mHz / Hz / kHz / MHz). So "50kHz" costs two clicks: 50, then kHz.

Duty cycle is a number between 0 and 1.

**The frequency you type is not always the frequency you get.** rp2 hardware PWM can only generate
125 MHz/(div×(top+1)); the measured floor is 9 Hz, so 1, 5 or 8 Hz all run at 9 Hz, and higher requests
quantize too (1000→990, 2000→2035). The firmware reports the frequency the slice really runs at, the UI
turns that field amber, the tooltip reads "set to X Hz, the hardware runs Y Hz", and a request that misses
by more than 5% also writes a line to the log. Below 1 Hz the value is not sent at all; the board answers
`freq < 1 Hz: PWMOut takes whole hertz`.

**One trap to know up front**: rp2 hardware PWM is grouped by slice, one counter per slice, so
**the two pins in one slice share a single frequency**. The grouping is written down in the F4 column of the
datasheet / pico-sdk `gpio.h`, not the vague "adjacent pins" rule: pin `n` lands on slice `S`, channel `A/B`, where
- `n` ≤ 31: `S = (n // 2) mod 8`, even pin = channel A, odd pin = channel B;
- `n` ≥ 32 (QFN-80 packages only): `S = 8 + ((n - 32) mod 8) // 2`, still even A / odd B.

So GP0/GP1 are slice 0, GP2/GP3 slice 1, up to GP14/GP15 at slice 7 — and **GP16 wraps back to slice 0**:
GP16/GP17 are slice 0 again, GP18/GP19 slice 1, GP24/GP25 slice 4, GP28/GP29 slice 6. That is exactly the
"A given PWM channel can also be routed to a higher-numbered pin, and then the two are secretly one slice"
case: compute it from the table instead of trying. Asking the second pin for a different frequency fails with
`RuntimeError: Conflicting settings for shared resource` — the firmware does not overwrite the first pin, it
hands that pin back to the pool and the UI shows the command as failed. When you need two independent
frequencies, pick pins that compute to different slices (GP7 is slice 3, GP11 is slice 5).

### 4.4 ADC

Drag a pin into the ADC lane. The chip displays the voltage directly. Click the number to cycle between V, mV, and raw.

**Which pins can be ADC inputs is a package fact**: pico-sdk `platform_defs.h` and `gpio.h` both spell it out —
**GP26..GP29 (ADC0..ADC3) on RP2350A (QFN-60, the chip in Pico 2 and Pico 2 W)**, **GP40..GP47 (ADC0..ADC7) on
RP2350B (QFN-80)**. A pin the board definition does not declare never appears. On the Pico 2 that was measured, the
ADC pool is GP26/GP27/GP28/GP29 plus the virtual on-die temperature channel: GP29 carries only the names `A3` /
`VOLTAGE_MONITOR`, and the firmware derives its number from the ADC alias, so it is reachable and `adc.cfg` on it
reads **VSYS/3** — measured raw 31815, i.e. 1.600 V on the pin and VSYS ≈ 4.80 V. Per page 8 of the Pico 2 datasheet
that pin is used by the IP as an ADC input to measure VSYS/3, so using it for an external signal means accepting what
it really reads. The UI lights the badge from `caps.adc`, so a different board or build needs no code change.

The ADC lane also accepts a special **TEMP** chip, which sits at the end of the pin pool. It is the on-die temperature sensor.
It displays degrees Celsius by default. It occupies no physical pin and can run at the same time as other ADC channels.

### 4.5 I2C

I2C, UART and SPI are bus functions, so their UI is different: a lane holds **bus cards** rather than single pins.

Click "+ Add bus" at the bottom of the lane. A card appears with two labelled slots, SDA and SCL. Drag a pin badged D into the
SDA slot and a pin badged S into the SCL slot.

When a drop is refused, the UI tells you why (this pin cannot serve as SCL, or these two pins cannot form a pair). You never get
a silent no-op.

The rp2 I2C pin pairs are **not arbitrary**: this runs on the two hardware DW_apb_i2C peripherals (not PIO), and the F3 column
of `gpio.h` fixes the rule — **SCL must be an odd pin, SDA an even pin, and `SDA ≡ SCL - 1` (mod 4)**. GP5 with GP4 is legal, and
so is GP13 with GP4 (the pair does not have to be adjacent, only congruent mod 4), while GP8 with GP10 can never pair: both are
even, so neither can be SCL. The instance number is `(n // 2) mod 2`, 0 for i2c0 and 1 for i2c1, and the mod-4 condition above
already puts SCL and SDA on the same one — which is why the pairing rule carries no separate instance test. CircuitPython builds a
bus only on a combination that satisfies it and raises `Invalid pins` otherwise; `caps.i2c_pairs` is the ordered-pair array the
firmware produces by enumerating exactly those candidates and building each one for real, so following the S/D badges prevents
misselection. A clock above 1 MHz is rejected by CircuitPython itself.

The card also sets the clock frequency, scans the bus (the `Scan` button lists the addresses that acknowledge on the bus), and
runs raw transactions (fill in the slave address, the bytes to write, and the byte count to read).

On a new setup, scan first. An empty scan usually means no wiring or no pull-ups: an I2C bus needs pull-up resistors that hold
both lines high when idle. Many sensor modules carry them; bare chips do not.

### 4.6 UART

Also a bus card, with two slots: TX and RX.

Unlike I2C, **a UART card with only one slot filled still counts**. TX only means you transmit and never receive, RX only means
you listen and never send; both are legitimate uses. The pairing check runs only when both slots are filled.

On the card you pick the baud rate, type hex bytes to send, and read back a byte count.

**One trap**:

- The pins are **fixed by the datasheet**: every even GP can be TX and every odd GP can be RX (the F2 / F11 columns of
  `gpio.h`), but which of the two UARTs a pin routes to is also table-driven — CircuitPython computes
  `instance = ((n + 4) // 8) mod NUM_UARTS`, and `NUM_UARTS = 2` on rp2. So for full duplex TX and RX must compute to the
  same instance, or the constructor raises `Invalid pins`. The T / R badges are derived from that same rule, and the card
  only refuses a pair that cannot share an instance.

**GP0 and GP1 are usable now.** They are RP2350 UART0's TX/RX. In the old single-port build they measured as
claimed by the CircuitPython console, so any use failed with `GP1 in use`; on this dual-CDC firmware the same
check passes — `uart.cfg tx=0 rx=1` builds the bus (retested at 0.1.14). So they appear in `caps.uart.tx/rx/pairs`
as normal, and the GP0/GP1 chips in the pool light up their T / R badges again.

### 4.7 Live UART Terminal

The Read button on a card is too clumsy for streaming serial data. So the console area has a row of tabs above it: **Console** is
the device output mirror (the raw bytes of the data port, or of the console port once you attach a log port), and each UART you
configure adds a tab such as **UART #0** or **UART #1**.

Open a UART tab:

- Bytes the board receives are printed into the terminal live.
- Characters you type in the terminal go straight out on the matching TX.
- The **HEX** button in the top right switches the display: text mode shows bytes as they are, HEX mode shows them as uppercase
  hexadecimal. Use HEX when you are debugging a binary protocol.

Only the tab on screen receives data. Switch away and the push stops, so nothing wastes bandwidth.

The Clear / Copy / Export buttons at the top follow the current tab: clear a UART tab and you clear that terminal.

### 4.8 SPI

Also a bus card, only with more pins: **SCK, MOSI, MISO** data slots plus up to four chip
selects **CS0..CS3** (the number comes from `caps.spi.max_cs`).

Like UART, a half bus is legal: **a bus without MOSI or without MISO still configures**, so
transmit-only or receive-only are both normal. But **SCK is mandatory**, and at least one
data line has to accompany it — a bare SCK is refused by the port (`Must provide MISO or
MOSI pin`, measured).

**Two things to watch on this lane:**

- The data pins must all sit in **the same group**, one group per hardware SPI. RP2350 has two
  peripherals, so two groups, and the complete table over all pin numbers is:

  | Peripheral | SCK | MOSI(TX) | MISO(RX) |
  | --- | --- | --- | --- |
  | SPI0 | 2 / 6 / 18 / 22 / **34 / 38** | 3 / 7 / 19 / 23 / **35 / 39** | 0 / 4 / 16 / 20 / **32 / 36** |
  | SPI1 | 10 / 14 / 26 / **30 / 42 / 46** | 11 / 15 / 27 / **31 / 43 / 47** | 8 / 12 / 24 / 28 / **40 / 44** |

  That is a straight transcription of the F1 column of `gpio.h`; the bold 30..47 entries only exist on
  QFN-80 (RP2350B). Which of them you can actually use depends on whether the board definition declares the
  pin, and the firmware projects this table onto `caps.gp` at boot, so no pin count is hardcoded. The Pico
  2 W is the worked example: its `pins.c` does not declare GP23, so after projection
  `caps.spi.groups[0].mosi` is down to `3 / 7 / 19` (a conclusion from the board table plus the projection
  rule, not a measurement).

  Spanning the two groups is refused before anything goes to the device:
  `SCK/MOSI/MISO must come from one pin group (one hardware SPI)`.
  Each group is one hardware SPI, so **two buses at a time is the ceiling**; the third bus is
  blocked in the UI (`This firmware supports at most {0} SPI buses`).

- **Chip selects are free**. CS is not part of the SPI peripheral in this firmware: the line is
  a plain output driven low around a transaction, so any unused GP can serve as CS. It still
  counts as taken — once bound, the GPIO lane won't offer it.

The bench runs one transaction at a time: hex bytes in Write(hex), how many bytes to read in
Read bytes, which select to assert in the **Chip select** dropdown (— means drive none), and
**Hold CS** leaves the line low when the transaction ends, which is what you want for a
two-phase register read. Press **Transfer** and the result line looks like

```
03 14 25  ·  read 3 bytes  ·  actual 1973684 Hz
```

**That "actual" figure is the point**: the RP2 divider only produces 150 MHz over an even
integer, with 75 MHz as the ceiling, so a request for 2 MHz really runs at 1973684 Hz and
10 MHz at 9375000 Hz. Same honesty as the PWM lane's `hfreq` — the card reports what the
hardware did, not what you typed.

---

## 5. Scope Panel

Below the workbench is a collapsible waveform area. Each pin bound in the ADC lane adds a channel button here, TEMP included, up
to 4 channels at once.

Click "Start Capture". The board switches to one batch every 25ms and hands each completed batch to the page, which draws it on
the canvas.

What you can do:

| Gesture | Effect |
| --- | --- |
| Scroll wheel | Zoom horizontally, **anchored on the sample point under the cursor** |
| Shift + wheel | Zoom vertically, anchored on the voltage under the cursor |
| Press and drag | Pan the time axis and look back through history |
| Double-click | Reset to the full view |
| Crosshair button | Shows a crosshair at the cursor, with the timestamp and every channel value read out in the top left |

Two acquisition modes: **Roll** scrolls a fixed 2048-point window continuously; **FIFO** lets you choose the depth (256 to 4096)
and overwrites the oldest data in a ring once full, which suits capturing a window and then stopping.

Each channel takes a `y = k·x + b` correction, applied in the raw domain. The TEMP channel depends on this to turn raw back into
degrees Celsius.

Channel colours are assigned per pin and stay put: close a channel and open it again and the colour does not change, and adding
another channel never displaces the colours of the channels already on screen.

During acquisition, the reading on the lane chip reuses the newest row of the waveform frame and is smoothed, so the digits do not
jump around and the two displays never disagree.

---

## 6. Debug Console

The bottom of the page holds the console, in two modes:

- **Monitor**: read-only, mirrors the bytes the device pushes out. Without a log port this is the data port, so protocol lines
  and the device's own `print` output arrive mixed; once a log port is attached it mirrors the console port instead, where the
  banner, `print` and tracebacks live, and the protocol chatter stops scrolling past your eyes.
- **REPL**: writable, your keystrokes pass straight through to the board's CircuitPython prompt. Use it to try a snippet on the spot.

The **Attach log port** button opens that console port. On a dual-CDC board the page attaches it by itself right after the
handshake (it probes the authorized ports and takes the one that never answers a protocol ping), so you normally never press it;
you only do when the second port was never authorized, which the status light shows as `log port not attached`. Afterwards the
button greys out and reads "Log port attached"; it can only be re-picked after disconnecting the device.

The **Raw stream** button is a switch: with it on, the protocol port's raw JSON/binary bytes are written into the terminal too.
Off by default — the UI already decodes those bytes, and turning it on only interleaves them with the log port's output.
Switch it on when you want to read the wire format itself.

A button switches modes. When you switch to REPL, any open UART tab yields to Console automatically, because the board's REPL
lives on the console port and one port allows only one owner. Be clear about what dual CDC actually saves you: the REPL touches
only that port, so the **data port's connection is never dropped** — leaving the REPL costs no port picker and no re-authorization.
But entering the REPL means `Ctrl+C`, which stops `code.py`, so during a REPL session **nothing answers the protocol** and every
lane is dead (see section 10 of the [sample program guide](../03_Sample_Program_User_Guide/README.md)). Switching back to Monitor
restarts the device program and re-runs the handshake (the board's volatile configuration is cleared; the page immediately
re-applies it).

Three action buttons: clear, copy all, export as a txt file.

---

## 7. Interface Settings

- The **EN / 中文** buttons in the top right switch language, and the choice is remembered.
- Your bound pins, frequencies, bus configurations, and scope channel selection all live in `localStorage`.
  Close the page and open it again and they come back; once the board connects, they are sent down to it.
- The **Config ▾** menu in the header puts that saved snapshot where you can see it:
  - **Export config** downloads the current configuration as `picoharness-config-<timestamp>.json` and the console prints
    `Exported <file name>`. That is how you move a setup to another machine, keep a backup, or hand a board definition to a
    colleague.
  - **Import config** takes such a JSON file, replaces the configuration at once, and pushes it to the board; the console
    reports `Imported {n} entries`. A file that is not a PicoHarness config is rejected with `Import failed: …`.
  - **Clear config** asks first ("Clear the saved configuration? Lane bindings, PWM settings and buses all return to
    unassigned."), then drops every binding and deletes the browser copy as well.
  - The small line at the bottom of the menu is the point: **the config lives in the browser, not on the board**.
- To bypass the menu, run `localStorage.clear()` in the browser console and refresh.

An imported file may not fit the board in front of you. **While connected, the handshake checks every binding against the
capability table the device reported** and un-binds the pins this firmware cannot serve, naming them per function in the
console, e.g. `Unbound PWM pins this firmware cannot drive: GP1 GP2` or `Unbound pins outside this firmware's UART pairs: GP10`.
The released pins go back to the pool and the card survives, so you can drop in a legal partner. Importing while disconnected
skips the check; the next handshake runs it anyway.

Note that the configuration lives in the **browser**, not in the board. Move to another PC and you configure from scratch.
After the board loses power, its own configuration is zeroed; the page's once-per-second reconciliation replays it back.

---

## 8. Hardware Caveats at a Glance

These are traps already stepped in, collected here to save your time.

| Item | Detail |
| --- | --- |
| Which pins are in the pool | package GPIO count (RP2350A 30 / RP2350B 48, per `platform_defs.h`) ∩ the pins the board's `pins.c` declares. The number comes out of the declared name: `GPn` reads directly, and a pin that only has ADC aliases (`A3`) is numbered `ADC_BASE + channel`, which is how GP29 gets into the pool on a Pico 2. The pool may have holes (a Pico 2 W declares no GP23/24/25); firmware and UI both follow `caps.gp`, no pin count is hardcoded. |
| PWM pins in one slice share a frequency | Changing the frequency on one pin overwrites the other. Need independent frequencies, change pins. Slice = `(n // 2) mod 8` for n ≤ 31 and `8 + ((n - 32) mod 8) // 2` for n ≥ 32, even A / odd B — **it wraps at GP16 back to slice 0**, so "not adjacent" is not the same as "not the same slice". |
| PWM frequency floor | Integer Hz only, and the measured floor is 9 Hz (1..8 Hz all run at 9). Below 1 Hz the board rejects the command; for 1..8 the firmware reports the real frequency and the UI marks the field amber plus logs it. |
| ADC pins depend on package | QFN-60 is GP26..GP29 (ADC0..3), QFN-80 is GP40..GP47 (ADC0..7). On the Pico 2 the IP already uses GP29 as the VSYS/3 monitor — it is in the pool under its `A3` name, and reading it gives you the board supply divided by 3. |
| I2C needs pull-ups | If neither line is held high at idle you get `No pull up found`. That is a wiring problem, not a software problem. |
| I2C pin pairs are fixed | Hardware DW_apb_i2C, two instances: SCL odd, SDA even, `SDA ≡ SCL-1 (mod 4)` — adjacency is not required, and a pair that fails this raises `Invalid pins`. Follow the S/D badges. |
| UART on GP0/GP1 | Measured as claimed by the CircuitPython console in the old single-port build; on 0.1.14 with dual CDC they build a UART0 bus normally, and the capability table offers them. |
| UART pins are fixed | Every even pin can be TX, every odd pin can be RX; instance = `((n + 4) // 8) mod 2`, and for full duplex both pins must be on the same UART. |
| SPI data pins come in two groups | SCK/MOSI/MISO must all be from one group (the table in 4.8, a full transcription of `gpio.h` F1); spanning the groups builds nothing, and two groups means two buses. The 30..47 rows are QFN-80 only and are projected away through `caps.gp`. |
| SPI clocks round down | The clock is 150 MHz divided by an even integer, ceiling 75 MHz. Measured: asking for 2 MHz runs at 1973684 Hz, 10 MHz at 9375000 Hz, and the result line says `actual {0} Hz`. |
| SPI chip select is plain IO | The firmware drives CS as an output pin, so it uses no hardware SPI resource — but it does occupy a GP. |
| Copying code.py reboots the board | The browser's serial connection drops, so you have to reconnect. |
| Changing boot.py needs a hard reset | Press RESET or replug. A Ctrl-D soft reboot does not re-run boot.py, so the board still shows one port. |
| The two COM ports are indistinguishable by name | They share one VID/PID, so the page identifies them with a nonce ping. When debugging by hand, send `{"cmd":"ping"}` and see which port answers. |
| Swapping boards | The PWM / ADC / I2C tables are probed at boot and SPI is the documentation table projected onto `caps.gp`, so the UI adapts on its own. No code changes needed. |

---

## 9. If You Cannot Connect

Check these in order.

1. **Is the board powered?** Is the CIRCUITPY volume there? If not, reflash the UF2.
2. **Is code.py at the root?** The file must be named `code.py` and must sit in the root directory, not a subdirectory.
3. **Is boot.py there, and did you hard-reset?** A single CDC port means dual CDC never came up: press RESET
   (or replug) and check Device Manager for two COM ports.
4. **Is asyncio installed?** Open a serial terminal on the **console port** and read the board's output.
   `ImportError: no module named 'asyncio'` means the library is missing; go back to section 2.2.
5. **Right browser?** It must be desktop Chrome or Edge. Firefox and Safari do not support Web Serial.
6. **Did you authorize both ports?** Select every entry of the board in the picker, otherwise the log port and the REPL
   cannot be attached and the page can only recover by kicking the device program.
7. **Is the port already claimed?** If Thonny, mpremote, or another serial tool holds either COM port, close it first.
8. **No port picker appears?** Did you click "Connect"? Is there a blocked permission prompt on the right of the address bar?
9. **"No protocol port found"?** The device program is not running and does not answer the kick. Enter the REPL on the
   console port and type `import code` by hand to see the real error.

Still stuck? Open the error lookup in [03 Example Workflows](../03_Sample_Program_User_Guide/README.md), or attach a serial tool
and read what the board sends.
