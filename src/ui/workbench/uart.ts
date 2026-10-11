// UART bus lane — like I2C a multi-pin function that renders its own bus cards
// (kept across re-renders so an open console survives a poll repaint), but a
// UART only needs ONE of its two lines: TX-only (write) and RX-only (read)
// buses are legal. rp2 hardware UART exposes a fixed subset of TX / RX pins and
// a full-duplex pair must land on one instance, so slot legality comes from the
// firmware-probed caps.uart table; a lone pin is always fine. Commands:
// uart.cfg / uart.write / uart.read / uart.release.
import { tf, type MsgKey } from "../i18n";
import { NUM, TEMP, R_UART, pinLabel, type UartBus, type PinModel } from "../model/pins";
import { el } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const parseHex = (s: string): number[] => {
  const clean = s.replace(/[^0-9a-fA-F]/g, "").match(/.{1,2}/g);
  return clean ? clean.map((h) => parseInt(h, 16)) : [];
};
const fmtHex = (a: number[]): string =>
  a.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join(" ");

type Draft = { w: string; r: string; out: string; busy: boolean };

// Per-bus card, kept across workbench re-renders so the console the user is
// typing into is never rebuilt out from under them.
type UartCard = {
  root: HTMLElement;
  tx: HTMLElement;
  rx: HTMLElement;
  baud: HTMLSelectElement;
  wIn: HTMLInputElement;
  rIn: HTMLInputElement;
  out: HTMLElement;
  btnWrite: HTMLButtonElement;
  btnRead: HTMLButtonElement;
  draft: Draft;
  live: boolean; // device currently has this bus configured
  rejected: boolean; // firmware refused the last cfg (unroutable pins): stop auto-retrying
};

