// Console UART tabs: a live serial terminal per configured UART bus, living in
// the console dock alongside the raw Monitor/REPL mirror. The device streams RX
// bytes as uart_rx events (subscribed only while a tab is active); keystrokes
// are sent as UTF-8 bytes via uart.write. This is an overlay channel — the bus
// card's manual write/read console stays available for one-shot register-style
// exchanges.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { SerialLink } from "../serial";
import type { PinModel } from "../model/pins";
import { t } from "../i18n";

const C = { rx: "\x1b[38;5;150m", err: "\x1b[38;5;203m", dim: "\x1b[38;5;245m", reset: "\x1b[0m" };
const enc = new TextEncoder();

type Term = { host: HTMLDivElement; term: Terminal; fit: FitAddon; hex: boolean; hexBtn: HTMLButtonElement };

export class UartTerminals {
  private ids: (number | "console")[] = []; // bus id per tab, "console" for tab 0
  private termById = new Map<number, Term>();
  private active: number | "console" = "console";
  private subbed: number | null = null; // bus id currently streaming on the device

  constructor(
    private link: SerialLink,
    private model: PinModel,
    private tabsEl: HTMLElement,
    private panesEl: HTMLElement,
    private consoleEl: HTMLElement,
  ) {
    this.buildTabs();
    new ResizeObserver(() => this.fitActive()).observe(panesEl);
  }

  private mkTerm(id: number): Term {
    const host = document.createElement("div");
    host.className = "uart-term";
    host.style.display = "none";
    const bar = document.createElement("div");
    bar.className = "uart-term-bar";
    const hexBtn = document.createElement("button");
    hexBtn.className = "hex-toggle";
    hexBtn.textContent = "HEX";
    hexBtn.title = t("uart_hex_hint");
    bar.appendChild(hexBtn);
    const screen = document.createElement("div");
    screen.className = "uart-term-screen";
    host.append(bar, screen);
    this.panesEl.appendChild(host);
    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      cursorBlink: true,
      theme: { background: "#0b0e11", foreground: "#d5dde5", cursor: "#f0a860" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(screen);
    const t0: Term = { host, term, fit, hex: false, hexBtn };
    hexBtn.addEventListener("click", () => {
      t0.hex = !t0.hex;
      hexBtn.classList.toggle("on", t0.hex);
      term.writeln(
        C.dim + (t0.hex ? t("uart_mode_hex") : t("uart_mode_text")) + C.reset
      );
    });
    term.writeln(
      C.dim +
        t("uart_term_hint")
          .replace("{0}", "uart.write")
          .replace("{1}", "uart_rx") +
        C.reset
    );
    term.onData((d) => this.onKey(id, d));
    return t0;
  }

  // Reconcile tabs + terminals with the current bus list (add/remove).
  sync(): void {
    const want = this.model.uartBuses.map((b) => b.id);
    const have = Array.from(this.termById.keys());
    for (const id of have) {
      if (!want.includes(id)) {
        const t0 = this.termById.get(id)!;
        t0.term.dispose();
        t0.host.remove();
        this.termById.delete(id);
        if (this.active === id) this.select("console");
      }
    }
    this.buildTabs();
  }

  private buildTabs(): void {
    this.tabsEl.innerHTML = "";
    this.ids = ["console", ...this.model.uartBuses.map((b) => b.id)];
    this.ids.forEach((id) => {
      const b = document.createElement("button");
      b.className = "c-tab" + (id === this.active ? " on" : "");
      b.textContent = id === "console" ? t("tab_console") : "UART #" + id;
      b.addEventListener("click", () => this.select(id));
      this.tabsEl.appendChild(b);
    });
  }

  refreshLang(): void {
    this.buildTabs();
  }

  // The raw Mirror/REPL console lives in #term; bring it back to the front
  // (unsubscribing any streaming UART tab) before REPL passthrough.
  selectConsole(): void {
    if (this.active !== "console") this.select("console");
  }

  private select(id: number | "console"): void {
    this.active = id;
    // create the terminal BEFORE toggling visibility so a fresh pane is shown too
    if (typeof id === "number" && !this.termById.has(id))
      this.termById.set(id, this.mkTerm(id));
    // console mirror vs uart panes are mutually exclusive
    this.consoleEl.style.display = id === "console" ? "" : "none";
    for (const [bid, t0] of this.termById) t0.host.style.display = bid === id ? "" : "none";
    this.tabsEl.querySelectorAll(".c-tab").forEach((el, i) => {
      el.classList.toggle("on", this.ids[i] === id);
    });
    if (typeof id === "number") {
      this.fitActive();
      this.termById.get(id)!.term.focus();
    }
    this.resub();
  }

  private fitActive(): void {
    if (typeof this.active === "number") this.termById.get(this.active)?.fit.fit();
  }

  // Only the visible UART tab streams; unsub the previous one, sub the new.
  private resub(): void {
    const want = typeof this.active === "number" && this.link.state === "ready" ? this.active : null;
    if (want === this.subbed) return;
    if (this.subbed !== null)
      this.link.sendCmd("unsub", { topic: "uart." + this.subbed }).catch(() => {});
    this.subbed = want;
    if (want !== null) this.link.sendCmd("sub", { topic: "uart." + want }).catch(() => {});
  }

  private async onKey(id: number, d: string): Promise<void> {
    if (this.link.state !== "ready") return;
    const data = Array.from(enc.encode(d));
    if (!data.length) return;
    try {
      const r = await this.link.sendCmd("uart.write", { id, data });
      if (!r.ok) this.termById.get(id)?.term.writeln(C.err + r.error + C.reset);
    } catch (e: any) {
      this.termById.get(id)?.term.writeln(C.err + e.message + C.reset);
    }
  }

  onRx(id: number, bytes: number[]): void {
    const t0 = this.termById.get(id);
    if (!t0) return; // a bus with no open terminal drops its bytes: not being watched
    if (t0.hex) {
      // Stream as an uppercase hex dump; a trailing space keeps chunk boundaries
      // readable without splitting bytes across writes.
      const s = bytes.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, "0")).join(" ");
      t0.term.write(s ? s + " " : "");
    } else {
      t0.term.write(Uint8Array.from(bytes));
    }
  }

  // Called when the link (re)connects so the active tab re-subscribes.
  onLinkReady(): void {
    this.resub();
  }

  onDisconnect(): void {
    this.subbed = null;
  }

  // —— console-bar routing ——
  // When a UART tab is frontmost the #term mirror is hidden, so clear/copy/
  // export must act on the visible tab, not on the console panel.
  uartActive(): boolean {
    return typeof this.active === "number";
  }

  clearActive(): void {
    if (typeof this.active === "number") this.termById.get(this.active)?.term.clear();
  }

  // Plain-text dump of the active UART tab's scrollback, ANSI stripped.
  bufferText(): string {
    const t0 = typeof this.active === "number" ? this.termById.get(this.active) : null;
    if (!t0) return "";
    const b = t0.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
  }

  noteActive(msg: string): void {
    const t0 = typeof this.active === "number" ? this.termById.get(this.active) : null;
    t0?.term.writeln(C.dim + msg + C.reset);
  }
}
