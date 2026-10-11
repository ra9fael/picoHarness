// Single source of UI truth for the workbench: per-pin role (pool / input /
// output / pwm), pull settings, PWM params, plus the last-known device state.
// Drivers mutate it; views subscribe to "levels" for targeted LED refresh
// instead of full re-renders.
import { Emitter } from "../core/events";
import type { JsonMsg } from "../types";

export const NUM = 29; // GP0..GP28, matching firmware NUM_PINS
export const R_IN = 1, R_OUT = 2, R_PWM = 3, R_ADC = 4, R_I2C = 5, R_UART = 6;

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
  }

  get capsKnown(): boolean {
    return this.pwmCaps !== null;
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
  ): { gpioDrift: boolean; pwmDrift: boolean; adcDrift: boolean; i2cDrift: boolean; uartDrift: boolean } {
    this.devIn = d.in >>> 0;
    this.devOut = d.out >>> 0;
    this.devPwm = (d.cfg_pwm ?? 0) >>> 0;
    this.emit("levels");
    if (fromCmd)
      return { gpioDrift: false, pwmDrift: false, adcDrift: false, i2cDrift: false, uartDrift: false };
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
    return { gpioDrift, pwmDrift, adcDrift, i2cDrift, uartDrift };
  }
}
