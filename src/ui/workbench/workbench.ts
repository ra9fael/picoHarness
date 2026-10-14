// Workbench engine: pin pool + one lane per registered FunctionDef.
// It owns selection/drag-drop rules, chip scaffolding and the slow
// reconciliation poll; all function-specific behavior lives in the defs.
// Adding I2C/SPI later = write a def module and push it into this.defs.
import type { SerialLink, JsonMsg } from "../serial";
import { PinModel, SLOTS, C_ADC, C_SCL, C_SDA, C_TX, C_RX, C_SCK, C_MOSI, C_MISO, C_PWM, R_ADC, R_PWM, R_I2C, R_UART, R_SPI, pinLabel } from "../model/pins";
import { blankConfig, clearStored, configText, importConfig as importSnapshot, isBlank, loadConfig, sameConfig, saveConfig } from "../model/store";
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

// One row per badge letter: the caps table that has to have been reported before
// the letter may appear at all, the capability bit that lights it, and `first`
// when the role is disjoint on rp2 (a pin is either SCL or SDA, and one SPI line
// at a time) so only the first match of that group renders. TX and RX may stack,
// because a pin can carry both directions of different instances.
const BADGES: {
  gate: "pins" | "i2c" | "uart" | "spi";
  cap: number;
  t: string;
  k: MsgKey;
  first?: boolean;
}[] = [
  { gate: "pins", cap: C_PWM, t: "P", k: "cap_p" },
  { gate: "pins", cap: C_ADC, t: "A", k: "cap_a" },
  { gate: "i2c", cap: C_SCL, t: "S", k: "cap_s", first: true },
  { gate: "i2c", cap: C_SDA, t: "D", k: "cap_d", first: true },
  { gate: "uart", cap: C_TX, t: "T", k: "cap_t" },
  { gate: "uart", cap: C_RX, t: "R", k: "cap_r" },
  { gate: "spi", cap: C_SCK, t: "CK", k: "cap_ck", first: true },
  { gate: "spi", cap: C_MOSI, t: "DO", k: "cap_do", first: true },
  { gate: "spi", cap: C_MISO, t: "DI", k: "cap_di", first: true },
];

