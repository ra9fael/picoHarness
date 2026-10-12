// Workbench engine: pin pool + one lane per registered FunctionDef.
// It owns selection/drag-drop rules, chip scaffolding and the slow
// reconciliation poll; all function-specific behavior lives in the defs.
// Adding I2C/SPI later = write a def module and push it into this.defs.
import type { SerialLink, JsonMsg } from "../serial";
import { PinModel, SLOTS, TEMP, R_ADC, R_PWM, R_I2C, R_UART, R_SPI, pinLabel } from "../model/pins";
import { blankConfig, clearStored, configText, importConfig as importSnapshot, loadConfig, saveConfig } from "../model/store";
import { t, tf, type MsgKey } from "../i18n";
import { el } from "./dom";
import type { FuncApi, FunctionDef } from "./types";
import { DigitalDriver, makeDigitalDefs } from "./digital";
import { PwmDriver, makePwmDef } from "./pwm";
import { AdcDriver, makeAdcDef, adcText } from "./adc";
import { I2cDriver, makeI2cDef } from "./i2c";
import { UartDriver, makeUartDef } from "./uart";
import { SpiDriver, makeSpiDef } from "./spi";

const POLL_MS = 1000; // drift reconciliation; live levels come via gpio_in

export class Workbench {
  readonly model = new PinModel();
  private api: FuncApi;
  private digital: DigitalDriver;
  private pwm: PwmDriver;
  private adc: AdcDriver;
  private i2c: I2cDriver;
  private uart: UartDriver;
  private spi: SpiDriver;
  private defs: FunctionDef[];
  private labEls = new Map<MsgKey, HTMLElement>();
  private zoneEls = new Map<number, HTMLElement>();
  private busRoles = new Set<number>(); // lanes that render their own bus cards
  private levelEls: (HTMLElement | null)[] = new Array(SLOTS).fill(null);
  private adcEls: (HTMLElement | null)[] = new Array(SLOTS).fill(null);
  private hintEl: HTMLElement;
  private poolEl: HTMLElement;
  private hintLock = 0;
  private pollT: ReturnType<typeof setInterval> | 0 = 0;
  private saveT: ReturnType<typeof setTimeout> | 0 = 0;
  private adcDirty = false;
  private adcT: ReturnType<typeof setInterval> | 0 = 0;
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
      scheduleAdc: (n) => this.adc.schedule(n),
      stopAdc: (n) => this.adc.stop(n),
      releasePin: (n) => {
        const def = this.defOf(this.model.roles[n]);
        if (!def || def.renderLane) return; // bus pins are un-bound via their card
        this.model.roles[n] = 0;
        def.release(this.api, n);
        this.model.changed();
      },
    };
    this.api = api;
    this.digital = new DigitalDriver(api);
    this.pwm = new PwmDriver(api);
    this.adc = new AdcDriver(api);
    this.i2c = new I2cDriver(this.model);
    this.uart = new UartDriver(this.model);
    this.spi = new SpiDriver(this.model);
    this.defs = [
      ...makeDigitalDefs(this.digital),
      makePwmDef(this.pwm),
      makeAdcDef(this.adc),
      makeI2cDef(this.i2c),
      makeUartDef(this.uart),
      makeSpiDef(this.spi),
    ];
    this.model.on("levels", () => this.updateLeds());
    // ADC events arrive in bursts (deadband) or once per stream batch; repaint
    // the chip digits on a fixed 250 ms tick instead of per-event so a busy
    // wire can't drive a layout storm, and the EMA has time to settle.
    this.model.on("adc", () => {
      this.adcDirty = true;
    });
    this.adcT = setInterval(() => {
      if (this.adcDirty) {
        this.adcDirty = false;
        this.updateAdc();
      }
    }, 250);
    loadConfig(this.model);
    this.model.on("config", () => this.saveSoon());

    this.hintEl = el("wb-hint");
    this.poolEl = el("wb-zone wb-pool");
    const lanes = el("wb-lanes");
    for (const def of this.defs) {
      const card = el("wb-lane " + def.cls);
      const head = el("wb-lane-head");
      head.innerHTML = def.icon;
      const b = document.createElement("b");
      head.appendChild(b);
      const isBus = !!def.renderLane;
      const zone = el(isBus ? "wb-zone wb-buszone" : "wb-zone wb-list");
      zone.dataset.role = String(def.role);
      card.append(head, zone);
      lanes.appendChild(card);
      this.labEls.set(def.labelKey, b);
      this.zoneEls.set(def.role, zone);
      if (isBus) this.busRoles.add(def.role);
    }
    // Generic lane wiring for the pool and the per-pin lanes; bus lanes bind
    // pins through their own labeled card slots.
    const dropZones: HTMLElement[] = [
      this.poolEl,
      ...[...this.zoneEls].filter(([r]) => !this.busRoles.has(r)).map(([, z]) => z),
    ];
    for (const z of dropZones) {
      const role = Number(z.dataset.role ?? 0);
      z.addEventListener("dragover", (e) => {
        if (this.canDrop(role)) e.preventDefault();
      });
      z.addEventListener("drop", (e) => {
        e.preventDefault();
        const n = Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isInteger(n) && n >= 0 && n < SLOTS) this.assign(n, role);
      });
      // A selected chip lights the eligible lanes (.compat), so a click on one
      // of them has to bind too — otherwise the glow promises a pointer-only
      // path that only drag ever delivered.
      z.addEventListener("click", () => {
        const n = this.model.sel;
        if (n !== null && this.canDrop(role)) this.assign(n, role);
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
    // A (re)handshake means the device's volatile bus configs are gone, so
    // clear each driver's rejection latch — otherwise a bus that failed on the
    // old firmware (or before a reboot) would be skipped by resync forever.
    this.i2c.resetLatch();
    this.uart.resetLatch();
    this.spi.resetLatch();
    this.pruneCaps();
    this.render();
  }

  // A binding restored from an earlier session can name a pin the firmware now
  // connected cannot serve. The device would refuse it on every drift poll, so
  // the handshake un-binds those pins and names them instead of silently
  // disagreeing with the board.
  private pruneCaps(): void {
    const dropped = this.model.pruneAgainstCaps();
    if (!dropped.length) return;
    // Stopping the driver clears its pending send for a pin that is now in the
    // pool; the device owns nothing on these pins, so the reply is a no-op ok.
    for (const d of dropped) {
      if (d.role === R_ADC) this.adc.stop(d.pin);
      else if (d.role === R_PWM) this.pwm.stop(d.pin);
    }
    const byRole: Record<number, MsgKey> = {
      [R_PWM]: "cfg_pruned_pwm",
      [R_ADC]: "cfg_pruned_adc",
      [R_I2C]: "cfg_pruned_i2c",
      [R_UART]: "cfg_pruned_uart",
      [R_SPI]: "cfg_pruned_spi",
    };
    const groups = new Map<number, string>();
    for (const d of dropped) {
      groups.set(d.role, (groups.get(d.role) ?? "") + pinLabel(d.pin) + " ");
    }
    for (const [role, list] of groups) this.onNote(tf(byRole[role] ?? "cfg_pruned_pin", list.trim()));
    this.model.changed();
    this.render();
  }

  onEvent(m: JsonMsg): void {
    this.model.applyEvent(m);
  }

  // Config menu. An imported file goes through the same snapshot the browser
  // already stores, so the normal save + drift path pushes it to the device.
  exportConfig(): string {
    return configText(this.model);
  }

  importConfig(text: string): number {
    const n = importSnapshot(this.model, text);
    this.afterConfigChange();
    // A file may come from another board: with a live link the freshly loaded
    // bindings are checked against the caps we already know.
    if (this.link.state === "ready") this.pruneCaps();
    return n;
  }

  resetConfig(): void {
    blankConfig(this.model);
    this.afterConfigChange();
    clearStored();
  }

  private afterConfigChange(): void {
    this.model.emit("config");
    this.render();
  }

  // Coalesce bursts of edits into one localStorage write per quiet window.
  private saveSoon(): void {
    if (this.saveT) return;
    this.saveT = setTimeout(() => {
      this.saveT = 0;
      saveConfig(this.model);
    }, 400);
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
    if (this.busRoles.has(role)) return false; // bus lanes bind via card slots
    if (model.sel === null) return false;
    const n = model.sel;
    const cur = model.roles[n];
    if (role === 0) return cur !== 0;
    if (cur === role) return false;
    if (n === TEMP && role !== R_ADC) return false; // temperature is ADC-only
    const def = this.defOf(role);
    if (!def || !def.accept(this.api, n)) return false;
    return this.link.state === "ready";
  }

  private assign(n: number, role: number): void {
    const def = this.defOf(role);
    if (role !== 0 && (!def || !def.accept(this.api, n))) {
      this.hintFail(tf("hint_no_pwm", pinLabel(n)));
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
    this.model.changed();
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
      if (drift.adcDrift) this.adc.scheduleAll();
      if (drift.i2cDrift) this.i2c.resync();
      if (drift.uartDrift) this.uart.resync();
      if (drift.spiDrift) this.spi.resync();
    } catch {}
  }

  // —— 渲染 ——
  private mkChip(n: number, def: FunctionDef | null): HTMLElement {
    const c = el("chip", "span");
    c.draggable = this._active;
    let i2cBadge = "";
    if (this.model.i2cPairKnown) {
      // rp2 I2C roles are exclusive (SCL = odd, SDA = even), so a pin is one or
      // the other — the badge literally tells you which line it belongs on.
      i2cBadge = this.model.i2cRoleCap(n, "scl") ? "S" : this.model.i2cRoleCap(n, "sda") ? "D" : "";
    }
    let uartBadge = "";
    if (this.model.uartKnown) {
      // A UART pin may be TX-capable, RX-capable, or both, so concatenate.
      const t = this.model.uartRoleCap(n, "tx");
      const r = this.model.uartRoleCap(n, "rx");
      uartBadge = (t ? "T" : "") + (r ? "R" : "");
    }
    const caps =
      (this.model.capsKnown && this.model.pwmCap(n) ? "P" : "") +
      (this.model.capsKnown && this.model.adcCap(n) ? "A" : "") +
      i2cBadge +
      uartBadge;
    c.innerHTML = `<b>${pinLabel(n)}</b>${caps ? `<span class="caps">${caps}</span>` : ""}`;
    this.levelEls[n] = null;
    this.adcEls[n] = null;
    if (def) {
      const view = def.chip(this.api, n);
      c.append(...view.els);
      if (view.levelEl) this.levelEls[n] = view.levelEl;
      if (view.adcEl) this.adcEls[n] = view.adcEl;
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
      if (this.busRoles.has(role)) continue; // bus lanes highlight their own slots
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
    // per-pin lanes are rebuilt from scratch; bus lanes render themselves
    // incrementally (their transaction consoles must survive a re-render).
    for (const [role, z] of this.zoneEls) if (!this.busRoles.has(role)) z.innerHTML = "";
    this.levelEls = new Array(SLOTS).fill(null);
    this.adcEls = new Array(SLOTS).fill(null);
    for (let n = 0; n < SLOTS; n++) {
      const role = this.model.roles[n];
      if (this.busRoles.has(role)) continue; // shown inside its bus card slot
      const def = this.defOf(role);
      (def ? this.zoneEls.get(def.role)! : this.poolEl).appendChild(this.mkChip(n, def));
    }
    for (const def of this.defs)
      if (def.renderLane) def.renderLane(this.api, this.zoneEls.get(def.role)!);
    this.markZones();
    if (Date.now() < this.hintLock) return;
    this.hintEl.textContent =
      this.model.sel !== null ? tf("hint_sel", pinLabel(this.model.sel)) : t("wb_help");
    this.hintEl.className = "wb-hint" + (this.model.sel !== null ? " act" : "");
  }

  // Level changes only toggle classes on the elements defs registered via
  // ChipView.levelEl — rebuilding chips would destroy inputs mid-typing.
  private updateLeds(): void {
    for (let n = 0; n < SLOTS; n++) {
      const e = this.levelEls[n];
      if (!e) continue;
      e.classList.toggle("hi", !!this.model.level(n));
    }
  }

  private updateAdc(): void {
    for (let n = 0; n < SLOTS; n++) {
      const e = this.adcEls[n];
      if (e) e.textContent = adcText(this.model, n);
    }
  }
}
