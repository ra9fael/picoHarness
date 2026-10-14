// I2C bus lane — a multi-pin function, so it does not use the per-pin chip
// path. Each bus is a card with two labeled pin slots (SDA / SCL), a clock
// preset, and a raw-transaction console (scan / write / read / repeated-start
// write-read). Binding pins sends i2c.cfg; the firmware owns the pin pair in
// its arbiter and returns the authoritative state. rp2 PIO accepts almost any
// GP pair, so legality is decided by construction, not a boot caps table.
import { tf, type MsgKey } from "../i18n";
import { R_I2C, pinLabel, type I2cBus, type PinModel } from "../model/pins";
import { el } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

const FREQS = [100000, 400000, 1000000];
const MODES = ["w", "r", "wr"] as const; // write / read / repeated-start write-read

const parseHex = (s: string): number[] => {
  const clean = s.replace(/[^0-9a-fA-F]/g, "").match(/.{1,2}/g);
  return clean ? clean.map((h) => parseInt(h, 16)) : [];
};
const fmtHex = (a: number[]): string =>
  a.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join(" ");

type Draft = { addr: string; w: string; r: string; mode: string; out: string; busy: boolean };

// Per-bus card: kept across workbench re-renders so a transaction console the
// user is typing into is never rebuilt out from under them.
type BusCard = {
  root: HTMLElement;
  sda: HTMLElement;
  scl: HTMLElement;
  freq: HTMLSelectElement;
  addr: HTMLInputElement;
  wIn: HTMLInputElement;
  rIn: HTMLInputElement;
  mode: HTMLSelectElement;
  out: HTMLElement;
  btnScan: HTMLButtonElement;
  btnSend: HTMLButtonElement;
  draft: Draft;
  live: boolean; // device currently has this bus configured
  rejected: boolean; // firmware refused the last cfg (e.g. no pull-ups): stop auto-retrying
};

export class I2cDriver {
  private api: FuncApi | null = null;
  private cards = new Map<number, BusCard>();
  private addBtn: HTMLElement | null = null;

  constructor(private model: PinModel) {}

  // —— device coordination ——
  private cfgTimer = new Map<number, ReturnType<typeof setTimeout>>();

  private scheduleCfg(busId: number): void {
    const old = this.cfgTimer.get(busId);
    if (old) clearTimeout(old);
    this.cfgTimer.set(
      busId,
      setTimeout(() => {
        this.cfgTimer.delete(busId);
        void this.applyBus(busId);
      }, 150),
    );
  }

  // Reconcile one bus against the device: cfg it if complete, release it if not.
  async applyBus(busId: number): Promise<void> {
    const api = this.api;
    if (!api) return;
    const { link, note } = api;
    const b = this.model.busById(busId);
    const card = this.cards.get(busId);
    if (link.state !== "ready" || !b) return;
    if (!this.model.i2cComplete(b)) {
      if (card) card.rejected = false;
      if (card?.live) {
        await link.sendCmd("i2c.release", { id: b.id }).catch(() => {});
        if (card) card.live = false;
      }
      return;
    }
    try {
      const r = await link.sendCmd("i2c.cfg", { id: b.id, sda: b.sda, scl: b.scl, freq: b.freq });
      if (r.ok) {
        if (card) {
          card.live = true;
          card.rejected = false;
        }
        this.model.applyState(r.data, true);
      } else {
        if (card) {
          card.live = false;
          card.rejected = true;
        }
        note(tf("i2c_fail", String(r.error)));
      }
    } catch (e: any) {
      if (card) {
        card.live = false;
        card.rejected = true;
      }
      note(tf("i2c_fail", e.message));
    }
  }

  // Push every complete bus; called when the link becomes ready or on drift.
  // A bus the firmware rejected (bad pair / no pull-ups) is left alone — the
  // model never converges with a device that won't build it, so re-issuing on
  // every poll would just spam i2c.cfg. Only an explicit user edit retries it.
  resync(): void {
    for (const b of this.model.buses) {
      if (this.cards.get(b.id)?.rejected) continue;
      void this.applyBus(b.id);
    }
  }

