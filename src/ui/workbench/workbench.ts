// Workbench engine: pin pool + one lane per registered FunctionDef.
// It owns selection/drag-drop rules, chip scaffolding and the slow
// reconciliation poll; all function-specific behavior lives in the defs.
// Adding I2C/SPI later = write a def module and push it into this.defs.
import type { SerialLink, JsonMsg } from "../serial";
import { PinModel, NUM } from "../model/pins";
import { t, tf, type MsgKey } from "../i18n";
import { el } from "./dom";
import type { FuncApi, FunctionDef } from "./types";
import { DigitalDriver, makeDigitalDefs } from "./digital";
import { PwmDriver, makePwmDef } from "./pwm";

const POLL_MS = 1000; // drift reconciliation; live levels come via gpio_in

export class Workbench {
  readonly model = new PinModel();
  private api: FuncApi;
  private digital: DigitalDriver;
  private pwm: PwmDriver;
  private defs: FunctionDef[];
  private labEls = new Map<MsgKey, HTMLElement>();
  private zoneEls = new Map<number, HTMLElement>();
  private levelEls: (HTMLElement | null)[] = new Array(NUM).fill(null);
  private hintEl: HTMLElement;
  private poolEl: HTMLElement;
  private hintLock = 0;
  private pollT: ReturnType<typeof setInterval> | 0 = 0;
  private _active = false;

