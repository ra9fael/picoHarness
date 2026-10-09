// Single source of UI truth for the workbench: per-pin role (pool / input /
// output / pwm), pull settings, PWM params, plus the last-known device state.
// Drivers mutate it; views subscribe to "levels" for targeted LED refresh
// instead of full re-renders.
import { Emitter } from "../core/events";
import type { JsonMsg } from "../types";

export const NUM = 27;
export const R_IN = 1, R_OUT = 2, R_PWM = 3;

export type PwmParam = { freq: number; duty: number };

export class PinModel extends Emitter {
  roles = new Uint8Array(NUM); // 0 = pool, else R_*
  pulls = new Uint8Array(NUM); // inputs: 0 up, 1 down, 2 none
  pwm: (PwmParam | null)[] = new Array(NUM).fill(null);
  pwmUnit = new Uint8Array(NUM); // display exponent: 0 Hz, 3 kHz, 6 MHz
  devIn = 0;
  devOut = 0;
  devPwm = 0;
  sel: number | null = null;
  private pwmCaps: number[] | null = null; // firmware caps.pwm; null = unknown

  setCaps(caps: any): void {
    this.pwmCaps = Array.isArray(caps?.pwm) ? caps.pwm.map(Number) : null;
  }

  get capsKnown(): boolean {
    return this.pwmCaps !== null;
  }

  pwmCap(n: number): boolean {
    return !this.pwmCaps || this.pwmCaps.includes(n);
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

  // Edge-pushed input levels from firmware.
  applyEvent(m: JsonMsg): void {
    if (m.evt !== "gpio_in" || typeof m.in !== "number") return;
    this.devIn = m.in >>> 0;
    this.emit("levels");
  }

  // Adopt a device state payload. fromCmd=true means the reply is already
  // authoritative for this command; poll replies additionally report drift
  // so the caller can self-heal after a device soft reset.
  applyState(d: any, fromCmd: boolean): { gpioDrift: boolean; pwmDrift: boolean } {
    this.devIn = d.in >>> 0;
    this.devOut = d.out >>> 0;
    this.devPwm = (d.cfg_pwm ?? 0) >>> 0;
    this.emit("levels");
    if (fromCmd) return { gpioDrift: false, pwmDrift: false };
    const w = this.cfgMasks();
    const gpioDrift =
      d.cfg_in !== w.in || d.cfg_out !== w.out ||
      (d.cfg_pd >>> 0) !== w.pd || (d.cfg_pn >>> 0) !== w.pn;
    const pwmDrift = (d.cfg_pwm ?? 0) !== this.pwmMask();
    return { gpioDrift, pwmDrift };
  }
}
