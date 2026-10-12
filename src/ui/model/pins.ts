// Single source of UI truth for the workbench: per-pin role (pool / input /
// output / pwm), pull settings, PWM params, plus the last-known device state.
// Drivers mutate it; views subscribe to "levels" for targeted LED refresh
// instead of full re-renders.
import { Emitter } from "../core/events";
import type { JsonMsg } from "../types";

export const NUM = 29; // GP0..GP28, matching firmware NUM_PINS
export const R_IN = 1, R_OUT = 2, R_PWM = 3, R_ADC = 4, R_I2C = 5, R_UART = 6, R_SPI = 7;

// An I2C bus is a multi-pin function: it owns a named PAIR of pins (sda/scl
// hold model slot indices, -1 = unassigned) plus a clock rate. Bus instances
// live in PinModel.buses; the pins they claim carry roles[]=R_I2C and a
// pinBus[] back-pointer so the per-pin lane/pool logic treats them as taken.
export type I2cBus = { id: number; sda: number; scl: number; freq: number };

// A UART is also a multi-pin function but only needs ONE of its two members:
// tx or rx may be -1 (a transmit-only or receive-only bus), so "complete"
// means at least one bound. Its pins carry roles[]=R_UART and a uartPinBus[]
// back-pointer. rp2 hardware UART pins are fixed, so full-duplex (tx,rx) pairs
// are constrained — see uartPairs.
export type UartBus = { id: number; tx: number; rx: number; baud: number };

// SPI is the third multi-pin bus and the widest one: SCK plus at least one of
// MOSI/MISO (the port refuses a bare SCK), and up to caps.spi.max_cs chip-select
// lines that are plain outputs, not part of the peripheral. A bus is "complete"
// when SCK and one data line are bound. Its pins carry roles[]=R_SPI and a
// spiPinBus back-pointer. rp2 routes each SPI peripheral from fixed pin GROUPS,
// so every member has to come from the same group — see spiSlotOk.
export type SpiBus = {
  id: number;
  sck: number;
  mosi: number;
  miso: number;
  cs: number[];
  baud: number;
  mode: number; // 0..3 = CPOL/CPHA
};

export type SpiRole = "sck" | "mosi" | "miso" | "cs";
export type SpiDataRole = "sck" | "mosi" | "miso";
type SpiGroupSet = { sck: Set<number>; mosi: Set<number>; miso: Set<number> };

// The on-die temperature sensor is a virtual ADC channel: it occupies one extra
// model slot (index TEMP) but travels on the wire as pin TEMP_PIN, matching the
// firmware. All roles/pulls/adcFmt/adcSmooth arrays are SLOTS long so the temp
// channel flows through the same lane/chip/scope code as a GP pin.
export const TEMP = 29; // internal slot index of the temperature channel
export const SLOTS = 30; // NUM GP pins + the temp slot
export const TEMP_PIN = 100; // wire id of the temperature channel

export const toWire = (n: number): number => (n === TEMP ? TEMP_PIN : n);
export const fromWire = (p: number): number => (p === TEMP_PIN ? TEMP : p);
export const pinLabel = (n: number): string => (n === TEMP ? "TEMP" : "GP" + n);

// EMA factor for the ADC chip readout: smooths the bursty deadband events into
// a steady number. 0.3 tracks a real change within a few samples while killing
// single-step jitter that otherwise makes the digits flicker every event.
const ADC_ALPHA = 0.3;

export type PwmParam = { freq: number; duty: number };

// pwmUnit stores the display exponent (-3 mHz, 0 Hz, 3 kHz, 6 MHz); this
// sentinel instead means "auto-derive the unit from the frequency".
export const PWM_UNIT_AUTO = -9;

