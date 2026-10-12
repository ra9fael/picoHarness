// SPI bus lane. Like UART it renders its own bus cards, but the pin rules are
// stricter: the rp2 port builds busio.SPI from positional pins that must all
// come from ONE pin group (one hardware SPI), and it refuses a bare SCK — so a
// bus is complete when SCK plus at least one of MOSI/MISO is bound. CS lines are
// plain outputs (any free GP works) and are named per transaction rather than
// asserted by the bus itself. Legality comes from the caps.spi table the firmware
// measured on the board. Commands: spi.cfg / spi.xfer / spi.release.
import { tf, type MsgKey } from "../i18n";
import { NUM, TEMP, R_SPI, pinLabel, type SpiBus, type SpiDataRole, type SpiRole, type PinModel } from "../model/pins";
import { el } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

// The port divides the 150 MHz system clock by an EVEN integer (measured with
// tools/spi_probe.py), so only some of these presets are hit exactly — 9600 gives
// 9599 Hz, 2 MHz gives 1973684, 10 MHz gives 9375000. The card prints the clock
// that actually came out (spi.xfer's hbaud), the same honesty the PWM lane uses.
// 50 MHz is deliberately absent: it lands on 37.5 MHz, and 37.5 is listed instead.
const CLOCKS = [9600, 115200, 250000, 500000, 1000000, 2000000, 5000000, 10000000, 25000000, 37500000];

const ROLES: SpiDataRole[] = ["sck", "mosi", "miso"];

const parseHex = (s: string): number[] => {
  const clean = s.replace(/[^0-9a-fA-F]/g, "").match(/.{1,2}/g);
  return clean ? clean.map((h) => parseInt(h, 16)) : [];
};
const fmtHex = (a: number[]): string =>
  a.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join(" ");

type Draft = { w: string; r: string; out: string; busy: boolean };

type SpiCard = {
  root: HTMLElement;
  slots: Map<string, HTMLElement>;
  baud: HTMLSelectElement;
  mode: HTMLSelectElement;
  wIn: HTMLInputElement;
  rIn: HTMLInputElement;
  csSel: HTMLSelectElement;
  hold: HTMLInputElement;
  out: HTMLElement;
  btnXfer: HTMLButtonElement;
  draft: Draft;
  live: boolean; // device currently has this bus configured
  rejected: boolean; // firmware refused the last cfg: stop auto-retrying
  shownCs: string; // cs signature the card was last built for
};

export class SpiDriver {
  private api: FuncApi | null = null;
  private cards = new Map<number, SpiCard>();
  private addBtn: HTMLElement | null = null;
  private cfgTimer = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(private model: PinModel) {}

  // —— device coordination ——
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