  // A fresh handshake means a device whose volatile bus config was just lost
  // (reboot or firmware reflash). Forget the rejection/live latches so the next
  // resync re-issues i2c.cfg once per bus — a reconnect is a user-level retry.
  resetLatch(): void {
    for (const card of this.cards.values()) {
      card.live = false;
      card.rejected = false;
    }
  }

  // —— pin binding ——
  bind(busId: number, which: "sda" | "scl", pin: number): void {
    const api = this.api;
    if (!api || !this.model.isAddressable(pin)) return;
    const model = this.model;
    // free the pin from whatever non-bus function currently holds it
    const cur = model.roles[pin];
    if (cur !== 0 && cur !== R_I2C) api.releasePin(pin);
    model.setBusSlot(busId, which, pin);
    model.sel = null; // clear the pick so the slot affordance resets
    model.slotSel = null;
    model.changed();
    this.scheduleCfg(busId);
    api.rerender();
  }

  clearSlot(busId: number, which: "sda" | "scl"): void {
    const api = this.api;
    if (!api) return;
    this.model.setBusSlot(busId, which, -1);
    this.model.changed();
    void this.applyBus(busId);
    api.rerender();
  }

  removeBus(busId: number): void {
    const api = this.api;
    if (!api) return;
    this.forget(busId);
    this.model.removeBus(busId);
    this.model.changed();
    api.rerender();
  }

  // Teardown for a bus the model has already dropped, which is what a replaced
  // config does to every bus the new file does not name: no card was clicked, so
  // without this the board keeps owning the bus's pins until a reset.
  forget(busId: number): void {
    const card = this.cards.get(busId);
    if (card?.live && this.api?.link.state === "ready") {
      this.api.link.sendCmd("i2c.release", { id: busId }).catch(() => {});
    }
    const t = this.cfgTimer.get(busId);
    if (t) clearTimeout(t);
    this.cfgTimer.delete(busId);
    // remove the DOM here: render() does not clear bus zones, so the orphan
    // cleanup loop in renderLane can only reap cards still present in this.cards.
    card?.root.remove();
    this.cards.delete(busId);
  }

  addBus(): void {
    const api = this.api;
    if (!api) return;
    this.model.addBus();
    this.model.changed();
    api.rerender();
  }

  // —— transactions ——
  async scan(busId: number): Promise<void> {
    const api = this.api;
    const card = this.cards.get(busId);
    if (!api || !card || api.link.state !== "ready") return;
    card.draft.busy = true;
    card.draft.out = "…";
    card.out.textContent = "…";
    try {
      const r = await api.link.sendCmd("i2c.scan", { id: busId });
      if (r.ok) {
        const addrs: number[] = r.data?.addrs ?? [];
        card.draft.out = addrs.length
          ? addrs.map((a) => "0x" + a.toString(16).toUpperCase().padStart(2, "0")).join(" ")
          : "—";
        card.out.textContent = card.draft.out;
      } else {
        card.draft.out = tf("i2c_fail", String(r.error));
        card.out.textContent = card.draft.out;
      }
    } catch (e: any) {
      card.draft.out = e.message;
      card.out.textContent = card.draft.out;
    } finally {
      card.draft.busy = false;
    }
  }

