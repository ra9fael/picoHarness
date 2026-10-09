// IO workbench (方案A): pin pool + function lanes (input / output / PWM).
// Drag a GP chip into a lane, or click chip then lane; releases go back to
// the pool. Each pin belongs to exactly one function; changes apply instantly.
import type { SerialLink, JsonMsg } from "./serial";
import { t, tf, type MsgKey } from "./i18n";

const NUM = 27;
const POLL_MS = 1000; // reconciliation only — live levels arrive via gpio_in events
const R_IN = 1, R_OUT = 2, R_PWM = 3;

const svg = (p: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square">${p}</svg>`;
const ICON: Record<number, string> = {
  [R_IN]: svg('<path d="M2 12h9"/><path d="M8 8l4 4-4 4"/><rect x="14" y="5" width="8" height="14"/>'),
  [R_OUT]: svg('<rect x="2" y="5" width="8" height="14"/><path d="M13 12h9"/><path d="M18 8l4 4-4 4"/>'),
  [R_PWM]: svg('<polyline points="2,17 6,17 6,7 11,7 11,17 16,17 16,7 22,7"/>'),
};
const LANES: { role: number; key: MsgKey; cls: string }[] = [
  { role: R_IN, key: "lane_in", cls: "l-in" },
  { role: R_OUT, key: "lane_out", cls: "l-out" },
  { role: R_PWM, key: "lane_pwm", cls: "l-pwm" },
];
const PULL_KEYS: MsgKey[] = ["pull_up", "pull_down", "pull_none"];

const el = (cls: string, tag = "div") => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class GpioPanel {
  private roles = new Uint8Array(NUM); // UI truth: 0 pool, 1 in, 2 out, 3 pwm
  private pulls = new Uint8Array(NUM); // inputs: 0 up, 1 down, 2 none
  private pwm: ({ freq: number; duty: number } | null)[] = new Array(NUM).fill(null);
  private devIn = 0;
  private devOut = 0;
  private devPwm = 0;
  private sel: number | null = null;
  private pwmCaps: number[] | null = null; // firmware caps.pwm; null = unknown
  private labEls = new Map<MsgKey, HTMLElement>();
  private zoneEls = new Map<number, HTMLElement>();
  private lvlEls: (HTMLElement | null)[] = new Array(NUM).fill(null); // per-pin level indicator
  private hintEl: HTMLElement;
  private poolEl: HTMLElement;
  private cfgTimer: ReturnType<typeof setTimeout> | 0 = 0;
  private pwmTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pollT: ReturnType<typeof setInterval> | 0 = 0;
  private busy = false;
  private _active = false;

  constructor(
    private link: SerialLink,
    private mount: HTMLElement,
    private onNote: (msg: string) => void = () => {},
  ) {
    this.hintEl = el("wb-hint");
    this.poolEl = el("wb-zone wb-pool");
    this.poolEl.dataset.role = "0";
    const lanes = el("wb-lanes");
    for (const L of LANES) {
      const card = el("wb-lane " + L.cls);
      const head = el("wb-lane-head");
      head.innerHTML = ICON[L.role];
      const b = document.createElement("b");
      head.appendChild(b);
      const zone = el("wb-zone wb-list");
      zone.dataset.role = String(L.role);
      card.append(head, zone);
      lanes.appendChild(card);
      this.labEls.set(L.key, b);
      this.zoneEls.set(L.role, zone);
    }
    for (const z of [this.poolEl, ...this.zoneEls.values()]) {
      const role = Number(z.dataset.role);
      z.addEventListener("dragover", (e) => {
        if (this.canDrop(role)) e.preventDefault();
      });
      z.addEventListener("drop", (e) => {
        e.preventDefault();
        const n = Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isInteger(n) && n >= 0 && n < NUM) this.assign(n, role);
      });
    }
    document.addEventListener("click", (e) => {
      if (this.sel !== null && !this.mount.contains(e.target as Node)) {
        this.sel = null;
        this.render();
      }
    });
    mount.append(this.hintEl, this.poolEl, lanes);
    this.refreshLang();
    this.render();
  }

  refreshLang() {
    for (const [k, e] of this.labEls) e.textContent = t(k);
    this.render();
  }

  setCaps(caps: any) {
    this.pwmCaps = Array.isArray(caps?.pwm) ? caps.pwm.map(Number) : null;
    this.render();
  }

  // Edge-pushed input levels from firmware (asyncio gpio_monitor).
  onEvent(m: JsonMsg) {
    if (m.evt !== "gpio_in" || typeof m.in !== "number") return;
    this.devIn = m.in >>> 0;
    this.updateLeds();
  }

  get active() {
    return this._active;
  }

  async setActive(a: boolean) {
    if (a === this._active) return;
    this._active = a;
    this.mount.classList.toggle("idle", !a);
    if (a) {
      await this.sendCfg();
      if (!this._active) return;
      for (let n = 0; n < NUM; n++) if (this.roles[n] === R_PWM) this.sendPwm(n);
      this.pollOnce();
      this.pollT = setInterval(() => this.pollOnce(), POLL_MS);
    } else if (this.pollT) {
      clearInterval(this.pollT);
      this.pollT = 0;
    }
  }

  // —— 分配模型 ——
  private pwmCap(n: number) {
    return !this.pwmCaps || this.pwmCaps.includes(n);
  }

  private canDrop(role: number) {
    if (this.sel === null) return false;
    const cur = this.roles[this.sel];
    if (role === 0) return cur !== 0;
    if (cur === role) return false;
    if (role === R_PWM && !this.pwmCap(this.sel)) return false;
    return this.link.state === "ready";
  }

  private assign(n: number, role: number) {
    if (role === R_PWM && !this.pwmCap(n)) {
      this.hintFail(tf("hint_no_pwm", n));
      return;
    }
    const old = this.roles[n];
    this.sel = null;
    if (old === role) {
      this.render();
      return;
    }
    this.roles[n] = role;
    if (role === R_PWM && !this.pwm[n]) this.pwm[n] = { freq: 1000, duty: 50 };
    if (old === R_PWM && role !== R_PWM) this.stopPwm(n);
    this.scheduleCfg();
    this.render();
  }

  // —— 下发 ——
  private cfgMasks() {
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

  private pwmMask() {
    let m = 0;
    for (let n = 0; n < NUM; n++) if (this.roles[n] === R_PWM) m |= 1 << n;
    return m;
  }

  private scheduleCfg() {
    this.render();
    if (!this.cfgTimer) {
      this.cfgTimer = setTimeout(() => {
        this.cfgTimer = 0;
        this.sendCfg();
      }, 120);
    }
  }

  private fail(msg: string) {
    if (this._active && this.link.state === "ready") this.onNote(msg);
  }

  private async sendCfg() {
    if (this.busy || this.link.state !== "ready") return;
    this.busy = true;
    try {
      const r = await this.link.sendCmd("gpio.cfg", this.cfgMasks());
      if (r.ok) this.sync(r.data, true);
      else this.fail(tf("gpio_cmd_fail", String(r.error)));
    } catch (e: any) {
      this.fail(tf("gpio_apply_fail", e.message));
    } finally {
      this.busy = false;
    }
  }

  private schedulePwm(n: number) {
    const old = this.pwmTimers.get(n);
    if (old) clearTimeout(old);
    this.pwmTimers.set(
      n,
      setTimeout(() => {
        this.pwmTimers.delete(n);
        this.sendPwm(n);
      }, 250),
    );
  }

  private async sendPwm(n: number) {
    const p = this.pwm[n];
    if (!p || this.link.state !== "ready") return;
    try {
      const r = await this.link.sendCmd("pwm.cfg", { pin: n, freq: p.freq, duty: p.duty / 100 });
      if (!r.ok) this.fail(tf("gpio_cmd_fail", String(r.error)));
      else this.sync(r.data, true);
    } catch (e: any) {
      this.fail(tf("gpio_apply_fail", e.message));
    }
  }

  private stopPwm(n: number) {
    this.pwm[n] = null;
    const t = this.pwmTimers.get(n);
    if (t) clearTimeout(t);
    this.pwmTimers.delete(n);
    if (this._active && this.link.state === "ready") {
      this.link.sendCmd("pwm.stop", { pin: n }).catch((e: any) => this.fail(tf("gpio_apply_fail", e.message)));
    }
  }

  private async flipOut(n: number) {
    if (this.link.state !== "ready") return;
    const bit = 1 << n;
    const val = ((this.devOut >> n) & 1) ^ 1;
    this.devOut = (this.devOut & ~bit) | (val << n); // optimistic: instant feedback
    this.updateLeds();
    try {
      const r = await this.link.sendCmd("gpio.out", { mask: bit, vals: val << n });
      if (r.ok) this.sync(r.data, true);
      else {
        this.devOut &= ~bit;
        if (!val) this.devOut |= bit;
        this.updateLeds();
        this.fail(tf("gpio_cmd_fail", String(r.error)));
      }
    } catch (e: any) {
      this.devOut &= ~bit;
      if (!val) this.devOut |= bit;
      this.updateLeds();
      this.fail(tf("gpio_apply_fail", e.message));
    }
  }

  private async pollOnce() {
    if (this.busy || !this._active || this.link.state !== "ready" || this.cfgTimer) return;
    if (this.link.pendingCount > 0) return;
    try {
      const r = await this.link.sendCmd("gpio.state", {});
      if (r.ok) this.sync(r.data, false);
    } catch {}
  }

  private sync(d: any, fromCmd: boolean) {
    this.devIn = d.in >>> 0;
    this.devOut = d.out >>> 0;
    this.devPwm = (d.cfg_pwm ?? 0) >>> 0;
    this.updateLeds();
    if (fromCmd) return;
    // Self-heal after a device soft reset dropped the configuration.
    const w = this.cfgMasks();
    if (
      d.cfg_in !== w.in || d.cfg_out !== w.out ||
      (d.cfg_pd >>> 0) !== w.pd || (d.cfg_pn >>> 0) !== w.pn
    ) {
      this.scheduleCfg();
    }
    if ((d.cfg_pwm ?? 0) !== this.pwmMask()) {
      for (let n = 0; n < NUM; n++) if (this.roles[n] === R_PWM) this.schedulePwm(n);
    }
  }

  // —— 渲染 ——
  private mkChip(n: number): HTMLElement {
    const c = el("chip", "span");
    c.draggable = this._active;
    const role = this.roles[n];
    const caps = this.pwmCaps && this.pwmCap(n) ? "P" : "";
    c.innerHTML = `<b>GP${n}</b>${caps ? `<span class="caps">${caps}</span>` : ""}`;
    if (role === R_IN) {
      const lvl = el("lvl" + (((this.devIn >> n) & 1) ? " hi" : ""), "span");
      this.lvlEls[n] = lvl;
      c.appendChild(lvl);
      const b = el("mini", "button") as HTMLButtonElement;
      b.dataset.act = "pull";
      b.textContent = t(PULL_KEYS[this.pulls[n]]);
      c.appendChild(b);
    } else if (role === R_OUT) {
      const b = el("led" + (((this.devOut >> n) & 1) ? " hi" : ""), "button") as HTMLButtonElement;
      b.dataset.act = "led";
      this.lvlEls[n] = b;
      c.appendChild(b);
    } else if (role === R_PWM && this.pwm[n]) {
      const p = this.pwm[n]!;
      const u = (s: string) => {
        const e = el("unit", "span");
        e.textContent = s;
        return e;
      };
      c.append(this.numIn(n, p, "freq"), u("Hz"), this.numIn(n, p, "duty"), u("%"));
    }
    if (role !== 0) {
      const x = el("rel", "button") as HTMLButtonElement;
      x.dataset.act = "rel";
      x.textContent = "×";
      c.appendChild(x);
    }
    if (this.sel === n) c.classList.add("sel");
    c.addEventListener("dragstart", (e) => {
      this.sel = n;
      e.dataTransfer?.setData("text/plain", String(n));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      this.markZones();
    });
    c.addEventListener("dragend", () => this.markZones());
    c.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).dataset?.act;
      if (act === "rel") return this.assign(n, 0);
      if (act === "pull") {
        this.pulls[n] = (this.pulls[n] + 1) % 3;
        return this.scheduleCfg();
      }
      if (act === "led") return void this.flipOut(n);
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      this.sel = this.sel === n ? null : n;
      this.render();
    });
    return c;
  }

  private numIn(n: number, p: { freq: number; duty: number }, which: "freq" | "duty"): HTMLElement {
    const i = el("pwm-in", "input") as HTMLInputElement;
    i.type = "number";
    if (which === "freq") {
      i.min = "1"; i.max = "200000"; i.step = "1"; i.value = String(p.freq);
      i.title = "Hz";
    } else {
      i.min = "0"; i.max = "100"; i.step = "1"; i.value = String(p.duty);
      i.title = "%";
    }
    i.addEventListener("change", () => {
      if (which === "freq") p.freq = clamp(Math.round(+i.value || 1), 1, 200000);
      else p.duty = clamp(+i.value || 0, 0, 100);
      this.schedulePwm(n);
    });
    return i;
  }

  private markZones() {
    const zones: [number, HTMLElement][] = [[0, this.poolEl], ...this.zoneEls];
    for (const [role, z] of zones) {
      z.classList.remove("compat", "dim");
      if (this.sel !== null) z.classList.add(this.canDrop(role) ? "compat" : "dim");
    }
  }

  private hintLock = 0;

  private hintFail(msg: string) {
    this.hintLock = Date.now() + 1500;
    this.hintEl.textContent = msg;
    this.hintEl.className = "wb-hint bad";
    setTimeout(() => this.render(), 1600);
  }

  private render() {
    this.poolEl.innerHTML = "";
    for (const z of this.zoneEls.values()) z.innerHTML = "";
    this.lvlEls = new Array(NUM).fill(null);
    for (let n = 0; n < NUM; n++) {
      const r = this.roles[n];
      (r === 0 ? this.poolEl : this.zoneEls.get(r)!).appendChild(this.mkChip(n));
    }
    this.markZones();
    if (Date.now() < this.hintLock) return;
    this.hintEl.textContent = this.sel !== null ? tf("hint_sel", this.sel) : t("wb_help");
    this.hintEl.className = "wb-hint" + (this.sel !== null ? " act" : "");
  }

  // Polling updates only the level indicators — rebuilding chips here would
  // destroy the PWM number inputs mid-typing and eat in-flight clicks.
  private updateLeds() {
    for (let n = 0; n < NUM; n++) {
      const e = this.lvlEls[n];
      if (!e) continue;
      const hi = this.roles[n] === R_OUT ? (this.devOut >> n) & 1 : (this.devIn >> n) & 1;
      e.classList.toggle("hi", !!hi);
    }
  }
}