export class UartDriver {
  private api: FuncApi | null = null;
  private cards = new Map<number, UartCard>();
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
    const b = this.model.busUartById(busId);
    const card = this.cards.get(busId);
    if (link.state !== "ready" || !b) return;
    if (!this.model.uartComplete(b)) {
      if (card) card.rejected = false;
      if (card?.live) {
        await link.sendCmd("uart.release", { id: b.id }).catch(() => {});
        if (card) card.live = false;
      }
      return;
    }
    try {
      const r = await link.sendCmd("uart.cfg", { id: b.id, tx: b.tx, rx: b.rx, baud: b.baud });
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
        note(tf("uart_fail", String(r.error)));
      }
    } catch (e: any) {
      if (card) {
        card.live = false;
        card.rejected = true;
      }
      note(tf("uart_fail", e.message));
    }
  }

  // Push every complete bus on link-ready or drift. A bus the firmware rejected
  // is left alone — the model never converges with a device that won't build it,
  // so re-issuing every poll would spam uart.cfg. Only a user edit retries it.
  resync(): void {
    for (const b of this.model.uartBuses) {
      if (this.cards.get(b.id)?.rejected) continue;
      void this.applyBus(b.id);
    }
  }

  // A fresh handshake means a device whose volatile bus config was just lost
  // (reboot, or a firmware reflash that added these commands). Forget the
  // rejection/live latches so the next resync re-issues uart.cfg for every bus.
  resetLatch(): void {
    for (const card of this.cards.values()) {
      card.live = false;
      card.rejected = false;
    }
  }

  // —— pin binding ——
  bind(busId: number, which: "tx" | "rx", pin: number): void {
    const api = this.api;
    if (!api || pin === TEMP || pin < 0 || pin >= NUM) return;
    const model = this.model;
    const cur = model.roles[pin];
    if (cur !== 0 && cur !== R_UART) api.releasePin(pin);
    model.setUartSlot(busId, which, pin);
    model.sel = null;
    model.changed();
    this.scheduleCfg(busId);
    api.rerender();
  }

  clearSlot(busId: number, which: "tx" | "rx"): void {
    const api = this.api;
    if (!api) return;
    this.model.setUartSlot(busId, which, -1);
    this.model.changed();
    void this.applyBus(busId);
    api.rerender();
  }

  removeBus(busId: number): void {
    const api = this.api;
    if (!api) return;
    const card = this.cards.get(busId);
    if (card?.live && api.link.state === "ready") {
      api.link.sendCmd("uart.release", { id: busId }).catch(() => {});
    }
    const t = this.cfgTimer.get(busId);
    if (t) clearTimeout(t);
    this.cfgTimer.delete(busId);
    card?.root.remove();
    this.cards.delete(busId);
    this.model.removeUartBus(busId);
    this.model.changed();
    api.rerender();
  }

  addBus(): void {
    const api = this.api;
    if (!api) return;
    this.model.addUartBus();
    this.model.changed();
    api.rerender();
  }

  // —— transactions ——
  async write(busId: number): Promise<void> {
    const api = this.api;
    const card = this.cards.get(busId);
    if (!api || !card || api.link.state !== "ready") return;
    const data = parseHex(card.draft.w);
    if (!data.length) {
      card.out.textContent = tf("uart_no_data");
      return;
    }
    card.draft.busy = true;
    card.draft.out = "…";
    card.out.textContent = "…";
    try {
      const r = await api.link.sendCmd("uart.write", { id: busId, data });
      card.draft.out = r.ok ? tf("uart_written", String(r.data?.written ?? 0)) : tf("uart_fail", String(r.error));
      card.out.textContent = card.draft.out;
    } catch (e: any) {
      card.draft.out = e.message;
      card.out.textContent = card.draft.out;
    } finally {
      card.draft.busy = false;
    }
  }

  async read(busId: number): Promise<void> {
    const api = this.api;
    const card = this.cards.get(busId);
    if (!api || !card || api.link.state !== "ready") return;
    const n = Math.max(0, Math.min(4096, parseInt(card.draft.r, 10) || 0));
    card.draft.busy = true;
    card.draft.out = "…";
    card.out.textContent = "…";
    try {
      const r = await api.link.sendCmd("uart.read", { id: busId, n });
      if (r.ok) {
        const rd: number[] = r.data?.rd ?? [];
        card.draft.out = rd.length ? fmtHex(rd) : "—";
      } else {
        card.draft.out = tf("uart_fail", String(r.error));
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

  private buildCard(api: FuncApi, b: UartBus): UartCard {
    const root = el("uart-card");
    const head = el("uart-head");
    head.innerHTML = ICON[R_UART];
    const title = el("uart-title", "b");
    title.textContent = "UART #" + b.id;
    const rm = el("rel", "button") as HTMLButtonElement;
    rm.textContent = "×";
    rm.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeBus(b.id);
    });
    head.append(title, rm);

    const slots = el("uart-slots");
    const tx = this.slot(api, b.id, "tx");
    const rx = this.slot(api, b.id, "rx");
    slots.append(tx, rx);

    const baudRow = el("uart-row");
    const baudLbl = el("uart-lbl", "span");
    baudLbl.textContent = tf("uart_baud");
    const baud = el("uart-sel", "select") as HTMLSelectElement;
    for (const bd of BAUDS) baud.appendChild(this.opt(String(bd), String(bd)));
    baud.value = String(b.baud);
    baud.addEventListener("click", (e) => e.stopPropagation());
    baud.addEventListener("change", () => {
      const bus = this.model.busUartById(b.id);
      if (bus) bus.baud = Number(baud.value);
      this.model.changed();
      this.scheduleCfg(b.id);
    });
    baudRow.append(baudLbl, baud);

    const wRow = el("uart-row");
    const wLbl = el("uart-lbl", "span");
    wLbl.textContent = tf("uart_write");
    const wIn = el("uart-hex", "input") as HTMLInputElement;
    wIn.type = "text";
    wIn.placeholder = "48 65 6c 6c 6f";
    wIn.addEventListener("input", () => (this.cards.get(b.id)!.draft.w = wIn.value));
    wIn.addEventListener("click", (e) => e.stopPropagation());
    wRow.append(wLbl, wIn);

    const rRow = el("uart-row");
    const rLbl = el("uart-lbl", "span");
    rLbl.textContent = tf("uart_read");
    const rIn = el("uart-len", "input") as HTMLInputElement;
    rIn.type = "number";
    rIn.min = "0";
    rIn.value = "16";
    rIn.addEventListener("input", () => (this.cards.get(b.id)!.draft.r = rIn.value));
    rIn.addEventListener("click", (e) => e.stopPropagation());
    rRow.append(rLbl, rIn);

    const act = el("uart-row");
    const btnWrite = el("mini primary", "button") as HTMLButtonElement;
    btnWrite.textContent = tf("uart_send");
    btnWrite.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.write(b.id);
    });
    const btnRead = el("mini", "button") as HTMLButtonElement;
    btnRead.textContent = tf("uart_recv");
    btnRead.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.read(b.id);
    });
    act.append(btnWrite, btnRead);

    const out = el("uart-out", "div");

    root.append(head, slots, baudRow, wRow, rRow, act, out);
    const card: UartCard = {
      root,
      tx,
      rx,
      baud,
      wIn,
      rIn,
      out,
      btnWrite,
      btnRead,
      live: false,
      rejected: false,
      draft: { w: "", r: "16", out: "", busy: false },
    };
    return card;
  }

  // A labeled, droppable pin slot (TX or RX).
  private slot(api: FuncApi, busId: number, which: "tx" | "rx"): HTMLElement {
    const box = el("uart-slot", "div");
    box.dataset.bus = String(busId);
    box.dataset.which = which;
    const tag = el("uart-slot-tag", "span");
    tag.textContent = which.toUpperCase();
    const val = el("uart-slot-val", "span");
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
    val.addEventListener("click", (e) => {
      e.stopPropagation();
      const b = api.model.busUartById(busId);
      const cur = b ? (which === "tx" ? b.tx : b.rx) : -1;
      if (cur >= 0) {
        this.clearSlot(busId, which);
        return;
      }
      const sel = api.model.sel;
      if (sel === null) return;
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
  private rejectReason(busId: number, which: "tx" | "rx", n: number): MsgKey | null {
    const b = this.model.busUartById(busId);
    if (!b || n < 0 || n >= NUM || n === TEMP) return null;
    if (!this.model.uartRoleCap(n, which)) return which === "tx" ? "uart_need_tx" : "uart_need_rx";
    const other = which === "tx" ? b.rx : b.tx;
    if (other >= 0 && !this.model.uartPairOk(which === "tx" ? n : other, which === "tx" ? other : n))
      return "uart_pair_bad";
    return null;
  }

  // A pin may enter (this) slot only if it is role-capable per caps.uart, not the
  // pin already in the bus's other slot, and (once that slot is filled) forms a
  // legal full-duplex pair with it. An empty other slot means a single-pin bus,
  // which is always allowed.
  private slotAccept(busId: number, which: "tx" | "rx", n: number): boolean {
    if (!Number.isInteger(n) || n < 0 || n >= NUM || n === TEMP) return false;
    const b = this.model.busUartById(busId);
    if (!b) return false;
    return this.model.uartSlotOk(b, which, n);
  }

  renderLane(api: FuncApi, zone: HTMLElement): void {
    this.api = api;
    const seen = new Set<number>();
    for (const b of this.model.uartBuses) {
      seen.add(b.id);
      let card = this.cards.get(b.id);
      if (!card) {
        card = this.buildCard(api, b);
        this.cards.set(b.id, card);
        zone.appendChild(card.root);
      }
      const setSlot = (elm: HTMLElement, pin: number, which: "tx" | "rx") => {
        const v = elm.querySelector(".uart-slot-val") as HTMLElement;
        v.textContent = pin >= 0 ? pinLabel(pin) : "—";
        elm.classList.toggle("filled", pin >= 0);
        const sel = api.model.sel;
        const compat = sel !== null && pin < 0 && this.slotAccept(b.id, which, sel);
        elm.classList.toggle("compat", compat);
      };
      setSlot(card.tx, b.tx, "tx");
      setSlot(card.rx, b.rx, "rx");
      const complete = this.model.uartComplete(b);
      card.root.classList.toggle("ready", complete);
      const linkReady = api.link.state === "ready";
      // Send needs a live bus with a TX pin; Read needs one with an RX pin.
      (card.baud as HTMLSelectElement).disabled = !complete || !linkReady;
      card.wIn.disabled = !complete || !linkReady || b.tx < 0;
      card.rIn.disabled = !complete || !linkReady || b.rx < 0;
      card.btnWrite.disabled = !complete || !linkReady || b.tx < 0;
      card.btnRead.disabled = !complete || !linkReady || b.rx < 0;
      const act = zone.ownerDocument.activeElement;
      if (act !== card.wIn) card.wIn.value = card.draft.w;
      if (act !== card.rIn) card.rIn.value = card.draft.r;
      card.baud.value = String(b.baud);
      if (!card.draft.busy) card.out.textContent = card.draft.out;
    }
    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.root.remove();
        this.cards.delete(id);
      }
    }
    if (!this.addBtn) {
      this.addBtn = el("uart-add", "button");
      this.addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.addBus();
      });
    }
    this.addBtn.textContent = tf("uart_add");
    zone.appendChild(this.addBtn);
  }
}

export function makeUartDef(drv: UartDriver): FunctionDef {
  return {
    role: R_UART,
    labelKey: "lane_uart",
    cls: "l-uart",
    icon: ICON[R_UART],
    accept: (api, n) => n >= 0 && n < NUM && n !== TEMP,
    // pins enter a bus through the card slots, not a generic lane drop
    assign: () => {},
    release: () => {},
    activate: () => drv.resync(),
    chip: () => ({ els: [] }),
    renderLane: (api, zone) => drv.renderLane(api, zone),
  };
}