export class PinModel extends Emitter {
  roles = new Uint8Array(SLOTS); // 0 = pool, else R_*
  pulls = new Uint8Array(SLOTS); // inputs: 0 up, 1 down, 2 none
  pwm: (PwmParam | null)[] = new Array(SLOTS).fill(null);
  pwmUnit = new Int8Array(SLOTS).fill(PWM_UNIT_AUTO); // display exponent; AUTO = follow freq
  adcFmt = new Uint8Array(SLOTS); // ADC chip display: 0 volts, 1 millivolts, 2 raw 16-bit
  devAdc: Record<number, number> = {}; // last raw reading per internal slot, from events
  private adcSmooth = new Float64Array(SLOTS).fill(-1); // EMA of devAdc; -1 = unset
  devIn = 0;
  devOut = 0;
  devPwm = 0;
  sel: number | null = null;
  buses: I2cBus[] = []; // I2C bus instances (multi-pin functions)
  pinBus = new Int16Array(SLOTS).fill(-1); // slot -> owning bus id, -1 = not in a bus
  private busSeq = 0; // monotonic source of bus ids
  uartBuses: UartBus[] = []; // UART bus instances (tx and/or rx)
  uartPinBus = new Int16Array(SLOTS).fill(-1); // slot -> owning uart id, -1 = not in a uart
  private uartBusSeq = 0; // monotonic source of uart ids
  spiBuses: SpiBus[] = []; // SPI bus instances (sck + mosi/miso + cs lines)
  spiPinBus = new Int16Array(SLOTS).fill(-1); // slot -> owning spi id, -1 = not in a spi
  private spiBusSeq = 0; // monotonic source of spi ids
  private pwmCaps: number[] | null = null; // firmware caps.pwm; null = unknown
  private adcCaps: number[] | null = null;
  // rp2 PIO I2C legality is a property of the ORDERED (scl, sda) pair, not of
  // any single pin (real-hardware table: SCL must be odd, SDA even, and
  // sda ≡ scl-1 mod 4). We cache the firmware-probed pair set rather than
  // hard-coding the rule, so a CP release that changes the mux still tells the
  // truth. null (older firmware) = unknown → permissive; the device stays the
  // final arbiter at cfg time.
  private i2cPairs: Set<string> | null = null;
  private i2cSclPins: Set<number> | null = null; // pins usable as SCL (some pair)
  private i2cSdaPins: Set<number> | null = null; // pins usable as SDA (some pair)
  // rp2 hardware UART: only a fixed subset of pins carry the TX or RX function,
  // and a full-duplex pair must sit on one UART instance, so both the per-role
  // pin sets and the ordered (tx,rx) pair set come from caps.uart. A single pin
  // is always a legal bus on its own (transmit- or receive-only), so pair
  // legality only gates the case where BOTH slots are filled. null = unknown.
  private uartTxPins: Set<number> | null = null;
  private uartRxPins: Set<number> | null = null;
  private uartPairs: Set<string> | null = null;
  // rp2 SPI routes each peripheral from fixed pin GROUPS: SCK, MOSI and MISO all
  // have to come from one entry of caps.spi.groups, and one group means one
  // peripheral, so caps.spi.max_buses groups is how many SPI cards can be live at
  // once. CS lines are outside the peripheral (plain outputs) and may be any free
  // GP. Caps not known (caps.spi absent) → permissive, and the device rejects.
  private spiGroups: SpiGroupSet[] | null = null;
  private spiMaxCs = 4;
  private spiMaxBuses = 2;
  private spiCeiling = 0; // 0 = unknown

  // Drivers call this after any user-facing config mutation so the store
  // can coalesce saves; "levels" is only about live pin values.
  changed(): void {
    this.emit("config");
  }