  constructor(
    private link: SerialLink,
    private mount: HTMLElement,
    private onNote: (msg: string) => void = () => {},
  ) {
    const api: FuncApi = {
      model: this.model,
      link: this.link,
      note: onNote,
      rerender: () => this.render(),
      scheduleGpio: () => this.digital.schedule(),
      sendGpioNow: () => this.digital.sendNow(),
      flipOut: (n) => void this.digital.flipOut(n),
      schedulePwm: (n) => this.pwm.schedule(n),
      stopPwm: (n) => this.pwm.stop(n),
    };
    this.api = api;
    this.digital = new DigitalDriver(api);
    this.pwm = new PwmDriver(api);
    this.defs = [...makeDigitalDefs(this.digital), makePwmDef(this.pwm)];
    this.model.on("levels", () => this.updateLeds());

    this.hintEl = el("wb-hint");
    this.poolEl = el("wb-zone wb-pool");
    const lanes = el("wb-lanes");
    for (const def of this.defs) {
      const card = el("wb-lane " + def.cls);
      const head = el("wb-lane-head");
      head.innerHTML = def.icon;
      const b = document.createElement("b");
      head.appendChild(b);
      const zone = el("wb-zone wb-list");
      zone.dataset.role = String(def.role);
      card.append(head, zone);
      lanes.appendChild(card);
      this.labEls.set(def.labelKey, b);
      this.zoneEls.set(def.role, zone);
    }
    for (const z of [this.poolEl, ...this.zoneEls.values()]) {
      const role = Number(z.dataset.role ?? 0);
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
      if (this.model.sel !== null && !mount.contains(e.target as Node)) {
        this.model.sel = null;
        this.render();
      }
    });
    mount.append(this.hintEl, this.poolEl, lanes);
    this.refreshLang();
    this.render();
  }

  get active(): boolean {
    return this._active;
  }

  refreshLang(): void {
    for (const [k, e] of this.labEls) e.textContent = t(k);
    this.render();
  }

  setCaps(caps: any): void {
    this.model.setCaps(caps);
    this.render();
  }

  onEvent(m: JsonMsg): void {
    this.model.applyEvent(m);
  }

  async setActive(a: boolean): Promise<void> {
    if (a === this._active) return;
    this._active = a;
    this.mount.classList.toggle("idle", !a);
    if (a) {
      await this.digital.sendNow();
      if (!this._active) return;
      for (const def of this.defs) def.activate(this.api);
      void this.pollOnce();
      this.pollT = setInterval(() => void this.pollOnce(), POLL_MS);
    } else if (this.pollT) {
      clearInterval(this.pollT);
      this.pollT = 0;
    }
  }

  // —— 分配模型 ——
  private defOf(role: number): FunctionDef | null {
    if (role === 0) return null;
    return this.defs.find((d) => d.role === role) ?? null;
  }

  private canDrop(role: number): boolean {
    const { model } = this;
    if (model.sel === null) return false;
    const n = model.sel;
    const cur = model.roles[n];
    if (role === 0) return cur !== 0;
    if (cur === role) return false;
    const def = this.defOf(role);
    if (!def || !def.accept(this.api, n)) return false;
    return this.link.state === "ready";
  }

  private assign(n: number, role: number): void {
    const def = this.defOf(role);
    if (role !== 0 && (!def || !def.accept(this.api, n))) {
      this.hintFail(tf("hint_no_pwm", n));
      return;
    }
    const old = this.defOf(this.model.roles[n]);
    this.model.sel = null;
    if (this.model.roles[n] === role) {
      this.render();
      return;
    }
    if (old) old.release(this.api, n);
    this.model.roles[n] = role;
    if (def) def.assign(this.api, n);
    this.render();
  }

  private async pollOnce(): Promise<void> {
    if (
      this.digital.busy || this.digital.scheduling ||
      !this._active || this.link.state !== "ready" ||
      this.link.pendingCount > 0
    )
      return;
    try {
      const r = await this.link.sendCmd("gpio.state", {});
      if (!r.ok) return;
      const drift = this.model.applyState(r.data, false);
      if (drift.gpioDrift) this.digital.schedule();
      if (drift.pwmDrift) this.pwm.scheduleAll();
    } catch {}
  }

  // —— 渲染 ——
  private mkChip(n: number, def: FunctionDef | null): HTMLElement {
    const c = el("chip", "span");
    c.draggable = this._active;
    const caps = this.model.capsKnown && this.model.pwmCap(n) ? "P" : "";
    c.innerHTML = `<b>GP${n}</b>${caps ? `<span class="caps">${caps}</span>` : ""}`;
    this.levelEls[n] = null;
    if (def) {
      const view = def.chip(this.api, n);
      c.append(...view.els);
      if (view.levelEl) this.levelEls[n] = view.levelEl;
      const x = el("rel", "button") as HTMLButtonElement;
      x.textContent = "×";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        this.assign(n, 0);
      });
      c.appendChild(x);
    }
    if (this.model.sel === n) c.classList.add("sel");
    c.addEventListener("dragstart", (e) => {
      this.model.sel = n;
      e.dataTransfer?.setData("text/plain", String(n));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      this.markZones();
    });
    c.addEventListener("dragend", () => this.markZones());
    c.addEventListener("click", (e) => {
      // render() detaches this very chip, so the outside-click document
      // handler would see a stale target and deselect instantly.
      e.stopPropagation();
      this.model.sel = this.model.sel === n ? null : n;
      this.render();
    });
    return c;
  }

  private markZones(): void {
    const zones: [number, HTMLElement][] = [[0, this.poolEl], ...this.zoneEls];
    for (const [role, z] of zones) {
      z.classList.remove("compat", "dim");
      if (this.model.sel !== null) z.classList.add(this.canDrop(role) ? "compat" : "dim");
    }
  }

  private hintFail(msg: string): void {
    this.hintLock = Date.now() + 1500;
    this.hintEl.textContent = msg;
    this.hintEl.className = "wb-hint bad";
    setTimeout(() => this.render(), 1600);
  }

  private render(): void {
    this.poolEl.innerHTML = "";
    for (const z of this.zoneEls.values()) z.innerHTML = "";
    this.levelEls = new Array(NUM).fill(null);
    for (let n = 0; n < NUM; n++) {
      const def = this.defOf(this.model.roles[n]);
      (def ? this.zoneEls.get(def.role)! : this.poolEl).appendChild(this.mkChip(n, def));
    }
    this.markZones();
    if (Date.now() < this.hintLock) return;
    this.hintEl.textContent =
      this.model.sel !== null ? tf("hint_sel", this.model.sel) : t("wb_help");
    this.hintEl.className = "wb-hint" + (this.model.sel !== null ? " act" : "");
  }

  // Level changes only toggle classes on the elements defs registered via
  // ChipView.levelEl — rebuilding chips would destroy inputs mid-typing.
  private updateLeds(): void {
    for (let n = 0; n < NUM; n++) {
      const e = this.levelEls[n];
      if (!e) continue;
      e.classList.toggle("hi", !!this.model.level(n));
    }
  }
}
