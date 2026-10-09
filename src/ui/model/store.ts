// localStorage persistence of the workbench configuration (lane assignment,
// pulls, PWM params). Restored silently on page load; the device catches up
// through the normal gpio.cfg sendNow + pwm drift-reconciliation path once
// the link becomes ready, so no restore-time commands are needed here.
import type { PinModel } from "./pins";
import { NUM, R_PWM } from "./pins";

const KEY = "picoharness-config-v1";

export type PinSnap = { n: number; r: number; p: number; f?: number; d?: number; u?: number };

export function saveConfig(model: PinModel): void {
  const pins: PinSnap[] = [];
  for (let n = 0; n < NUM; n++) {
    const r = model.roles[n];
    if (!r) continue;
    const s: PinSnap = { n, r, p: model.pulls[n] };
    const pw = model.pwm[n];
    if (r === R_PWM && pw) {
      s.f = pw.freq;
      s.d = pw.duty;
      s.u = model.pwmUnit[n];
    }
    pins.push(s);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, pins }));
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
  model.pwmUnit.fill(0);
  let count = 0;
  for (const s of obj.pins) {
    if (typeof s?.n !== "number" || s.n < 0 || s.n >= NUM || !Number.isInteger(s.n)) continue;
    if (s.r !== 1 && s.r !== 2 && s.r !== 3) continue;
    model.roles[s.n] = s.r;
    if (s.r === 1 && (s.p === 0 || s.p === 1 || s.p === 2)) model.pulls[s.n] = s.p;
    if (s.r === R_PWM && typeof s.f === "number" && s.f >= 1) {
      model.pwm[s.n] = {
        freq: Math.round(s.f),
        duty: typeof s.d === "number" ? Math.min(Math.max(s.d, 0), 100) : 50,
      };
      model.pwmUnit[s.n] = typeof s.u === "number" ? s.u : 0;
    }
    count++;
  }
  return count;
}