  async xfer(busId: number): Promise<void> {
    const api = this.api;
    const card = this.cards.get(busId);
    if (!api || !card || api.link.state !== "ready") return;
    const d = card.draft;
    const addr = parseInt((d.addr || "").replace(/[^0-9a-fA-F]/g, ""), 16);
    if (!Number.isInteger(addr)) {
      card.out.textContent = tf("i2c_bad_addr");
      return;
    }
    const w = parseHex(d.w);
    const rlen = Math.max(0, parseInt(d.r, 10) || 0);
    const mode = d.mode;
    const args: any = { id: busId, addr, w, r: 0 };
    if (mode === "r") args.r = rlen;
    else if (mode === "wr") {
      args.r = rlen;
      args.rep_start = true;
    }
    card.draft.busy = true;
    card.draft.out = "…";
    card.out.textContent = "…";
    try {
      const res = await api.link.sendCmd("i2c.xfer", args);
      if (res.ok) {
        const rd: number[] = res.data?.rd ?? [];
        card.draft.out = rd.length ? fmtHex(rd) : tf("i2c_ok");
        card.out.textContent = card.draft.out;
      } else {
        card.draft.out = tf("i2c_fail", String(res.error));
        card.out.textContent = card.draft.out;
      }
    } catch (e: any) {
      card.draft.out = e.message;
      card.out.textContent = card.draft.out;
    } finally {
      card.draft.busy = false;
    }
  }

  private opt(v: string, label: string): HTMLOptionElement {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = label;
    return o;
  }

