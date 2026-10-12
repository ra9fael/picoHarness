// localStorage persistence of the workbench configuration (lane assignment,
// pulls, PWM params). Restored silently on page load; the device catches up
// through the normal gpio.cfg sendNow + pwm drift-reconciliation path once
// the link becomes ready, so no restore-time commands are needed here.
import type { PinModel } from "./pins";
import { SLOTS, R_PWM, R_ADC, R_I2C, R_UART, PWM_UNIT_AUTO } from "./pins";

const KEY = "picoharness-config-v1";

export type PinSnap = {
  n: number;
  r: number;
  p: number;
  f?: number;
  d?: number;
  u?: number;
  a?: number; // ADC display format: 0 V, 1 mV, 2 raw
};

export type BusSnap = { id: number; sda: number; scl: number; freq: number };
export type UartSnap = { id: number; tx: number; rx: number; baud: number };

export type Snapshot = { v: number; pins: PinSnap[]; buses: BusSnap[]; uarts: UartSnap[] };

export function snapshotOf(model: PinModel): Snapshot {
  const pins: PinSnap[] = [];
  for (let n = 0; n < SLOTS; n++) {
    const r = model.roles[n];
    if (!r || r === R_I2C || r === R_UART) continue; // bus pins are reconstructed from `buses`/`uarts`
    const s: PinSnap = { n, r, p: model.pulls[n] };
    const pw = model.pwm[n];
    if (r === R_PWM && pw) {
      s.f = pw.freq;
      s.d = pw.duty;
      s.u = model.pwmUnit[n];
    }
    if (r === R_ADC) s.a = model.adcFmt[n];
    pins.push(s);
  }
  const buses: BusSnap[] = model.buses.map((b) => ({ ...b }));
  const uarts: UartSnap[] = model.uartBuses.map((b) => ({ ...b }));
  return { v: 1, pins, buses, uarts };
}

export function saveConfig(model: PinModel): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshotOf(model)));
  } catch {}
}

// Replaces the whole model config with a parsed snapshot; returns the number of
// entries applied. Unknown or malformed fields are skipped rather than trusted —
// the file comes from another browser, and the device is the final arbiter.
function applySnapshot(model: PinModel, obj: any): number {
  model.roles.fill(0);
  model.pulls.fill(0);
  model.pwm.fill(null);
  model.pwmUnit.fill(PWM_UNIT_AUTO);
  model.adcFmt.fill(0);
  model.buses = [];
  model.pinBus.fill(-1);
  model.uartBuses = [];
  model.uartPinBus.fill(-1);
  let count = 0;
  for (const s of obj.pins) {
    if (typeof s?.n !== "number" || s.n < 0 || s.n >= SLOTS || !Number.isInteger(s.n)) continue;
    if (s.r !== 1 && s.r !== 2 && s.r !== 3 && s.r !== 4) continue;
    model.roles[s.n] = s.r;
    if (s.r === 1 && (s.p === 0 || s.p === 1 || s.p === 2)) model.pulls[s.n] = s.p;
    if (s.r === R_PWM && typeof s.f === "number" && s.f > 0) {
      model.pwm[s.n] = {
        freq: s.f, // keep float — mHz entries like 500 mHz = 0.5 Hz must survive a round trip
        duty: typeof s.d === "number" ? Math.min(Math.max(s.d, 0), 100) : 50,
      };
      model.pwmUnit[s.n] = typeof s.u === "number" ? s.u : PWM_UNIT_AUTO;
    }
    if (s.r === R_ADC && typeof s.a === "number" && s.a >= 0 && s.a <= 2)
      model.adcFmt[s.n] = s.a;
    count++;
  }
  // Rebuild buses: adopt each stored id (so device cfg keeps targeting the same
  // bus ids across reloads), then re-bind its pins through setBusSlot, which
  // restores roles[]=R_I2C and the pinBus back-pointers.
  if (Array.isArray(obj.buses)) {
    for (const b of obj.buses) {
      if (typeof b?.id !== "number" || !Number.isInteger(b.id)) continue;
      const nb = model.addBus();
      nb.id = b.id;
      model.adoptBusId(b.id);
      nb.freq = typeof b.freq === "number" && b.freq > 0 ? b.freq : 400000;
      if (typeof b.sda === "number" && b.sda >= 0 && b.sda < SLOTS)
        model.setBusSlot(nb.id, "sda", b.sda);
      if (typeof b.scl === "number" && b.scl >= 0 && b.scl < SLOTS)
        model.setBusSlot(nb.id, "scl", b.scl);
      count++;
    }
  }
  // Rebuild UARTs the same way: adopt stored ids, re-bind tx/rx through
  // setUartSlot (restores roles[]=R_UART + uartPinBus). A bus may have only one
  // line bound (tx- or rx-only), so bind each pin independently.
  if (Array.isArray(obj.uarts)) {
    for (const b of obj.uarts) {
      if (typeof b?.id !== "number" || !Number.isInteger(b.id)) continue;
      const nb = model.addUartBus();
      nb.id = b.id;
      model.adoptUartBusId(b.id);
      nb.baud = typeof b.baud === "number" && b.baud > 0 ? b.baud : 115200;
      if (typeof b.tx === "number" && b.tx >= 0 && b.tx < SLOTS) model.setUartSlot(nb.id, "tx", b.tx);
      if (typeof b.rx === "number" && b.rx >= 0 && b.rx < SLOTS) model.setUartSlot(nb.id, "rx", b.rx);
      count++;
    }
  }
  return count;
}

// Replaces the model config with the stored one; returns the number applied.
export function loadConfig(model: PinModel): number {
  let obj: any;
  try {
    obj = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return 0;
  }
  if (!obj || !Array.isArray(obj.pins)) return 0;
  return applySnapshot(model, obj);
}

// Read a config file the user picked. Throws on unreadable input so the caller
// can say so instead of silently applying half a file.
export function importConfig(model: PinModel, text: string): number {
  const obj = JSON.parse(text);
  if (!obj || !Array.isArray(obj.pins)) throw new Error("not a PicoHarness config file");
  return applySnapshot(model, obj);
}

// Pretty-printed, so an exported file stays hand-editable.
export function configText(model: PinModel): string {
  return JSON.stringify(snapshotOf(model), null, 2);
}

export function clearStored(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

export function blankConfig(model: PinModel): void {
  applySnapshot(model, { pins: [], buses: [], uarts: [] });
}
