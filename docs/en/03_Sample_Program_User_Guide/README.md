# PicoHarness Example Workflows

This document does not cover interfaces. It covers "I want to do X, what do I click".
Every recipe stands on its own, so pick the ones you need.
When an error makes no sense, jump to the [troubleshooting table](#10-troubleshooting) at the end.

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
  so the frequency you set later overwrites the earlier one. To run two different frequencies, pick pins that are not paired
  (GP7 and GP11 are in different slices), or accept the shared frequency and vary only duty.
- **There is a low-frequency floor.** Fixed-frequency mode on the rp2 accepts integer Hz only, with a real floor around 7.4 Hz.
  Enter 1 mHz and the UI lets it through while the device reports the error as it is. That is honest reporting, not a bug.

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

**Why so many pins are unusable**: I2C on the rp2 is implemented with PIO, and legality is a property of a **pair of pins**, not of one pin.
The rule is: SCL takes an odd GP, SDA takes an even GP, and `SDA ≡ SCL−1 (mod 4)`. So two even pins such as GP8 and GP10 can never form a bus.
`caps.i2c_pairs` in the handshake log holds the exhaustively enumerated legal table, and the UI highlighting follows it exactly.

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

**Why GP0/GP1 are out**: on the Pico 2 they are the rp2350 UART0 TX/RX, and CircuitPython's own serial console claims both of them at boot.
The firmware already removes GP0/GP1 from `caps.uart` while probing, so the pin pool never highlights them as UART candidates.
If your localStorage still holds an old GP0/GP1 binding saved before the upgrade, clear it and rebind once.

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

1. Copy `code.py` onto both boards and plug each into its own USB port.
2. Open two browser tabs and connect one COM port to each.
3. Create a UART bus on both sides. Using GP6/GP7 on both is fine; they are separate hardware.
4. Switch both to their `UART #` tab. Type on one side and read on the other.

**What happens if you skip GND**: the levels have no common reference, so received bytes flip at random.
This is the most common failure in board-to-board work, and the symptom is "I do get data, but it is garbage".

**Both sides must use the same baud rate.** At 115200, 8N1. A mismatch usually shows as garbage at a fixed ratio rather than everything wrong.

---

## 9. Try Something Quickly in the REPL

**Goal**: bypass the protocol and run any CircuitPython code you like on the board.

**Steps**:

1. Switch the console mode to REPL.
2. The device soft-resets into the friendly REPL first. What you type goes into stdin unchanged, and output appears on screen unchanged.
3. Switching back to Monitor sends Ctrl+D. `code.py` runs again, the handshake repeats, and the function state is restored from localStorage.

**Careful**: while you are in the REPL, every lane is disconnected. `code.py` is not running, so nothing answers requests.
The scope trace freezes and the UART terminal stops receiving data. Neither is broken.
UART tabs also yield to the main terminal when you enter the REPL and unsubscribe from the stream; come back to Monitor and switch to the tab again.

---

## 10. Troubleshooting

### 10.1 Error Message Lookup

| Symptom (exact text in the UI) | Cause | Next step |
| --- | --- | --- |
| `unknown cmd: uart.cfg` (or any newer command) | The board runs old firmware while the browser has the new UI | Compare `VERSION` in `G:\code.py` against the source, then copy `code.py` once more. That reboots the board, so you have to reconnect. |
| `RuntimeError: no such bus (configure it first)` | The bus does not exist on the device: it was rejected, its pins were illegal, or the board just rebooted and lost volatile configuration | Check the `uart`/`i2c` lists in the handshake log. Reconnect once: the new handshake clears the "rejected" latch and replays `cfg`. |
| `ValueError: Invalid pins` (I2C) | The pin pair is illegal: SCL is not odd, or SDA does not satisfy `SDA ≡ SCL−1 (mod 4)` | Pick a different pair, or just read `caps.i2c_pairs`. |
| `RuntimeError: No pull up found on SDA or SCL` | The pair is legal; the lines are simply not pulled high | Check the wiring, the pull-ups, and VCC/GND. Do not change code. |
| `ValueError: ... GP1 in use` (or GP0) | The CircuitPython console holds that pair of the rp2350 UART0 | Use a different pairing such as GP6/GP7 or GP12/GP13. |
| `RuntimeError: pin GP7 busy` | The pin already belongs to another function | Unbind the chip from the old lane first, then bind the new one. |
| `ValueError: freq < 1 Hz: PWMOut takes whole hertz` | Fixed-frequency mode on the rp2 accepts integer Hz only | Enter a whole frequency of 1 or more. Before reaching for the mHz unit, confirm the device accepts it. |
| `Invalid variable_frequency` | Two pins in one slice want different frequencies, or you changed `.frequency` in fixed-frequency mode | Accept the shared frequency, or move the two pins into different slices. |
| The board's serial output is only `ImportError: no module named 'asyncio'` | asyncio is not installed on the device | Run `circup install asyncio`. Afterwards `G:\lib` should contain `asyncio/` and `adafruit_ticks.mpy`. |
| `RuntimeError: this bus has no TX pin / no RX pin` | Half bus, an expected limitation | If you need both directions, add the other wire. |

### 10.2 Cannot Connect, Handshake Stalls

Work through these in order; any one of them may fix it outright.

1. **Another tab still holds the port.** Web Serial allows one owner per COM port, so close the other browser tabs and retry.
2. **The device is not in the port picker.** Hold BOOTSEL and replug to confirm you can reach UF2,
   or check Device Manager for the COM number: a different USB port means a different number.
3. **The board is sitting in the friendly REPL.** `code.py` does not run when it has a syntax error, and the serial output shows the
   error message. Read it in REPL mode, or press Ctrl+D to see what failed.
4. **Another program owns the serial port.** Serial monitors, `mpremote`, and editor plugins all take a COM port exclusively.
5. **Handshake times out but the board is alive.** On startup the device emits an ANSI/OSC escape sequence that sets the terminal
   title, and it sticks to the front of the `ready` JSON. The host app locates the `{` and cuts it away. If you write your own host
   script, handle it as well, otherwise you will think JSON parsing failed.

### 10.3 The UI Behaves Oddly

- **A function re-sends its configuration once per second**: the device keeps refusing that state, so drift reconciliation reissues it every second.
  Newer builds suppress this with the "rejected" latch. If the log still floods, delete that bus card and build it again.
- **Old functions stop working after a firmware upgrade**: the handshake clears the live/rejected latches on the buses and reissues their
  configuration. If that did not take effect, click Connect/Disconnect once, which is the same as a manual retry.
- **Pin bindings are gone after a page refresh**: the configuration lives in the **browser's** localStorage
  (`picoharness-config-v1`), not on the board. A different browser, a different machine, or a private window will all look empty.
- **No trace in the scope**: confirm the channel button is lit; an ADC channel has to be bound in the lane already.
  Roll mode scrolls at fixed depth, so little data looks like "nothing moving". FIFO is easier to read.

### 10.4 The Data Looks Wrong

- **ADC readings jump a lot**: bad common ground, or the source impedance is too high (ADC source impedance should stay under 10 kΩ).
  On the software side only the deadband filter helps, and it cannot fix the cause.
- **The temperature disagrees with `cpu.temperature`**: the temperature channel is a raw16 equivalent back-calculated from the datasheet
  curve at 0.03 °C/LSB, so accuracy was never the goal.
- **I2C reads back all 0x00 or all 0xFF**: the address is in the wrong 8-bit/7-bit form, or the device is unpowered.
- **UART shows garbage at a fixed ratio**: the two sides use different baud rates.

---

## Related Documents

- [01 User Manual](../01_GUIApp_FW_Manual/README.md): prepare the board, learn the UI, feature-by-feature usage
- [02 Protocol Reference](../02_Library_User_Guide/README.md): the authoritative definition of commands, events, and binary frames
- [04 Build Guide](../04_FW_Build_Guide.txt): how to build, deploy, and verify after code changes
- [05 Release Notes](../05_Release_Notes.txt): what changed in each version