  async applyBus(busId: number): Promise<void> {
    const api = this.api;
    if (!api) return;
    const { link, note } = api;
    const b = this.model.busSpiById(busId);
    const card = this.cards.get(busId);
    if (link.state !== "ready" || !b) return;
    if (!this.model.spiComplete(b)) {
      if (card) card.rejected = false;
      if (card?.live) {
        await link.sendCmd("spi.release", { id: b.id }).catch(() => {});
        if (card) card.live = false;
      }
      return;
    }
    try {
      const r = await link.sendCmd("spi.cfg", {
        id: b.id,
        sck: b.sck,
        mosi: b.mosi,
        miso: b.miso,
        cs: b.cs,
        baud: b.baud,
        mode: b.mode,
      });
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
        note(tf("spi_fail", String(r.error)));
      }
    } catch (e: any) {
      if (card) {
        card.live = false;
        card.rejected = true;
      }
      note(tf("spi_fail", e.message));
    }
  }

  // Push every complete bus on link-ready or drift. A bus the firmware rejected
  // is left alone — the model can't converge with a device that won't build it,
  // so re-issuing every poll would spam spi.cfg. Only a user edit retries it.
  resync(): void {
    for (const b of this.model.spiBuses) {
      if (this.cards.get(b.id)?.rejected) continue;
      void this.applyBus(b.id);
    }
  }

  // A fresh handshake means a device whose volatile bus config is gone (reboot,
  // or a reflash that added these commands), so forget the latches and let the
  // next resync re-issue spi.cfg for every bus.
  resetLatch(): void {
    for (const card of this.cards.values()) {
      card.live = false;
      card.rejected = false;
    }
  }

  // —— pin binding ——
  bind(busId: number, which: SpiRole, pin: number, index = 0): void {
    const api = this.api;
    if (!api || pin === TEMP || pin < 0 || pin >= NUM) return;
    const model = this.model;
    const cur = model.roles[pin];
    if (cur !== 0 && cur !== R_SPI) api.releasePin(pin);
    if (which === "cs") model.setSpiCs(busId, index, pin);
    else model.setSpiSlot(busId, which, pin);
    model.sel = null;
    model.changed();
    this.scheduleCfg(busId);
    api.rerender();
  }

  clearSlot(busId: number, which: SpiRole, index = 0): void {
    const api = this.api;
    if (!api) return;
    if (which === "cs") this.model.removeSpiCs(busId, index);
    else this.model.setSpiSlot(busId, which, -1);
    this.model.changed();
    void this.applyBus(busId);
    api.rerender();
  }

  removeBus(busId: number): void {
    const api = this.api;
    if (!api) return;
    const card = this.cards.get(busId);
    if (card?.live && api.link.state === "ready") {
      api.link.sendCmd("spi.release", { id: busId }).catch(() => {});
    }
    const t = this.cfgTimer.get(busId);
    if (t) clearTimeout(t);
    this.cfgTimer.delete(busId);
    card?.root.remove();
    this.cards.delete(busId);
    this.model.removeSpiBus(busId);
    this.model.changed();
    api.rerender();
  }

  addBus(): void {
    const api = this.api;
    if (!api) return;
    if (this.model.spiBuses.length >= this.model.spiBusLimit) {
      api.note(tf("spi_bus_limit", String(this.model.spiBusLimit)));
      return;
    }
    this.model.addSpiBus();
    this.model.changed();
    api.rerender();
  }

  // —— transactions ——
  async transfer(busId: number): Promise<void> {
    const api = this.api;
    const card = this.cards.get(busId);
    if (!api || !card || api.link.state !== "ready") return;
    const w = parseHex(card.draft.w);
    const rlen = Math.max(0, Math.min(4096, parseInt(card.draft.r, 10) || 0));
    if (!w.length && !rlen) {
      card.out.textContent = tf("spi_no_data");
      return;
    }
    const b = this.model.busSpiById(busId);
    const csIdx = Number(card.csSel.value);
    card.draft.busy = true;
    card.draft.out = "…";
    card.out.textContent = "…";
    try {
      const r = await api.link.sendCmd("spi.xfer", {
        id: busId,
        w,
        r: rlen,
        cs: b && b.cs.length ? csIdx : -1,
        hold: card.hold.checked,
      });
      if (r.ok) {
        const rd: number[] = r.data?.rd ?? [];
        const bits = [rd.length ? fmtHex(rd) : "—", tf("spi_rd", String(rd.length))];
        if (typeof r.data?.hbaud === "number") bits.push(tf("spi_hbaud", String(r.data.hbaud)));
        if (r.data?.held) bits.push(tf("spi_held"));
        card.draft.out = bits.join("  ·  ");
      } else {
        card.draft.out = tf("spi_fail", String(r.error));
      }
      card.out.textContent = card.draft.out;
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

  // A labeled, droppable pin slot (SCK / MOSI / MISO / CSn).
  private slot(busId: number, which: SpiRole, index: number): HTMLElement {
    const box = el("spi-slot", "div");
    const tag = el("spi-slot-tag", "span");
    tag.textContent = which === "cs" ? "CS" + index : which.toUpperCase();
    const val = el("spi-slot-val", "span");
    box.append(tag, val);
    box.addEventListener("dragover", (e) => {
      const ok = this.slotAccept(busId, which, index, Number(this.model.sel));
      box.classList.toggle("compat", ok);
      if (ok) e.preventDefault();
    });
    box.addEventListener("dragleave", () => {
      if (this.api?.model.sel === null) box.classList.remove("compat");
    });
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove("compat");
      const n = Number(e.dataTransfer?.getData("text/plain"));
      if (this.slotAccept(busId, which, index, n)) this.bind(busId, which, n, index);
    });
    val.addEventListener("click", (e) => {
      e.stopPropagation();
      const b = this.api?.model.busSpiById(busId);
      if (!b) return;
      const cur = which === "cs" ? b.cs[index] ?? -1 : b[which];
      if (cur >= 0) {
        this.clearSlot(busId, which, index);
        return;
      }
      const sel = this.api!.model.sel;
      if (sel === null) return;
      if (this.slotAccept(busId, which, index, sel)) this.bind(busId, which, sel, index);
      else {
        const why = this.rejectReason(busId, which, index, sel);
        if (why.key) this.api!.note(tf(why.key, why.arg));
      }
    });
    return box;
  }

  // Explains why a selected pin cannot enter this slot, so the refusal is never
  // silent. Returns an i18n key plus its argument, or key null when fine.
  private rejectReason(busId: number, which: SpiRole, index: number, n: number): { key: MsgKey | null; arg: string } {
    const b = this.model.busSpiById(busId);
    if (!b || n < 0 || n >= NUM || n === TEMP) return { key: null, arg: "" };
    if (!this.model.spiRoleCap(n, which))
      return { key: "spi_cannot", arg: which === "cs" ? "CS" : which.toUpperCase() };
    const cand: SpiBus = { ...b, cs: b.cs.slice() };
    if (which === "cs") {
      if (index >= cand.cs.length && cand.cs.length >= this.model.spiCsLimit)
        return { key: "spi_cs_full", arg: String(this.model.spiCsLimit) };
      cand.cs[index] = n;
      if (!this.busyElsewhere(cand, n)) return { key: "spi_pin_busy", arg: "" };
      return { key: null, arg: "" };
    }
    cand[which] = n;
    if (!this.model.spiSetOk(cand.sck, cand.mosi, cand.miso)) return { key: "spi_group_bad", arg: "" };
    if (!this.busyElsewhere(cand, n)) return { key: "spi_pin_busy", arg: "" };
    return { key: null, arg: "" };
  }

  private slotAccept(busId: number, which: SpiRole, index: number, n: number): boolean {
    if (!Number.isInteger(n) || n < 0 || n >= NUM || n === TEMP) return false;
    const b = this.model.busSpiById(busId);
    if (!b) return false;
    if (which === "cs") {
      // Only an existing entry or the next free one; a hole in the list is the
      // card's own bookkeeping, never a drop target.
      if (index > b.cs.length) return false;
      const cand: SpiBus = { ...b, cs: b.cs.slice() };
      cand.cs[index] = n;
      return (
        cand.cs.length <= this.model.spiCsLimit &&
        this.model.spiRoleCap(n, "cs") &&
        this.busyElsewhere(cand, n)
      );
    }
    return this.model.spiSlotOk(b, which, n);
  }

  // A pin may not hold two roles in one bus (spiSlotOk enforces it for data
  // roles; the CS path above needs the same check).
  private busyElsewhere(b: SpiBus, n: number): boolean {
    const members = [b.sck, b.mosi, b.miso, ...b.cs];
    return members.indexOf(n) === members.lastIndexOf(n);
  }

  private buildCard(b: SpiBus): SpiCard {
    const root = el("spi-card");
    const head = el("spi-head");
    head.innerHTML = ICON[R_SPI];
    const title = el("spi-title", "b");
    title.textContent = "SPI #" + b.id;
    const rm = el("rel", "button") as HTMLButtonElement;
    rm.textContent = "×";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeBus(b.id);
    });
    head.append(title, rm);

    const slots = el("spi-slots");
    const byKey = new Map<string, HTMLElement>();
    for (const role of ROLES) {
      const s = this.slot(b.id, role, 0);
      byKey.set(role, s);
      slots.append(s);
    }
    const csRow = el("spi-csrow");
    const csLbl = el("spi-lbl", "span");
    csLbl.textContent = tf("spi_cs");
    csRow.append(csLbl);
    for (let i = 0; i < this.model.spiCsLimit; i++) {
      const s = this.slot(b.id, "cs", i);
      byKey.set("cs" + i, s);
      csRow.append(s);
    }

    const baudRow = el("spi-row");
    const baudLbl = el("spi-lbl", "span");
    baudLbl.textContent = tf("spi_baud");
    const baud = el("spi-sel", "select") as HTMLSelectElement;
    baud.addEventListener("click", (e) => e.stopPropagation());
    baud.addEventListener("change", () => {
      const bus = this.model.busSpiById(b.id);
      if (bus) bus.baud = Number(baud.value);
      this.model.changed();
      this.scheduleCfg(b.id);
    });
    baudRow.append(baudLbl, baud);

    const modeRow = el("spi-row");
    const modeLbl = el("spi-lbl", "span");
    modeLbl.textContent = tf("spi_mode");
    const mode = el("spi-sel", "select") as HTMLSelectElement;
    for (let m = 0; m < 4; m++) mode.appendChild(this.opt(String(m), "CPOL/CPHA " + m));
    mode.value = String(b.mode);
    mode.addEventListener("click", (e) => e.stopPropagation());
    mode.addEventListener("change", () => {
      const bus = this.model.busSpiById(b.id);
      if (bus) bus.mode = Number(mode.value) & 3;
      this.model.changed();
      this.scheduleCfg(b.id);
    });
    modeRow.append(modeLbl, mode);

    const wRow = el("spi-row");
    const wLbl = el("spi-lbl", "span");
    wLbl.textContent = tf("spi_write");
    const wIn = el("spi-hex", "input") as HTMLInputElement;
    wIn.type = "text";
    wIn.placeholder = "AA 55 00";
    wIn.addEventListener("input", () => (this.cards.get(b.id)!.draft.w = wIn.value));
    wIn.addEventListener("click", (e) => e.stopPropagation());
    wRow.append(wLbl, wIn);

    const rRow = el("spi-row");
    const rLbl = el("spi-lbl", "span");
    rLbl.textContent = tf("spi_read");
    const rIn = el("spi-len", "input") as HTMLInputElement;
    rIn.type = "number";
    rIn.min = "0";
    rIn.value = "8";
    rIn.addEventListener("input", () => (this.cards.get(b.id)!.draft.r = rIn.value));
    rIn.addEventListener("click", (e) => e.stopPropagation());
    rRow.append(rLbl, rIn);

    const csRow2 = el("spi-row");
    const csSelLbl = el("spi-lbl", "span");
    csSelLbl.textContent = tf("spi_cs");
    const csSel = el("spi-sel", "select") as HTMLSelectElement;
    csSel.addEventListener("click", (e) => e.stopPropagation());
    const holdLbl = el("spi-lbl", "span");
    holdLbl.textContent = tf("spi_hold");
    const hold = el("spi-hold", "input") as HTMLInputElement;
    hold.type = "checkbox";
    hold.addEventListener("click", (e) => e.stopPropagation());
    csRow2.append(csSelLbl, csSel, holdLbl, hold);

    const act = el("spi-row");
    const btnXfer = el("mini primary", "button") as HTMLButtonElement;
    btnXfer.textContent = tf("spi_send");
    btnXfer.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.transfer(b.id);
    });
    act.append(btnXfer);

    const out = el("spi-out", "div");
    root.append(head, slots, csRow, baudRow, modeRow, wRow, rRow, csRow2, act, out);
    return {
      root,
      slots: byKey,
      baud,
      mode,
      wIn,
      rIn,
      csSel,
      hold,
      out,
      btnXfer,
      live: false,
      rejected: false,
      shownCs: "",
      draft: { w: "", r: "8", out: "", busy: false },
    };
  }

  renderLane(api: FuncApi, zone: HTMLElement): void {
    this.api = api;
    const ceiling = api.model.spiCeilingHz;
    const seen = new Set<number>();
    for (const b of api.model.spiBuses) {
      seen.add(b.id);
      let card = this.cards.get(b.id);
      if (!card) {
        card = this.buildCard(b);
        this.cards.set(b.id, card);
        zone.appendChild(card.root);
      }
      for (const role of ROLES) {
        const elm = card.slots.get(role)!;
        const pin = b[role];
        const v = elm.querySelector(".spi-slot-val") as HTMLElement;
        v.textContent = pin >= 0 ? pinLabel(pin) : "—";
        elm.classList.toggle("filled", pin >= 0);
        const sel = api.model.sel;
        elm.classList.toggle("compat", sel !== null && pin < 0 && this.slotAccept(b.id, role, 0, sel));
      }
      for (let i = 0; i < this.model.spiCsLimit; i++) {
        const elm = card.slots.get("cs" + i)!;
        const pin = b.cs[i] ?? -1;
        const v = elm.querySelector(".spi-slot-val") as HTMLElement;
        v.textContent = pin >= 0 ? pinLabel(pin) : "—";
        elm.classList.toggle("filled", pin >= 0);
        const sel = api.model.sel;
        elm.classList.toggle(
          "compat",
          sel !== null && pin < 0 && this.slotAccept(b.id, "cs", i, sel)
        );
      }

      const complete = this.model.spiComplete(b);
      card.root.classList.toggle("ready", complete);
      const linkReady = api.link.state === "ready";
      // Rebuild the clock list only when the caps change; a select keeps no
      // selection across repopulation, so bail out when the value is still there.
      const clocks = ceiling ? CLOCKS.filter((c) => c <= ceiling) : CLOCKS;
      if (card.baud.options.length !== clocks.length) {
        card.baud.innerHTML = "";
        for (const c of clocks) card.baud.appendChild(this.opt(String(c), c >= 1e6 ? c / 1e6 + " MHz" : c / 1e3 + " kHz"));
      }
      card.baud.value = String(b.baud);
      card.mode.value = String(b.mode);
      card.baud.disabled = !complete || !linkReady;
      card.mode.disabled = !complete || !linkReady;

      const csSig = b.cs.join("+");
      if (csSig !== card.shownCs) {
        card.shownCs = csSig;
        card.csSel.innerHTML = "";
        card.csSel.appendChild(this.opt("-1", "—"));
        b.cs.forEach((p, i) => card.csSel.appendChild(this.opt(String(i), "CS" + i + " " + pinLabel(p))));
      }
      if (Number(card.csSel.value) >= b.cs.length) card.csSel.value = "-1";
      const writable = complete && linkReady && (b.mosi >= 0 || b.miso >= 0);
      card.wIn.disabled = !writable || b.mosi < 0;
      card.rIn.disabled = !writable || b.miso < 0;
      card.csSel.disabled = !writable || !b.cs.length;
      card.hold.disabled = !writable || !b.cs.length;
      card.btnXfer.disabled = !writable;

      const act = zone.ownerDocument.activeElement;
      if (act !== card.wIn) card.wIn.value = card.draft.w;
      if (act !== card.rIn) card.rIn.value = card.draft.r;
      if (!card.draft.busy) card.out.textContent = card.draft.out;
    }
    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.root.remove();
        this.cards.delete(id);
      }
    }
    if (!this.addBtn) {
      this.addBtn = el("spi-add", "button");
      this.addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.addBus();
      });
    }
    this.addBtn.textContent = tf("spi_add");
    (this.addBtn as HTMLButtonElement).disabled =
      this.model.spiBuses.length >= this.model.spiBusLimit;
    zone.appendChild(this.addBtn);
  }
}

export function makeSpiDef(drv: SpiDriver): FunctionDef {
  return {
    role: R_SPI,
    labelKey: "lane_spi",
    cls: "l-spi",
    icon: ICON[R_SPI],
    accept: (api, n) => n >= 0 && n < NUM && n !== TEMP,
    // pins enter a bus through the card slots, not a generic lane drop
    assign: () => {},
    release: () => {},
    activate: () => drv.resync(),
    chip: () => ({ els: [] }),
    renderLane: (api, zone) => drv.renderLane(api, zone),
  };
}