  setCaps(caps: any): void {
    this.pwmCaps = Array.isArray(caps?.pwm) ? caps.pwm.map(Number) : null;
    this.adcCaps = Array.isArray(caps?.adc) ? caps.adc.map(Number) : null;
    const pairs = Array.isArray(caps?.i2c_pairs) ? caps.i2c_pairs : null;
    if (pairs) {
      this.i2cPairs = new Set<string>();
      this.i2cSclPins = new Set<number>();
      this.i2cSdaPins = new Set<number>();
      for (const p of pairs) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const scl = Number(p[0]);
        const sda = Number(p[1]);
        if (!Number.isInteger(scl) || !Number.isInteger(sda)) continue;
        this.i2cPairs.add(scl + ":" + sda);
        this.i2cSclPins.add(scl);
        this.i2cSdaPins.add(sda);
      }
    } else {
      this.i2cPairs = null;
      this.i2cSclPins = null;
      this.i2cSdaPins = null;
    }
    const u = caps?.uart;
    const utx = Array.isArray(u?.tx) ? u.tx.map(Number) : null;
    const urx = Array.isArray(u?.rx) ? u.rx.map(Number) : null;
    const upairs = Array.isArray(u?.pairs) ? u.pairs : null;
    this.uartTxPins = utx ? new Set(utx.filter(Number.isInteger)) : null;
    this.uartRxPins = urx ? new Set(urx.filter(Number.isInteger)) : null;
    if (upairs) {
      this.uartPairs = new Set<string>();
      for (const p of upairs) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const tx = Number(p[0]);
        const rx = Number(p[1]);
        if (!Number.isInteger(tx) || !Number.isInteger(rx)) continue;
        this.uartPairs.add(tx + ":" + rx);
      }
    } else {
      this.uartPairs = null;
    }
    const sp = caps?.spi;
    const sgroups = Array.isArray(sp?.groups) ? sp.groups : null;
    if (sgroups) {
      this.spiGroups = [];
      for (const g of sgroups) {
        if (!g || !Array.isArray(g.sck)) continue;
        this.spiGroups.push({
          sck: new Set<number>(g.sck.map(Number)),
          mosi: new Set<number>((Array.isArray(g.mosi) ? g.mosi : []).map(Number)),
          miso: new Set<number>((Array.isArray(g.miso) ? g.miso : []).map(Number)),
        });
      }
      if (!this.spiGroups.length) this.spiGroups = null;
    } else {
      this.spiGroups = null;
    }
    this.spiMaxCs = Number(sp?.max_cs) > 0 ? Number(sp.max_cs) : 4;
    this.spiMaxBuses = Number(sp?.max_buses) > 0 ? Number(sp.max_buses) : 2;
    this.spiCeiling = Number(sp?.baud_ceiling) > 0 ? Number(sp.baud_ceiling) : 0;
  }

  // Public caps reads for the SPI lane: how many CS slots to draw, how many buses
  // may be live, and the highest clock the port can produce.
  get spiCsLimit(): number {
    return this.spiMaxCs;
  }

  get spiBusLimit(): number {
    return this.spiMaxBuses;
  }

  // 0 = unknown (older firmware), so the caller falls back to its own preset list
  // instead of capping the input at nothing.
  get spiCeilingHz(): number {
    return this.spiCeiling;
  }

  get capsKnown(): boolean {
    return this.pwmCaps !== null;
  }

  // A persisted binding may name a pin or a pair the firmware now connected
  // cannot serve — a different board, or a caps table that changed since the
  // config was written. Such a binding can never take effect, and the drift
  // poll would re-issue it for as long as the link lives, so the handshake
  // drops those pins back to the pool and reports them. Nothing is sent to the
  // device: a fresh program owns no resources yet. Unknown caps reject nothing
  // — every predicate below answers "yes" until the firmware tells us otherwise.
  pruneAgainstCaps(): { pin: number; role: number }[] {
    const dropped: { pin: number; role: number }[] = [];
    const dropPin = (n: number): void => {
      const role = this.roles[n];
      if (role === R_PWM) this.pwm[n] = null;
      if (role === R_ADC) this.resetAdc(n);
      this.roles[n] = 0;
      this.pinBus[n] = -1;
      this.uartPinBus[n] = -1;
      this.spiPinBus[n] = -1;
      dropped.push({ pin: n, role });
    };
    for (let n = 0; n < SLOTS; n++) {
      const role = this.roles[n];
      if (role === R_PWM && !this.pwmCap(n)) dropPin(n);
      else if (role === R_ADC && !this.adcCap(n)) dropPin(n);
      else if (n === TEMP && role !== 0 && role !== R_ADC) dropPin(n);
    }
    // Half a bus stays half a bus: only the offending line is released, so the
    // card survives and the user can drop in a legal partner.
    for (const b of this.buses) {
      if (b.scl >= 0 && !this.i2cRoleCap(b.scl, "scl")) this.releaseBusLine(b.id, "scl", dropped);
      if (b.sda >= 0 && !this.i2cRoleCap(b.sda, "sda")) this.releaseBusLine(b.id, "sda", dropped);
      if (b.scl >= 0 && b.sda >= 0 && !this.i2cPairOk(b.scl, b.sda))
        this.releaseBusLine(b.id, "sda", dropped);
    }
    for (const b of this.uartBuses) {
      if (b.tx >= 0 && !this.uartRoleCap(b.tx, "tx")) this.releaseUartLine(b.id, "tx", dropped);
      if (b.rx >= 0 && !this.uartRoleCap(b.rx, "rx")) this.releaseUartLine(b.id, "rx", dropped);
      // An unroutable pair loses its RX line: the transmit half usually stays
      // useful, and the pair is what the hardware actually forbids.
      if (b.tx >= 0 && b.rx >= 0 && !this.uartPairOk(b.tx, b.rx))
        this.releaseUartLine(b.id, "rx", dropped);
    }
    for (const b of this.spiBuses) {
      if (b.sck >= 0 && !this.spiRoleCap(b.sck, "sck")) this.releaseSpiLine(b.id, "sck", dropped);
      if (b.mosi >= 0 && !this.spiRoleCap(b.mosi, "mosi")) this.releaseSpiLine(b.id, "mosi", dropped);
      if (b.miso >= 0 && !this.spiRoleCap(b.miso, "miso")) this.releaseSpiLine(b.id, "miso", dropped);
      // A set that spans two groups loses MISO first: a write-only bus is still a
      // bus, and SCK is the pin the card is organised around.
      if (!this.spiSetOk(b.sck, b.mosi, b.miso)) {
        if (b.miso >= 0) this.releaseSpiLine(b.id, "miso", dropped);
        else if (b.mosi >= 0) this.releaseSpiLine(b.id, "mosi", dropped);
      }
      // An older config may carry more CS lines than this board's firmware allows.
      while (b.cs.length > this.spiCsLimit) {
        const pin = b.cs[b.cs.length - 1];
        this.removeSpiCs(b.id, b.cs.length - 1);
        dropped.push({ pin, role: R_SPI });
      }
    }
    if (dropped.length) this.emit("config");
    return dropped;
  }

  private releaseBusLine(busId: number, which: "scl" | "sda", into: { pin: number; role: number }[]): void {
    const b = this.busById(busId);
    const pin = b ? (which === "scl" ? b.scl : b.sda) : -1;
    if (pin < 0) return;
    this.setBusSlot(busId, which, -1);
    into.push({ pin, role: R_I2C });
  }

  private releaseUartLine(busId: number, which: "tx" | "rx", into: { pin: number; role: number }[]): void {
    const b = this.busUartById(busId);
    const pin = b ? (which === "tx" ? b.tx : b.rx) : -1;
    if (pin < 0) return;
    this.setUartSlot(busId, which, -1);
    into.push({ pin, role: R_UART });
  }

  private releaseSpiLine(busId: number, which: SpiDataRole, into: { pin: number; role: number }[]): void {
    const b = this.busSpiById(busId);
    const pin = b ? b[which] : -1;
    if (pin < 0) return;
    this.setSpiSlot(busId, which, -1);
    into.push({ pin, role: R_SPI });
  }

  // True once the firmware has reported the I2C pair table, so the UI can show
  // SCL/SDA badges; before that the predicates are permissive but silent.
  get i2cPairKnown(): boolean {
    return this.i2cPairs !== null;
  }

  pwmCap(n: number): boolean {
    if (n === TEMP) return false; // the temperature sensor is not a PWM pin
    return !this.pwmCaps || this.pwmCaps.includes(n);
  }

  adcCap(n: number): boolean {
    const w = toWire(n); // caps are reported as wire ids (temp = 100)
    return !this.adcCaps || this.adcCaps.includes(w);
  }

  // Whether pin n can serve as the SCL (or SDA) line of some legal I2C pair.
  // Unknown caps → permissive (accept any GP); the device still rejects an
  // illegal pair authoritatively at cfg time.
  i2cRoleCap(n: number, role: "scl" | "sda"): boolean {
    if (n === TEMP || n < 0 || n >= NUM) return false;
    const set = role === "scl" ? this.i2cSclPins : this.i2cSdaPins;
    return !set || set.has(n);
  }

  // Whether the ordered (scl, sda) pair is a legal bus. Unknown caps → permissive.
  i2cPairOk(scl: number, sda: number): boolean {
    if (!this.i2cPairs) return true;
    return this.i2cPairs.has(scl + ":" + sda);
  }

  // Pin n may drop into the given slot of `bus`: role-capable, not the pin
  // already occupying the other slot, and (when that slot is filled) a legal
  // ordered pair with it.
  i2cSlotOk(bus: I2cBus, role: "scl" | "sda", n: number): boolean {
    if (!this.i2cRoleCap(n, role)) return false;
    const other = role === "scl" ? bus.sda : bus.scl;
    if (other === n) return false; // one pin can't be both lines
    if (other >= 0) return role === "scl" ? this.i2cPairOk(n, other) : this.i2cPairOk(other, n);
    return true;
  }

  // —— UART predicates ——
  get uartKnown(): boolean {
    return this.uartTxPins !== null || this.uartRxPins !== null;
  }

  // Whether pin n can serve as the TX (or RX) line of some UART. Unknown caps →
  // permissive; the device rejects an unroutable pin at cfg time.
  uartRoleCap(n: number, role: "tx" | "rx"): boolean {
    if (n === TEMP || n < 0 || n >= NUM) return false;
    const set = role === "tx" ? this.uartTxPins : this.uartRxPins;
    return !set || set.has(n);
  }

  // Whether the ordered (tx, rx) pair lands on one UART instance. Unknown → permissive.
  uartPairOk(tx: number, rx: number): boolean {
    if (!this.uartPairs) return true;
    return this.uartPairs.has(tx + ":" + rx);
  }

  // Pin n may enter the given slot of `bus`: role-capable, not the pin already in
  // the other slot, and — only when the other slot is filled — part of a legal
  // full-duplex pair. A single bound pin is always fine (tx-only / rx-only bus).
  uartSlotOk(bus: UartBus, role: "tx" | "rx", n: number): boolean {
    if (!this.uartRoleCap(n, role)) return false;
    const other = role === "tx" ? bus.rx : bus.tx;
    if (other === n) return false;
    if (other >= 0) return role === "tx" ? this.uartPairOk(n, other) : this.uartPairOk(other, n);
    return true;
  }

  level(n: number): number {
    return this.roles[n] === R_OUT ? (this.devOut >> n) & 1 : (this.devIn >> n) & 1;
  }

  setOutBit(n: number, v: number): void {
    this.devOut = (this.devOut & ~(1 << n)) | ((v & 1) << n);
    this.emit("levels");
  }

  cfgMasks() {
    let inM = 0, outM = 0, pd = 0, pn = 0;
    for (let n = 0; n < NUM; n++) {
      const bit = 1 << n;
      if (this.roles[n] === R_IN) {
        inM |= bit;
        if (this.pulls[n] === 1) pd |= bit;
        else if (this.pulls[n] === 2) pn |= bit;
      } else if (this.roles[n] === R_OUT) outM |= bit;
    }
    return { in: inM, out: outM, pd, pn };
  }

  pwmMask(): number {
    let m = 0;
    for (let n = 0; n < NUM; n++) if (this.roles[n] === R_PWM) m |= 1 << n;
    return m;
  }

  adcMask(): number {
    let m = 0;
    for (let n = 0; n < NUM; n++) if (this.roles[n] === R_ADC) m |= 1 << n;
    return m;
  }

  // The temperature channel is reported by the firmware as a separate boolean
  // (adc_temp), not a cfg_adc bit, since it is not a GP pin.
  adcTempOn(): boolean {
    return this.roles[TEMP] === R_ADC;
  }

  // —— I2C bus instances ——
  // A bus is only "live on the device" once both its pins are bound; the model
  // keeps roles/pinBus consistent so the pool and other lanes treat bus pins as
  // taken. Device coordination (claiming, cfg, release) lives in the driver.
  busById(id: number): I2cBus | undefined {
    return this.buses.find((b) => b.id === id);
  }

  addBus(): I2cBus {
    const b: I2cBus = { id: this.busSeq++, sda: -1, scl: -1, freq: 400000 };
    this.buses.push(b);
    return b;
  }

  // Restore bus id numbering above the highest loaded id so new ids stay unique.
  adoptBusId(id: number): void {
    if (id >= this.busSeq) this.busSeq = id + 1;
  }

  busOf(n: number): I2cBus | undefined {
    const id = this.pinBus[n];
    return id >= 0 ? this.busById(id) : undefined;
  }

  // Bind a pin into a bus slot; frees the pin from whatever else it was doing
  // at the model level and detaches any previous occupant of that slot. The
  // driver is responsible for telling the device to stop the displaced function.
  setBusSlot(busId: number, which: "sda" | "scl", pin: number): void {
    const b = this.busById(busId);
    if (!b) return;
    const prev = which === "sda" ? b.sda : b.scl;
    if (prev >= 0 && prev !== pin) {
      this.roles[prev] = 0;
      this.pinBus[prev] = -1;
    }
    if (pin >= 0) {
      // detach the pin from any other bus first (one pin, one function)
      const other = this.pinBus[pin];
      if (other >= 0 && other !== busId) {
        const ob = this.busById(other);
        if (ob) {
          if (ob.sda === pin) ob.sda = -1;
          if (ob.scl === pin) ob.scl = -1;
        }
      }
      this.roles[pin] = R_I2C;
      this.pinBus[pin] = busId;
      if (which === "sda") b.sda = pin;
      else b.scl = pin;
    } else {
      if (which === "sda") b.sda = -1;
      else b.scl = -1;
    }
  }

  removeBus(id: number): void {
    const b = this.busById(id);
    if (!b) return;
    for (const p of [b.sda, b.scl]) {
      if (p >= 0) {
        this.roles[p] = 0;
        this.pinBus[p] = -1;
      }
    }
    this.buses = this.buses.filter((x) => x.id !== id);
  }

  // Bitmask of every GP pin bound to a *complete* bus (both slots filled);
  // mirrors the firmware cfg_i2c mask for drift comparison.
  i2cMask(): number {
    let m = 0;
    for (const b of this.buses) if (b.sda >= 0 && b.scl >= 0) m |= (1 << b.sda) | (1 << b.scl);
    return m;
  }

  // Canonical signature of the buses the device should be running, so the poll
  // can detect any mismatch (a lost cfg after a soft reset) and re-issue.
  i2cSig(): string {
    return this.buses
      .filter((b) => b.sda >= 0 && b.scl >= 0)
      .map((b) => `${b.id}:${b.sda},${b.scl},${b.freq}`)
      .sort()
      .join(";");
  }

  // —— UART bus instances ——
  // "Complete" here means at least one of tx/rx is bound (a half bus is a valid
  // transmit- or receive-only UART), unlike I2C where both lines are required.
  uartComplete(b: UartBus): boolean {
    return b.tx >= 0 || b.rx >= 0;
  }

  busUartById(id: number): UartBus | undefined {
    return this.uartBuses.find((b) => b.id === id);
  }

  addUartBus(): UartBus {
    const b: UartBus = { id: this.uartBusSeq++, tx: -1, rx: -1, baud: 115200 };
    this.uartBuses.push(b);
    return b;
  }

  adoptUartBusId(id: number): void {
    if (id >= this.uartBusSeq) this.uartBusSeq = id + 1;
  }

  uartBusOf(n: number): UartBus | undefined {
    const id = this.uartPinBus[n];
    return id >= 0 ? this.busUartById(id) : undefined;
  }

  // Bind a pin into a uart slot; mirrors setBusSlot but for tx/rx and the
  // separate uartPinBus back-pointer + R_UART role.
  setUartSlot(busId: number, which: "tx" | "rx", pin: number): void {
    const b = this.busUartById(busId);
    if (!b) return;
    const prev = which === "tx" ? b.tx : b.rx;
    if (prev >= 0 && prev !== pin) {
      this.roles[prev] = 0;
      this.uartPinBus[prev] = -1;
    }
    if (pin >= 0) {
      const other = this.uartPinBus[pin];
      if (other >= 0 && other !== busId) {
        const ob = this.busUartById(other);
        if (ob) {
          if (ob.tx === pin) ob.tx = -1;
          if (ob.rx === pin) ob.rx = -1;
        }
      }
      this.roles[pin] = R_UART;
      this.uartPinBus[pin] = busId;
      if (which === "tx") b.tx = pin;
      else b.rx = pin;
    } else {
      if (which === "tx") b.tx = -1;
      else b.rx = -1;
    }
  }

  removeUartBus(id: number): void {
    const b = this.busUartById(id);
    if (!b) return;
    for (const p of [b.tx, b.rx]) {
      if (p >= 0) {
        this.roles[p] = 0;
        this.uartPinBus[p] = -1;
      }
    }
    this.uartBuses = this.uartBuses.filter((x) => x.id !== id);
  }

  uartMask(): number {
    let m = 0;
    for (const b of this.uartBuses) {
      if (b.tx >= 0) m |= 1 << b.tx;
      if (b.rx >= 0) m |= 1 << b.rx;
    }
    return m;
  }

  uartSig(): string {
    return this.uartBuses
      .filter((b) => this.uartComplete(b))
      .map((b) => `${b.id}:${b.tx},${b.rx},${b.baud}`)
      .sort()
      .join(";");
  }

  i2cComplete(b: I2cBus): boolean {
    return b.sda >= 0 && b.scl >= 0;
  }

  // —— SPI bus instances ——
  // SCK plus at least one data line makes a bus live on the device: the rp2 port
  // refuses a bare SCK, but a MOSI-less or MISO-less bus builds and runs, so a
  // half bus counts as complete.
  spiComplete(b: SpiBus): boolean {
    return b.sck >= 0 && (b.mosi >= 0 || b.miso >= 0);
  }

  busSpiById(id: number): SpiBus | undefined {
    return this.spiBuses.find((b) => b.id === id);
  }

  addSpiBus(): SpiBus {
    const b: SpiBus = { id: this.spiBusSeq++, sck: -1, mosi: -1, miso: -1, cs: [], baud: 1000000, mode: 0 };
    this.spiBuses.push(b);
    return b;
  }

  adoptSpiBusId(id: number): void {
    if (id >= this.spiBusSeq) this.spiBusSeq = id + 1;
  }

  spiBusOf(n: number): SpiBus | undefined {
    const id = this.spiPinBus[n];
    return id >= 0 ? this.busSpiById(id) : undefined;
  }

  // Whether pin n may ever carry this role. CS is the exception: the line is a
  // plain digital output on the firmware side, so any free GP can be one.
  spiRoleCap(n: number, role: SpiRole): boolean {
    if (n === TEMP || n < 0 || n >= NUM) return false;
    if (!this.spiGroups || role === "cs") return true;
    return this.spiGroups.some((g) => g[role].has(n));
  }

  // Index of the group that can route pin n in a data role, -1 if none. One group
  // is one peripheral, so this is also what two buses may not share.
  private spiGroupIdx(n: number, role: SpiDataRole): number {
    if (!this.spiGroups) return -1;
    return this.spiGroups.findIndex((g) => g[role].has(n));
  }

  // Whether the bound data pins all come from one group. Unknown caps → permissive.
  spiSetOk(sck: number, mosi: number, miso: number): boolean {
    if (!this.spiGroups) return true;
    let gid = -2;
    const lines: [SpiDataRole, number][] = [["sck", sck], ["mosi", mosi], ["miso", miso]];
    for (const [role, n] of lines) {
      if (n < 0) continue;
      const g = this.spiGroupIdx(n, role);
      if (g < 0) return false;
      if (gid === -2) gid = g;
      else if (g !== gid) return false;
    }
    return true;
  }

  // Pin n may enter this slot of `bus`: role-capable, not already playing another
  // role in the same bus, still inside the CS budget, and (for a data pin) leaving
  // the bus inside one pin group.
  spiSlotOk(bus: SpiBus, role: SpiRole, n: number): boolean {
    if (!this.spiRoleCap(n, role)) return false;
    const cand: SpiBus = { ...bus, cs: bus.cs.slice() };
    if (role === "cs") {
      if (cand.cs.length >= this.spiCsLimit) return false;
      cand.cs.push(n);
    } else {
      if (cand[role] === n) return true; // re-binding the pin it already holds
      cand[role] = n;
    }
    const members = [cand.sck, cand.mosi, cand.miso, ...cand.cs];
    if (members.indexOf(n) !== members.lastIndexOf(n)) return false; // one pin, one role
    return this.spiSetOk(cand.sck, cand.mosi, cand.miso);
  }

  // Bind a data pin into a spi slot; mirrors setUartSlot but for sck/mosi/miso and
  // the spiPinBus back-pointer + R_SPI role.
  setSpiSlot(busId: number, role: SpiDataRole, pin: number): void {
    const b = this.busSpiById(busId);
    if (!b) return;
    const prev = b[role];
    if (prev >= 0 && prev !== pin) {
      this.roles[prev] = 0;
      this.spiPinBus[prev] = -1;
    }
    if (pin >= 0) {
      const other = this.spiPinBus[pin];
      if (other >= 0 && other !== busId) this.detachSpiPin(other, pin);
      this.roles[pin] = R_SPI;
      this.spiPinBus[pin] = busId;
      b[role] = pin;
    } else {
      b[role] = -1;
    }
    this.changed();
  }

  // Add or replace one CS line. index === cs.length appends (the lane draws a
  // fixed row of slots and fills them left to right).
  setSpiCs(busId: number, index: number, pin: number): void {
    const b = this.busSpiById(busId);
    if (!b || index < 0) return;
    if (pin < 0) {
      this.removeSpiCs(busId, index);
      return;
    }
    if (index >= b.cs.length && b.cs.length >= this.spiCsLimit) return;
    const prev = b.cs[index];
    if (prev === pin) return;
    if (prev >= 0) {
      this.roles[prev] = 0;
      this.spiPinBus[prev] = -1;
    }
    const other = this.spiPinBus[pin];
    if (other >= 0 && other !== busId) this.detachSpiPin(other, pin);
    this.roles[pin] = R_SPI;
    this.spiPinBus[pin] = busId;
    b.cs[index] = pin;
    this.changed();
  }

  removeSpiCs(busId: number, index: number): void {
    const b = this.busSpiById(busId);
    if (!b || index < 0 || index >= b.cs.length) return;
    const pin = b.cs[index];
    b.cs.splice(index, 1);
    if (pin >= 0) {
      this.roles[pin] = 0;
      this.spiPinBus[pin] = -1;
    }
    this.changed();
  }

  // Take pin out of whatever other spi bus holds it (one pin, one function).
  private detachSpiPin(busId: number, pin: number): void {
    const ob = this.busSpiById(busId);
    if (!ob) return;
    for (const role of ["sck", "mosi", "miso"] as SpiDataRole[])
      if (ob[role] === pin) ob[role] = -1;
    const i = ob.cs.indexOf(pin);
    if (i >= 0) ob.cs.splice(i, 1);
  }

  removeSpiBus(id: number): void {
    const b = this.busSpiById(id);
    if (!b) return;
    for (const p of [b.sck, b.mosi, b.miso, ...b.cs]) {
      if (p >= 0) {
        this.roles[p] = 0;
        this.spiPinBus[p] = -1;
      }
    }
    this.spiBuses = this.spiBuses.filter((x) => x.id !== id);
    this.changed();
  }

  spiMask(): number {
    let m = 0;
    for (const b of this.spiBuses) {
      if (!this.spiComplete(b)) continue;
      for (const p of [b.sck, b.mosi, b.miso, ...b.cs]) if (p >= 0) m |= 1 << p;
    }
    return m;
  }

  // CS lines are joined with "+" so a list can never be read as two fields.
  spiSig(): string {
    return this.spiBuses
      .filter((b) => this.spiComplete(b))
      .map((b) => `${b.id}:${b.sck},${b.mosi},${b.miso},${b.cs.join("+")},${b.baud},${b.mode}`)
      .sort()
      .join(";");
  }

  // Edge-pushed input levels / ADC batches from firmware.
  applyEvent(m: JsonMsg): void {
    if (m.evt === "adc" && m.vals) {
      this.ingestAdc(m.vals);
      return;
    }
    if (m.evt !== "gpio_in" || typeof m.in !== "number") return;
    this.devIn = m.in >>> 0;
    this.emit("levels");
  }

  // Fold a batch of raw readings into devAdc + the EMA and flag a refresh.
  // Fed both by deadband adc events (stream off) and by the newest row of each
  // adc_w frame (stream on, JSON or binary), so the chip readout never freezes
  // while the scope is running.
  ingestAdc(vals: Record<number | string, number>): void {
    for (const k in vals) {
      const n = fromWire(Number(k)); // wire ids: temp arrives as 100
      const raw = vals[k];
      if (!Number.isInteger(n) || n < 0 || n >= SLOTS || typeof raw !== "number") continue;
      this.devAdc[n] = raw;
      const prev = this.adcSmooth[n];
      this.adcSmooth[n] = prev < 0 ? raw : prev + ADC_ALPHA * (raw - prev);
    }
    this.emit("adc");
  }

  adcVal(n: number): number | undefined {
    const v = this.adcSmooth[n];
    return v < 0 ? undefined : v;
  }

  resetAdc(n: number): void {
    this.adcSmooth[n] = -1;
  }

  // Adopt a device state payload. fromCmd=true means the reply is already
  // authoritative for this command; poll replies additionally report drift
  // so the caller can self-heal after a device soft reset.
  applyState(
    d: any,
    fromCmd: boolean
  ): {
    gpioDrift: boolean;
    pwmDrift: boolean;
    adcDrift: boolean;
    i2cDrift: boolean;
    uartDrift: boolean;
    spiDrift: boolean;
  } {
    this.devIn = d.in >>> 0;
    this.devOut = d.out >>> 0;
    this.devPwm = (d.cfg_pwm ?? 0) >>> 0;
    this.emit("levels");
    const none = {
      gpioDrift: false,
      pwmDrift: false,
      adcDrift: false,
      i2cDrift: false,
      uartDrift: false,
      spiDrift: false,
    };
    if (fromCmd) return none;
    const w = this.cfgMasks();
    const gpioDrift =
      d.cfg_in !== w.in || d.cfg_out !== w.out ||
      (d.cfg_pd >>> 0) !== w.pd || (d.cfg_pn >>> 0) !== w.pn;
    const pwmDrift = (d.cfg_pwm ?? 0) !== this.pwmMask();
    const adcDrift =
      (d.cfg_adc ?? 0) !== this.adcMask() || !!d.adc_temp !== this.adcTempOn();
    const devI2cSig = Array.isArray(d.i2c)
      ? d.i2c
          .map((x: any) => `${x.id}:${x.sda},${x.scl},${x.freq}`)
          .sort()
          .join(";")
      : "";
    const i2cDrift = devI2cSig !== this.i2cSig();
    const devUartSig = Array.isArray(d.uart)
      ? d.uart
          .map((x: any) => `${x.id}:${x.tx},${x.rx},${x.baud}`)
          .sort()
          .join(";")
      : "";
    const uartDrift = devUartSig !== this.uartSig();
    const devSpiSig = Array.isArray(d.spi)
      ? d.spi
          .map((x: any) => `${x.id}:${x.sck},${x.mosi},${x.miso},${(x.cs ?? []).join("+")},${x.baud},${x.mode}`)
          .sort()
          .join(";")
      : "";
    const spiDrift = devSpiSig !== this.spiSig();
    return { gpioDrift, pwmDrift, adcDrift, i2cDrift, uartDrift, spiDrift };
  }
}