// What the board was told to hold, captured before a replacement wipes the model.
// Pin numbers and bus ids: exactly the two kinds of thing a device keeps doing
// after the workbench stops asking for them.
type Held = { pwm: number[]; adc: number[]; i2c: number[]; uart: number[]; spi: number[] };

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
      if (
        (this.model.sel !== null || this.model.slotSel !== null) &&
        !mount.contains(e.target as Node)
      ) {
        this.model.sel = null;
        this.model.slotSel = null;
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

  // What the device was told to own, as pin numbers and bus ids. Cheap to take, and
  // the only way to know what a whole-config replacement is about to drop.
  private heldByDevice(): Held {
    const { model } = this;
    const pins = (role: number): number[] => {
      const out: number[] = [];
      for (let n = 0; n < SLOTS; n++) if (model.roles[n] === role) out.push(n);
      return out;
    };
    return {
      pwm: pins(R_PWM),
      adc: pins(R_ADC),
      i2c: model.buses.map((b) => b.id),
      uart: model.uartBuses.map((b) => b.id),
      spi: model.spiBuses.map((b) => b.id),
    };
  }

  // The drift poll only ever re-issues what the model asks for; it never takes
  // anything back. So a config that replaces the whole model does the subtraction
  // here: a PWM channel the board still generates, an ADC monitor still subscribed,
  // a bus still holding its pins — invisible to the workbench, still live on the
  // fixture. What the new config keeps is left to the normal path, except PWM:
  // frequency and duty appear in no drift signature, so a file that only re-tunes a
  // running channel has to be pushed. GPIO needs neither, because its whole mask
  // goes over on every send and the firmware releases the pins that fell out of it.
  private reconcileReplaced(held: Held): void {
    const { model } = this;
    for (const n of held.pwm) if (model.roles[n] !== R_PWM) this.pwm.stop(n);
    for (const n of held.adc) if (model.roles[n] !== R_ADC) this.adc.stop(n);
    for (const id of held.i2c) if (!model.buses.some((b) => b.id === id)) this.i2c.forget(id);
    for (const id of held.uart)
      if (!model.uartBuses.some((b) => b.id === id)) this.uart.forget(id);
    for (const id of held.spi)
      if (!model.spiBuses.some((b) => b.id === id)) this.spi.forget(id);
    if (this.link.state === "ready") this.pwm.scheduleAll();
  }

  // Config menu. An imported file goes through the same snapshot the browser
  // already stores, so what it adds reaches the device by the normal drift path,
  // and what it drops is withdrawn at the replacement point.
  exportConfig(): string {
    return configText(this.model);
  }

  importConfig(text: string): number {
    const held = this.heldByDevice();
    const n = importSnapshot(this.model, text);
    this.reconcileReplaced(held);
    this.afterConfigChange();
    // A file may come from another board: with a live link the freshly loaded
    // bindings are checked against the caps we already know.
    if (this.link.state === "ready") this.pruneCaps();
    return n;
  }

  resetConfig(): void {
    const held = this.heldByDevice();
    blankConfig(this.model);
    this.reconcileReplaced(held);
    this.afterConfigChange();
    clearStored();
  }

  // —— device-side config vault ——
  // The board keeps the same snapshot an exported file holds, so every path into it
  // is the path a picked file already takes: fetch the text, hand it to the import
  // routine, let the normal dispatch push the result down to the pins. The firmware
  // stores these bytes without reading them (see its cfg.* handlers), which is what
  // keeps the schema owned here and nowhere else.
  get deviceCfg() {
    return this.model.cfgVault;
  }

  // The snapshot stored on the board, or null when it has never been written.
  async readDevice(): Promise<string | null> {
    const r = await this.link.sendCmd("cfg.get");
    if (!r.ok) throw new Error(String(r.error));
    return typeof r.data?.text === "string" ? r.data.text : null;
  }

  async writeDevice(): Promise<{ path: string; bytes: number }> {
    const vault = this.model.cfgVault;
    if (!vault) throw new Error(t("cfg_dev_absent"));
    // Refused here rather than at the button, so every path into the vault (menu,
    // future shortcut) answers the same way: the board said it cannot write.
    if (!vault.writable) throw new Error(t("cfg_dev_ro"));
    const text = configText(this.model);
    // Checked before the send, not after: the refusal would say the same thing, but
    // only after a few kilobytes have crawled over the wire.
    if (vault.maxBytes && text.length > vault.maxBytes)
      throw new Error(tf("cfg_dev_too_big", vault.maxBytes));
    const r = await this.link.sendCmd("cfg.save", { text });
    if (!r.ok) throw new Error(String(r.error));
    return { path: vault.path, bytes: Number(r.data?.bytes) || text.length };
  }

  async eraseDevice(): Promise<string> {
    const vault = this.model.cfgVault;
    // Deleting is a write to the volume, so a read-only mount refuses it too.
    if (vault && !vault.writable) throw new Error(t("cfg_dev_ro"));
    const r = await this.link.sendCmd("cfg.clear");
    if (!r.ok) throw new Error(String(r.error));
    return this.model.cfgVault?.path ?? String(r.data?.path ?? "");
  }

  // Whether the board's copy is the config already loaded; the connect-time check
  // asks this before it bothers the user with a choice.
  matchesDevice(text: string): boolean {
    return sameConfig(configText(this.model), text);
  }

  // Nothing bound here — the state a first run is in, where the board's copy is not
  // a competing config but the only one there is.
  get configIsBlank(): boolean {
    return isBlank(this.model);
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
    const gates = {
      pins: this.model.capsKnown,
      i2c: this.model.i2cPairKnown,
      uart: this.model.uartKnown,
      spi: this.model.spiKnown,
    };
    const badges: [string, MsgKey][] = [];
    const lit: Record<string, boolean> = {};
    for (const b of BADGES) {
      if (!gates[b.gate] || !this.model.hasCap(n, b.cap)) continue;
      if (b.first) {
        if (lit[b.gate]) continue;
        lit[b.gate] = true;
      }
      badges.push([b.t, b.k]);
    }
    c.innerHTML = `<b>${pinLabel(n)}</b>`;
    if (badges.length) {
      const wrap = el("caps", "span");
      for (const [txt, key] of badges) {
        const s = document.createElement("span");
        s.textContent = txt;
        s.title = t(key);
        wrap.appendChild(s);
      }
      c.appendChild(wrap);
    }
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
    // Reverse highlight: while a bus-card slot is focused, every chip is painted
    // by whether that slot could legally take it — glow means the drop or click
    // will work, dim means the firmware would refuse it.
    const slotOk = this.model.slotSelAccepts(n);
    if (slotOk !== null) c.classList.add(slotOk ? "compat" : "dim");
    c.addEventListener("dragstart", (e) => {
      this.model.sel = n;
      this.model.slotSel = null;
      e.dataTransfer?.setData("text/plain", String(n));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      this.markZones();
    });
    c.addEventListener("dragend", () => this.markZones());
    c.addEventListener("click", (e) => {
      // render() detaches this very chip, so the outside-click document
      // handler would see a stale target and deselect instantly.
      e.stopPropagation();
      if (this.bindFocused(n)) return; // a focused slot claims the click first
      this.model.sel = this.model.sel === n ? null : n;
      this.model.slotSel = null;
      this.render();
    });
    return c;
  }

  // The focused bus slot gets first claim on a chip click — that is the whole
  // point of lighting the pool. Returns false when the focus has gone stale (the
  // bus vanished, or this pin is no longer eligible), so the click still selects.
  private bindFocused(pin: number): boolean {
    const s = this.model.slotSel;
    if (!s) return false;
    const role = s.kind === "i2c" ? R_I2C : s.kind === "uart" ? R_UART : R_SPI;
    const def = this.defOf(role);
    // On success the driver has already cleared the focus and re-rendered.
    return !!def?.bindSlot?.(pin);
  }

  private markZones(): void {
    const zones: [number, HTMLElement][] = [[0, this.poolEl], ...this.zoneEls];
    for (const [role, z] of zones) {
      z.classList.remove("compat", "dim");
      if (this.busRoles.has(role)) continue; // bus lanes highlight their own slots
      if (this.model.sel !== null) z.classList.add(this.canDrop(role) ? "compat" : "dim");
    }
    // Which lane owns the focused slot decides the colour the pool glows in.
    const kind = this.model.slotSel ? "k-" + this.model.slotSel.kind : "";
    for (const k of ["k-i2c", "k-uart", "k-spi"]) this.poolEl.classList.toggle(k, k === kind);
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
      // Show the GPIOs this board can name, not every GPIO the chip has: a board
      // table like raspberry_pi_pico2_w leaves holes (GP23/24/25 are CYW43 pins
      // there) and stops short of GP47, and a chip the firmware cannot address
      // would be a chip that always refuses.
      if (!this.model.isOffered(n)) continue;
      const role = this.model.roles[n];
      if (this.busRoles.has(role)) continue; // shown inside its bus card slot
      const def = this.defOf(role);
      (def ? this.zoneEls.get(def.role)! : this.poolEl).appendChild(this.mkChip(n, def));
    }
    for (const def of this.defs)
      if (def.renderLane) def.renderLane(this.api, this.zoneEls.get(def.role)!);
    this.markZones();
    if (Date.now() < this.hintLock) return;
    const s = this.model.slotSel;
    this.hintEl.textContent =
      this.model.sel !== null
        ? tf("hint_sel", pinLabel(this.model.sel))
        : s !== null
          ? tf("hint_slot", s.role === "cs" ? "CS" + s.index : s.role.toUpperCase())
          : t("wb_help");
    this.hintEl.className = "wb-hint" + (this.model.sel !== null || s !== null ? " act" : "");
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
