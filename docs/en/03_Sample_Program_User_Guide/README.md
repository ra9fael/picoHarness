# PicoHarness Example Workflows

This document does not cover interfaces. It covers "I want to do X, what do I click".
Every recipe stands on its own, so pick the ones you need.
When an error makes no sense, jump to the [troubleshooting table](#11-troubleshooting) at the end.

Before you start: the board is prepared per [01 User Manual §2](../01_GUIApp_FW_Manual/README.md#2-prepare-the-board),
the host app is connected, the status light shows ready, and the handshake log contains `caps`.

Conventions: GP0..GP28 below means the broken-out pins on the Pico 2, and GND means any ground on the board.
Every pin binding can be dragged or done as "click the chip, then click the lane slot". The two styles are mixed freely without further note.

---

## 1. Use a Pin as a Switch: GPIO Loopback

**Goal**: confirm the whole path (browser → serial → firmware → pin → back to the browser) works.
One jumper wire finishes the job; no external parts at all.

**Wiring**:

```
GP2 ──jumper── GP3
```

**Steps**:

1. Drag GP2 into the digital output lane and GP3 into the digital input lane.
2. Click the output chip in the UI so that GP2 drives high.
3. Watch the LED on GP3 in the input lane: it should light up along with it.
4. Click once more and both drop low together.

**Why this counts as verified**: the output side runs on request/response, the input side runs on event push.
Two different paths working at the same time is what shows the link is complete. If the input LED does not move, first check whether the output chip really went high.

**Careful**: GP3 is an input here, so do not also drag it into the output lane. A pin belongs to one function at a time,
so the later binding displaces the earlier one, and the UI shows exactly that.

---

## 2. Read an Analog Value: Potentiometer or Photoresistor

**Goal**: watch voltage change over time, and check the scope panel while you are at it.

**Wiring** (three-pin potentiometer, the middle pin is the wiper):

```
potentiometer left   ── 3V3(OUT)
potentiometer middle ── GP26
potentiometer right  ── GND
```

**Steps**:

1. Drag GP26 into the ADC lane.
2. The chip shows voltage in V by default; the `V/raw` button switches back to the 16-bit raw value.
3. Turn the knob and the reading should change smoothly.
4. Open the scope panel below and click the `26` channel button; the trace starts rolling.
5. To see more detail, set the sample interval to 25 ms, switch the mode to FIFO, and pick a depth of 1024 or 2048.
6. To calibrate, enter the coefficients in that channel's `k·x+b`. For a 1/3 divider probe, enter `k=3, b=0`.

**Which pins can do ADC**: GP26, GP27, GP28 only, plus the internal temperature virtual channel.
`caps.adc` in the handshake log is the authoritative list; no other pin will drop into the ADC lane.

---

## 3. Check the Board Temperature: Internal Temp Channel

**Goal**: verify the telemetry stream and the temperature correction curve without connecting anything.

**Steps**:

1. The pin pool carries an extra `TEMP` chip. It is a virtual channel and occupies no physical pin.
2. Drag `TEMP` into the ADC lane.
3. The chip shows °C by default. Switching to raw shows the back-calculated 16-bit equivalent, not a raw register value.
4. Hold your finger on the Pico 2 chip for ten to fifteen seconds; the reading should climb slowly and fall back when you let go.

**Accuracy you can trust**: ±1~2 °C. The rp2350 temperature curve differs from chip to chip, so do not use it to calibrate a thermometer.
The temperature channel runs through exactly the same pipeline as the other ADC channels: same deadband, same waveform stream, same ring buffer.
The only difference is the display unit.

---

## 4. Output PWM: LED Dimming or a Fixed-Frequency Square Wave

**Goal**: dim an LED, or supply a clock to downstream circuitry.

**Wiring**:

```
GP7 ── 330Ω ── LED anode, LED cathode ── GND
```

**Steps**:

1. Drag GP7 into the PWM lane.
2. Click ▾ next to the frequency field, pick a preset value (1/2/5/10/…/1000), then pick the unit (mHz/Hz/kHz/MHz).
3. Drag the duty slider and the LED brightness follows.

**Two traps you will certainly hit**:

- **The two pins of one slice are tied to the same frequency.** An rp2 PWM slice has one counter shared by two pins,
  so they can only run one frequency. To run two different frequencies, compute each pin's slice —
  `(n // 2) mod 8` for n ≤ 31, `8 + ((n - 32) mod 8) // 2` for n ≥ 32 — and pick pins whose results differ
  (GP7 is slice 3, GP11 is slice 5); **"not adjacent" is not the same as "not the same slice"**, because
  GP16/GP17 wrap back to slice 0. Or accept the shared frequency and vary only duty. Asking the second pin for
  another frequency does not overwrite the first: `pwm.cfg` fails with `Conflicting settings for shared resource` and
  that pin goes back to the pool.
- **There is a low-frequency floor.** Fixed-frequency mode on the rp2 accepts integer Hz only, and the measured floor
  is 9 Hz: 1..8 Hz all run at 9 Hz, and higher requests quantize (1 kHz comes out as 990 Hz). The firmware reports the
  real frequency, so the field turns amber and its tooltip says what the hardware runs; a value below 1 Hz is rejected
  by the device outright. That is honest reporting, not a bug.

**Want to capture the waveform**: bring the PWM pin over to the neighbouring GP26 with a jumper wire, and the ADC plus the scope will show your own square wave.
The ADC stream is at best one batch every 10 ms, so a high-frequency square wave is severely distorted. Use it for slow duty-cycle changes only.

---

## 5. Scan an I2C Bus

**Goal**: confirm the wiring and find the device address.

**Wiring** (GP8 = SDA, GP9 = SCL):

```
GP8 ── SDA ─┬─ device SDA
GP9 ── SCL ─┴─ device SCL
3V3(OUT) ── device VCC
GND     ── device GND
```

**Steps**:

1. Click "+ Add bus" in the I2C lane. A card appears.
2. Drag the SCL pin into the slot labelled `SCL` on the card and the SDA pin into the slot labelled `SDA`.
   **Only legal pins light up**; an illegal slot refuses the drop.
3. Pick the clock (100 kHz by default) and the card becomes "configured".
4. Leave the address field empty or click scan, and you get the list of online addresses.

**Why so many pins are unusable**: I2C on the rp2 runs on the **hardware DW_apb_i2c peripherals, not PIO** (there is no bit-bang
fallback), and legality is a property of a **pair of pins**, not of one pin.
The rule is: SCL takes an odd GP, SDA takes an even GP, and `SDA ≡ SCL−1 (mod 4)` — the two pins need not be adjacent, so
GP13 with GP4 is a pair. So two even pins such as GP8 and GP10 can never form a bus.
`caps.i2c_pairs` in the handshake log holds the complete legal table, enumerated from that rule and confirmed by the firmware
actually building each bus, and the UI highlighting follows it exactly.

**`No pull up found on SDA or SCL` does not mean you chose the wrong pins.** The message means the pair is legal but the two lines are not
being pulled high. The typical causes are no device attached, no pull-ups, or VCC/GND forgotten. Check the wiring, not the code.

---

## 6. Raw I2C Transactions: Read a Register, Then Write It Back

**Goal**: run bus transactions with no device driver involved.

**Steps** (reuse the bus from the previous recipe, device address 0x68):

1. Select "read" on the transaction card, enter `0x68` as the address and `1` as the read length, send, and you get the first byte.
2. To read a specific register, select "write-read" (wr), enter the register number as the write data and the byte count you want as the read length.
   This performs a repeated start and does not release the bus in between.
3. To configure the device, select "write" and enter two bytes as the write data: `[register, value]`.
4. The data box takes hex text. `0x68`, `68`, and `de ad be ef` all parse, and spacing is free-form.

Addresses are 7-bit, range 0..127. If the address in front of you is 8-bit (many references fold the R/W bit in, such as 0xD0), shift it right by one before entering it.

---

## 7. UART Loopback: One Board Talks to Itself

**Goal**: verify the UART path by seeing the bytes you sent come back.

**Wiring**:

```
GP6 ──jumper── GP7
```

GP6 is TX and GP7 is RX (even pin for TX, odd pin for RX, and both on the same hardware UART instance).

**Steps**:

1. Click "+ Add serial" in the UART lane.
2. Put GP6 in the TX slot and GP7 in the RX slot. Filling only one is also fine, see the note below.
3. Leave the baud rate at 115200.
4. Switch the console to the `UART #0` tab and type, then press Enter. The characters you sent should appear in the same terminal.
5. To see raw bytes, send `aa 55 aa` using the card's Send/Read controls. You should get `AA 55 AA` back.
6. Click the `HEX` button in the tab bar to show received bytes as uppercase hexadecimal; click again to return to text.

**Half bus is allowed**: binding TX only or RX only are both legal, unlike I2C, which requires both lines.
With TX only you can send but cannot receive; with RX only you can receive but cannot send. The UI refuses the impossible direction and says so.

**GP0/GP1 are legal candidates again**: on the Pico 2 they are the rp2350 UART0 TX/RX. Under the old single-port
build CircuitPython's own serial console held both of them, so probing removed them from `caps.uart`. On this
dual-CDC firmware `uart.cfg tx=0 rx=1` builds the bus, so they are listed in `caps.uart` and the pin pool
highlights them as UART candidates like any other pair.

---

## 8. UART Between Two Boards

**Goal**: use two PicoHarness instances as two serial terminals exchanging messages.

**Wiring**:

```
Board A GP6(TX) ──► Board B GP7(RX)
Board A GP7(RX) ◄── Board B GP6(TX)
Board A GND     ──── Board B GND     ← this wire is mandatory
```

**Steps**:

1. Copy `boot.py` and `code.py` onto both boards, hard-reset each once, and plug them into their own USB port.
2. Open two browser tabs. Each tab's picker lists the entries of that board (two per board); authorize and connect, and the
   page works out which of the two is the data port.
3. Create a UART bus on both sides. Using GP6/GP7 on both is fine; they are separate hardware.
4. Switch both to their `UART #` tab. Type on one side and read on the other.

**What happens if you skip GND**: the levels have no common reference, so received bytes flip at random.
This is the most common failure in board-to-board work, and the symptom is "I do get data, but it is garbage".

**Both sides must use the same baud rate.** At 115200, 8N1. A mismatch usually shows as garbage at a fixed ratio rather than everything wrong.

---

## 9. An SPI Transaction: Reading a Flash Chip's JEDEC ID

**Goal**: find out what this bench actually puts on the bus. It runs one full-duplex
transaction at a time, so the write and the read happen on **the same clock run** — it is
not "write, then read".

**Wiring** (a SPI Flash as the example device):

```
board GP2 ──── SCK
board GP3 ──── MOSI (the device's DI)
board GP4 ──── MISO (the device's DO)
board GP5 ──── CS#
board GND ──── GND
```

GP2/GP3/GP4 are the SCK/MOSI/MISO of **one group**, which is why this works. Swap GP4 for
GP8 and the set spans two groups — the UI will not even let you drop it in. GP5 is not in
the SPI data-pin table at all: chip select is a plain output, so any unused GP can serve.

**Steps**:

1. Drag GP2 into the SCK slot, GP3 into MOSI, GP4 into MISO, and GP5 into the CS0 slot.
   The card shows CS0..CS3 all the time; whichever ones you fill become the selectable
   chip selects.
2. Pick 1 MHz for the clock and mode 0 (CPOL=0 / CPHA=0, the default of most devices).
3. Put `9f` in Write(hex), `4` in Read bytes, choose `CS0` in the Chip select dropdown,
   leave Hold CS unchecked, and press **Transfer**.
4. The result line looks like:

```
FF EF 40 18  ·  read 4 bytes  ·  actual 1000000 Hz
```

**Why read four bytes**: the 0x9F command itself consumes 8 clocks and the 3-byte ID comes
after them. Full duplex means those 8 clocks are receiving too, so the first byte you get
back is whatever the device had on DO before it decoded the command — the real ID is bytes
2..4. The firmware pads a short `w` with `0xFF` up to the length of `r`, so the bus actually
sees `9F FF FF FF`, which is exactly what RDID wants: after the command, MOSI is don't-care.

**If you want the two phases separated** (some devices need something between command and read):

| order | Write(hex) | Read bytes | Hold CS | what goes on the bus |
| --- | --- | --- | --- | --- |
| 1 | `9f` | `0` | checked | CS falls, 8 clocks, CS **stays down** |
| 2 | empty | `3` | unchecked | 24 more clocks, 3 bytes back, then CS rises |

The second transaction still names `CS0`: that line is already low, so driving it low again
creates no new edge — this is one continuous selection, not two independent transactions.
Remember to release Hold CS on the last one, or CS sits low and the device keeps waiting.

**When the ID makes no sense**: check whether the chip select was left out. If the dropdown
is on "—", every CS stays high for the whole run, the device is never selected, and you are
clocking a floating line. That mode exists on purpose — it is how you grab the clocks alone.

---

## 10. Try Something Quickly in the REPL

**Goal**: bypass the protocol and run any CircuitPython code you like on the board.

**Steps**:

1. Switch the console mode to REPL. The page sends Ctrl+C on the **console port** (it attaches that port itself if you have not
   opened it by hand), and verifies the `>>>` prompt from the console output. The data port stays open the whole time.
2. The device soft-resets into the friendly REPL first. What you type goes into stdin unchanged, and output appears on screen unchanged.
3. Switching back to Monitor sends Ctrl+D. `code.py` runs again, the handshake repeats, and the function state is restored from localStorage.

**Careful**: while you are in the REPL, every lane is disconnected. `code.py` is not running, so nothing answers requests.
The scope trace freezes and the UART terminal stops receiving data. Neither is broken.
UART tabs also yield to the main terminal when you enter the REPL and unsubscribe from the stream; come back to Monitor and switch to the tab again.

---

## 11. Troubleshooting

### 11.1 Error Message Lookup

| Symptom (exact text in the UI) | Cause | Next step |
| --- | --- | --- |
| `unknown cmd: uart.cfg` (or any newer command) | The board runs old firmware while the browser has the new UI | Compare `VERSION` in `G:\code.py` against the source, then copy `code.py` once more. That reboots the board, so you have to reconnect. |
| `RuntimeError: no such bus (configure it first)` | The bus does not exist on the device: it was rejected, its pins were illegal, or the board just rebooted and lost volatile configuration | Check the `uart`/`i2c` lists in the handshake log. Reconnect once: the new handshake clears the "rejected" latch and replays `cfg`. |
| `ValueError: Invalid pins` (I2C) | The pin pair is illegal: SCL is not odd, or SDA does not satisfy `SDA ≡ SCL−1 (mod 4)` | Pick a different pair, or just read `caps.i2c_pairs`. |
| `RuntimeError: No pull up found on SDA or SCL` | The pair is legal; the lines are simply not pulled high | Check the wiring, the pull-ups, and VCC/GND. Do not change code. |
| `ValueError: ... GP1 in use` (or GP0) | **Only on the old single-port build**, where the CircuitPython console held that UART0 pair. Since 0.1.14 the protocol lives on its own data port and `uart.cfg tx=0 rx=1` builds the bus (retested on hardware) | If you are still on a single-port build, add `boot.py` and hard-reset; otherwise use another pairing such as GP6/GP7 (UART1) |
| `RuntimeError: pin GP7 busy` | The pin already belongs to another function | Unbind the chip from the old lane first, then bind the new one. |
| `ValueError: freq < 1 Hz: PWMOut takes whole hertz` | Fixed-frequency mode on the rp2 accepts integer Hz only | Enter a whole frequency of 1 or more. Before reaching for the mHz unit, confirm the device accepts it. |
| `Invalid variable_frequency` | Two pins in one slice want different frequencies, or you changed `.frequency` in fixed-frequency mode | Accept the shared frequency, or move the two pins into different slices. |
| The board's serial output is only `ImportError: no module named 'asyncio'` | asyncio is not installed on the device | Run `circup install asyncio`. Afterwards `G:\lib` should contain `asyncio/` and `adafruit_ticks.mpy`. |
| `RuntimeError: this bus has no TX pin / no RX pin` | Half bus, an expected limitation | If you need both directions, add the other wire. |
| `ValueError: busio.SPI on rp2 needs at least a MOSI or a MISO pin` | Only SCK is bound | Add at least one data pin. Transmit-only or receive-only is legal; a lone SCK is not. |
| `... is not a routable set: rp2 SPI pins come in fixed groups ...` (the UI-side equivalent is `SCK/MOSI/MISO must come from one pin group (one hardware SPI)`) | The three data pins span two groups | Re-pick from one entry of `caps.spi.groups`. The UI refuses to drop a cross-group pin in the first place. |
| `could not build SPI on ...: SPI peripheral in use` | Both groups are taken, so a third bus has no hardware left | Release one bus, or move the two buses onto separate groups. |
| `RuntimeError: GP5 already belongs to SPI bus 0 — release it first` | Two buses want the same pin, usually a reused chip select | Use another free GP as CS, or release the old bus. |
| `SPI command failed: no CS 1 on this bus (it has 1)` | The transaction named a CS index that does not exist | Fill that CS slot on the card, or set the dropdown back to CS0 / "—". |
| `RuntimeError: this bus has no MISO pin — nothing to read` | A MOSI-only half bus was asked to read | Add MISO, or keep that bus write-only. |

### 11.2 Cannot Connect, Handshake Stalls

Work through these in order; any one of them may fix it outright.

1. **Another tab still holds the port.** Web Serial allows one owner per COM port, so close the other browser tabs and retry.
2. **The device is not in the port picker.** Hold BOOTSEL and replug to confirm you can reach UF2,
   or check Device Manager for the COM numbers: a different USB port means different numbers, and a dual-CDC board lists two.
3. **"No protocol port found", but the board is alive.** You authorized only one of the two ports, or `boot.py` never took
   effect (no hard reset). Both entries of the board must be authorized; the page cannot tell them apart by name, only by ping.
4. **The board is sitting in the friendly REPL.** `code.py` does not run when it has a syntax error, and the traceback appears on
   the **console port** (the data port stays silent). Read it in REPL mode, or press Ctrl+D to see what failed.
5. **Another program owns the serial port.** Serial monitors, `mpremote`, and editor plugins all take a COM port exclusively.
6. **Handshake times out but the board is alive.** On startup the device emits an ANSI/OSC escape sequence that sets the terminal
   title, and it sticks to the front of the `ready` JSON. The host app locates the `{` and cuts it away. If you write your own host
   script, handle it as well, otherwise you will think JSON parsing failed.

### 11.3 The UI Behaves Oddly

- **A function re-sends its configuration once per second**: the device keeps refusing that state, so drift reconciliation reissues it every second.
  Newer builds suppress this with the "rejected" latch. If the log still floods, delete that bus card and build it again.
- **Old functions stop working after a firmware upgrade**: the handshake clears the live/rejected latches on the buses and reissues their
  configuration. If that did not take effect, click Connect/Disconnect once, which is the same as a manual retry.
- **Pin bindings are gone after a page refresh**: the configuration lives in the **browser's** localStorage
  (`picoharness-config-v1`), not on the board. A different browser, a different machine, or a private window will all look empty.
- **No trace in the scope**: confirm the channel button is lit; an ADC channel has to be bound in the lane already.
  Roll mode scrolls at fixed depth, so little data looks like "nothing moving". FIFO is easier to read.

### 11.4 The Data Looks Wrong

- **ADC readings jump a lot**: bad common ground, or the source impedance is too high (ADC source impedance should stay under 10 kΩ).
  On the software side only the deadband filter helps, and it cannot fix the cause.
- **The temperature disagrees with `cpu.temperature`**: the temperature channel is a raw16 equivalent back-calculated from the datasheet
  curve at 0.03 °C/LSB, so accuracy was never the goal.
- **I2C reads back all 0x00 or all 0xFF**: the address is in the wrong 8-bit/7-bit form, or the device is unpowered.
- **UART shows garbage at a fixed ratio**: the two sides use different baud rates.
- **SPI reads back all 0xFF or all 0x00**: most likely the chip select was left out — with the
  dropdown on "—" every CS stays high, the device is never selected, and MISO only shows its
  pull state. Only after that consider MOSI and MISO swapped.
- **SPI data shifts by a few bits between runs**: the CPOL/CPHA mode does not match what the
  device wants. Set the mode from the device datasheet first.

---

## Related Documents

- [01 User Manual](../01_GUIApp_FW_Manual/README.md): prepare the board, learn the UI, feature-by-feature usage
- [02 Protocol Reference](../02_Library_User_Guide/README.md): the authoritative definition of commands, events, and binary frames
- [04 Build Guide](../04_FW_Build_Guide.txt): how to build, deploy, and verify after code changes
- [05 Release Notes](../05_Release_Notes.txt): what changed in each version
