// Debug console: xterm.js terminal fed by the device's own output — the
// CircuitPython console port when one is attached, the protocol port otherwise.
// Monitor mode = read-only mirror; REPL mode = keyboard passthrough to >>>.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { SerialLink } from "./serial";
import { t, tf } from "./i18n";

const C = {
  tx: "\x1b[38;5;75m",
  sys: "\x1b[38;5;245m",
  err: "\x1b[38;5;203m",
  reset: "\x1b[0m",
};

export class ConsolePanel {
  private term: Terminal;
  private fit: FitAddon;
  mode: "monitor" | "repl" = "monitor";

  constructor(
    private link: SerialLink,
    mount: HTMLElement,
    private onModeChange: (m: "monitor" | "repl") => void = () => {},
  ) {
    this.term = new Terminal({
      fontSize: 12,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      cursorBlink: true,
      disableStdin: true,
      theme: {
        background: "#0b0e11",
        foreground: "#d5dde5",
        cursor: "#3fb6a8",
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(mount);
    this.fit.fit();

    this.term.writeln(C.sys + t("welcome") + C.reset);

    link.onRawData = (b) => this.term.write(b);
    link.onLog = (line) => {
      if (line.startsWith("<<")) this.term.writeln(C.tx + line + C.reset);
      else if (line.startsWith("!!")) this.term.writeln(C.err + line + C.reset);
      // ">>" and "  " noise already shown via raw stream; skip duplicates.
    };

    this.term.onData((d) => {
      if (this.mode === "repl") this.link.writeToRepl(d).catch(() => {});
    });

    new ResizeObserver(() => this.fit.fit()).observe(mount);
  }

  async setMode(mode: "monitor" | "repl") {
    if (mode === this.mode) return;
    this.mode = mode;
    this.term.options.disableStdin = mode !== "repl";
    this.onModeChange(this.mode);
    if (mode === "repl") {
      this.term.writeln(C.sys + t("repl_enter") + C.reset);
      const ok = await this.link.enterRepl();
      if (ok) {
        this.term.writeln(C.sys + t("repl_ready") + C.reset);
      } else {
        this.term.writeln(C.err + t("repl_fail") + C.reset);
      }
      if (this.mode === "repl") this.term.focus();
    } else {
      this.term.writeln(C.sys + t("back_monitor") + C.reset);
      try {
        const ready = await this.link.rehandshake();
        this.term.writeln(C.sys + tf("monitor_ready", JSON.stringify(ready)) + C.reset);
      } catch (e: any) {
        this.term.writeln(C.err + tf("handshake_short", e.message) + C.reset);
      }
    }
  }

  reset() {
    this.mode = "monitor";
    this.term.options.disableStdin = true;
    this.onModeChange(this.mode);
  }

  clear() {
    this.term.clear();
  }

  // Plain-text dump of the visible scrollback, ANSI stripped.
  bufferText(): string {
    const b = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) {
      lines.push(b.getLine(i)?.translateToString(true) ?? "");
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
  }

  async copyAll(): Promise<string> {
    return this.copyText(this.bufferText());
  }

  // Shared clipboard path: usable for the console mirror or a UART tab buffer.
  async copyText(text: string): Promise<string> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // file:// origins can deny the async API; legacy copy still works
      // from a user gesture.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.className = "copy-sink";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    return text;
  }

  exportFile(): { name: string; lines: number } {
    return this.exportText(this.bufferText());
  }

  exportText(text: string): { name: string; lines: number } {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const name = `picoharness-log-${d.getFullYear()}${p(d.getMonth() + 1)}${p(
      d.getDate()
    )}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.txt`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return { name, lines: text.split("\n").length - 1 };
  }

  note(msg: string) {
    this.term.writeln(C.sys + msg + C.reset);
  }
}