  private buildCard(api: FuncApi, b: I2cBus): BusCard {
    const root = el("i2c-card");
    const head = el("i2c-head");
    head.innerHTML = ICON[R_I2C];
    const title = el("i2c-title", "b");
    title.textContent = "I2C #" + b.id;
    const rm = el("rel", "button") as HTMLButtonElement;
    rm.textContent = "×";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeBus(b.id);
    });
    head.append(title, rm);

    const slots = el("i2c-slots");
    const sda = this.slot(api, b.id, "sda");
    const scl = this.slot(api, b.id, "scl");
    slots.append(sda, scl);

    const freqRow = el("i2c-row");
    const freqLbl = el("i2c-lbl", "span");
    freqLbl.textContent = tf("i2c_freq");
    const freq = el("i2c-sel", "select") as HTMLSelectElement;
    for (const f of FREQS) freq.appendChild(this.opt(String(f), (f / 1000) + " kHz"));
    freq.value = String(b.freq);
    freq.addEventListener("click", (e) => e.stopPropagation());
    freq.addEventListener("change", () => {
      const bus = this.model.busById(b.id);
      if (bus) bus.freq = Number(freq.value);
      this.model.changed();
      this.scheduleCfg(b.id);
    });
    freqRow.append(freqLbl, freq);

    const addrRow = el("i2c-row");
    const addrLbl = el("i2c-lbl", "span");
    addrLbl.textContent = tf("i2c_addr");
    const addr = el("i2c-addr", "input") as HTMLInputElement;
    addr.type = "text";
    addr.placeholder = "0x50";
    addr.addEventListener("input", () => (this.cards.get(b.id)!.draft.addr = addr.value));
    addr.addEventListener("click", (e) => e.stopPropagation());
    const mode = el("i2c-sel", "select") as HTMLSelectElement;
    for (const m of MODES) mode.appendChild(this.opt(m, m === "w" ? tf("i2c_m_w") : m === "r" ? tf("i2c_m_r") : tf("i2c_m_wr")));
    mode.value = "wr";
    mode.addEventListener("click", (e) => e.stopPropagation());
    mode.addEventListener("change", () => (this.cards.get(b.id)!.draft.mode = mode.value));
    addrRow.append(addrLbl, addr, mode);

    const wRow = el("i2c-row");
    const wLbl = el("i2c-lbl", "span");
    wLbl.textContent = tf("i2c_write");
    const wIn = el("i2c-hex", "input") as HTMLInputElement;
    wIn.type = "text";
    wIn.placeholder = "00";
    wIn.addEventListener("input", () => (this.cards.get(b.id)!.draft.w = wIn.value));
    wIn.addEventListener("click", (e) => e.stopPropagation());
    const rLbl = el("i2c-lbl", "span");
    rLbl.textContent = tf("i2c_read");
    const rIn = el("i2c-len", "input") as HTMLInputElement;
    rIn.type = "number";
    rIn.min = "0";
    rIn.value = "0";
    rIn.addEventListener("input", () => (this.cards.get(b.id)!.draft.r = rIn.value));
    rIn.addEventListener("click", (e) => e.stopPropagation());
    wRow.append(wLbl, wIn, rLbl, rIn);

    const act = el("i2c-row");
    const btnScan = el("mini", "button") as HTMLButtonElement;
    btnScan.textContent = tf("i2c_scan");
    btnScan.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.scan(b.id);
    });
    const btnSend = el("mini primary", "button") as HTMLButtonElement;
    btnSend.textContent = tf("i2c_send");
    btnSend.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.xfer(b.id);
    });
    act.append(btnScan, btnSend);

    const out = el("i2c-out", "div");

    root.append(head, slots, freqRow, addrRow, wRow, act, out);
    const card: BusCard = {
      root,
      sda,
      scl,
      freq,
      addr,
      wIn,
      rIn,
      mode,
      out,
      btnScan,
      btnSend,
      live: false,
      rejected: false,
      draft: { addr: "50", w: "", r: "0", mode: "wr", out: "", busy: false },
    };
    return card;
  }

  // Click-a-chip-into-the-focused-slot path; the engine calls it through the def.
  bindFocused(pin: number): boolean {
    const s = this.model.slotSel;
    if (!s || s.kind !== "i2c") return false;
    const which = s.role as "sda" | "scl";
    if (!this.slotAccept(s.bus, which, pin)) return false;
    this.bind(s.bus, which, pin);
    return true;
  }

  // A labeled, droppable pin slot (SDA or SCL).
  private slot(api: FuncApi, busId: number, which: "sda" | "scl"): HTMLElement {
    const box = el("i2c-slot", "div");
    box.dataset.bus = String(busId);
    box.dataset.which = which;
    const tag = el("i2c-slot-tag", "span");
    tag.textContent = which.toUpperCase();
    const val = el("i2c-slot-val", "span");
    box.append(tag, val);
    box.addEventListener("dragover", (e) => {
      const ok = this.slotAccept(busId, which, Number(this.model.sel));
      box.classList.toggle("compat", ok);
      if (ok) e.preventDefault();
    });
    box.addEventListener("dragleave", () => {
      if (api.model.sel === null) box.classList.remove("compat");
    });
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove("compat");
      const n = Number(e.dataTransfer?.getData("text/plain"));
      if (this.slotAccept(busId, which, n)) this.bind(busId, which, n);
    });
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      const b = api.model.busById(busId);
      const cur = b ? (which === "sda" ? b.sda : b.scl) : -1;
      if (cur >= 0) {
        this.clearSlot(busId, which);
        return;
      }
      // empty slot + a selected eligible pin → bind it (mirrors the click-to-
      // assign flow the per-pin lanes use for keyboard/pointer users)
      const sel = api.model.sel;
      if (sel === null) {
        // Nothing picked: focus this slot instead, which lights the pool chips
        // this slot may legally take — the reverse of the chip→slot glow.
        api.model.focusSlot(
          api.model.slotFocused("i2c", busId, which)
            ? null
            : { kind: "i2c", bus: busId, role: which, index: 0 }
        );
        api.rerender();
        return;
      }
      if (this.slotAccept(busId, which, sel)) this.bind(busId, which, sel);
      else {
        const why = this.rejectReason(busId, which, sel);
        if (why) api.note(tf(why));
      }
    });
    return box;
  }

  // Explains why a selected pin cannot enter this slot, so the refusal is never
  // silent. Returns an i18n key, or null when the pin is actually fine.
  private rejectReason(busId: number, which: "sda" | "scl", n: number): MsgKey | null {
    const b = this.model.busById(busId);
    if (!b || !this.model.isAddressable(n)) return null;
    if (!this.model.i2cRoleCap(n, which)) return which === "scl" ? "i2c_need_scl" : "i2c_need_sda";
    const other = which === "scl" ? b.sda : b.scl;
    if (other >= 0 && !this.model.i2cPairOk(which === "scl" ? n : other, which === "scl" ? other : n))
      return "i2c_pair_bad";
    return null;
  }

  // A pin may enter (this) slot only if it is role-capable (odd SCL / even SDA
  // per the firmware pair table), not the pin already in the bus's other slot,
  // and forms a legal ordered pair once that other slot is filled.
  private slotAccept(busId: number, which: "sda" | "scl", n: number): boolean {
    if (!this.model.isAddressable(n)) return false; // not a GP this board can name
    const b = this.model.busById(busId);
    if (!b) return false;
    return this.model.i2cSlotOk(b, which, n);
  }

  renderLane(api: FuncApi, zone: HTMLElement): void {
    this.api = api;
    const seen = new Set<number>();
    for (const b of this.model.buses) {
      seen.add(b.id);
      let card = this.cards.get(b.id);
      if (!card) {
        card = this.buildCard(api, b);
        this.cards.set(b.id, card);
        zone.appendChild(card.root);
      }
      // update slot labels + enablement from current model (cheap, in place)
      const setSlot = (elm: HTMLElement, pin: number, which: "sda" | "scl") => {
        const v = elm.querySelector(".i2c-slot-val") as HTMLElement;
        v.textContent = pin >= 0 ? pinLabel(pin) : "—";
        elm.classList.toggle("filled", pin >= 0);
        // selection affordance: when a pool chip is picked, light the empty
        // slots this pin can legally enter so it is obvious where it drops.
        const sel = api.model.sel;
        const compat = sel !== null && pin < 0 && this.slotAccept(b.id, which, sel);
        elm.classList.toggle("compat", compat);
        elm.classList.toggle("focus", pin < 0 && api.model.slotFocused("i2c", b.id, which));
      };
      setSlot(card.sda, b.sda, "sda");
      setSlot(card.scl, b.scl, "scl");
      const complete = this.model.i2cComplete(b);
      card.root.classList.toggle("ready", complete);
      const linkReady = api.link.state === "ready";
      for (const e of [card.addr, card.wIn, card.rIn, card.mode, card.freq])
        (e as HTMLInputElement).disabled = !complete || !linkReady;
      card.btnScan.disabled = !complete || !linkReady;
      card.btnSend.disabled = !complete || !linkReady;
      // refresh text inputs from draft only when not focused (avoid clobbering)
      const act = zone.ownerDocument.activeElement;
      if (act !== card.addr) card.addr.value = card.draft.addr;
      if (act !== card.wIn) card.wIn.value = card.draft.w;
      if (act !== card.rIn) card.rIn.value = card.draft.r;
      card.mode.value = card.draft.mode;
      card.freq.value = String(b.freq);
      if (!card.draft.busy) card.out.textContent = card.draft.out;
    }
    // drop cards whose bus was removed
    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.root.remove();
        this.cards.delete(id);
      }
    }
    // trailing "add bus" affordance; cards persist so console text stays put,
    // so just move the button to the end on every render.
    if (!this.addBtn) {
      this.addBtn = el("i2c-add", "button");
      this.addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.addBus();
      });
    }
    this.addBtn.textContent = tf("i2c_add");
    zone.appendChild(this.addBtn);
  }
}

export function makeI2cDef(drv: I2cDriver): FunctionDef {
  return {
    role: R_I2C,
    labelKey: "lane_i2c",
    cls: "l-i2c",
    icon: ICON[R_I2C],
    accept: (api, n) => api.model.isAddressable(n),
    // pins enter a bus through the card slots, not a generic lane drop
    assign: () => {},
    release: () => {},
    activate: () => drv.resync(),
    chip: () => ({ els: [] }),
    renderLane: (api, zone) => drv.renderLane(api, zone),
    bindSlot: (pin) => drv.bindFocused(pin),
  };
}
