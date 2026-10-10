// localStorage persistence of the workbench configuration (lane assignment,
// pulls, PWM params). Restored silently on page load; the device catches up
// through the normal gpio.cfg sendNow + pwm drift-reconciliation path once
// the link becomes ready, so no restore-time commands are needed here.
import type { PinModel } from "./pins";
import { SLOTS, R_PWM, R_ADC, R_I2C, PWM_UNIT_AUTO } from "./pins";

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

export function saveConfig(model: PinModel): void {
  const pins: PinSnap[] = [];
  for (let n = 0; n < SLOTS; n++) {
    const r = model.roles[n];
    if (!r || r === R_I2C) continue; // bus pins are reconstructed from `buses`
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
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, pins, buses }));
  } catch {}
}

// Replaces the whole model config with the stored one; returns pin count.
export function loadConfig(model: PinModel): number {
  let obj: any;
  try {
    obj = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return 0;
  }
  if (!obj || !Array.isArray(obj.pins)) return 0;
  model.roles.fill(0);
  model.pulls.fill(0);
  model.pwm.fill(null);
  model.pwmUnit.fill(PWM_UNIT_AUTO);
  model.adcFmt.fill(0);
  model.buses = [];
  model.pinBus.fill(-1);
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
  return count;
}
