// Layer 1 — byte plumbing. Owns the Web Serial port and the single reader:
// opens it, tees raw bytes ("raw") to the terminal, frames UTF-8 text into
// lines ("line"), and survives transient read breaks by re-attaching the
// reader as long as the port is alive. Emits "log" for wire-level chatter and
// "gone" when the link actually died (unplugged / stream ended for good).
// It knows nothing about JSON or commands.
import { Emitter } from "./events";
import { t, tf } from "../i18n";

const TEXT_BUF_MAX = 4096;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Transport extends Emitter {
  private port: any = null;
  private reader: any = null;
  private writer: any = null;
  private running = false;
  private buf = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private textBuf = "";
  private textWaiters: { re: RegExp; resolve: (ok: boolean) => void }[] = [];

  get connected(): boolean {
    return this.writer !== null;
  }

  async open(): Promise<void> {
    if (!("serial" in navigator)) throw new Error(t("err_no_serial"));
    this.port = await (navigator as any).serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.running = true;
    void this.pump();
  }

  async writeRaw(s: string): Promise<void> {
    if (!this.writer) throw new Error(t("err_not_connected"));
    await this.writer.write(this.encoder.encode(s));
  }

  // Resolve true when `re` appears in device output within timeoutMs.
  waitForText(re: RegExp, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (re.test(this.textBuf)) return resolve(true);
      const waiter = { re, resolve };
      this.textWaiters.push(waiter);
      setTimeout(() => {
        this.textWaiters = this.textWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
    });
  }

  async close(): Promise<void> {
    this.running = false;
    try {
      if (this.reader) await this.reader.cancel();
      if (this.writer) await this.writer.abort("user");
    } catch {}
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {}
    this.reader = this.writer = this.port = null;
  }

  // Read loop with auto re-attach: a transient read error or stream-end while
  // the port is still alive must NOT be reported as a disconnect.
  private async pump(): Promise<void> {
    while (this.running) {
      const reader = this.reader;
      let portGone = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("流结束");
          this.emit("raw", chunk.value);
          const text = this.decoder.decode(chunk.value, { stream: true });
          this.pushText(text);
          this.buf += text;
          let idx: number;
          while ((idx = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, idx).replace("\r", "").trim();
            this.buf = this.buf.slice(idx + 1);
            if (line) this.emit("line", line);
          }
        }
      } catch (e: any) {
        if (!this.running) break;
        this.emit("log", "!! " + tf("err_read_break", String(e?.message ?? e)));
        portGone = !this.port || !this.port.readable;
      }
      if (!this.running || portGone) break;
      try {
        reader.releaseLock();
      } catch {}
      this.buf = "";
      this.decoder = new TextDecoder();
      await sleep(300);
      if (!this.running) break;
      if (!this.port?.readable) break;
      this.reader = this.port.readable.getReader();
    }
    if (this.running) {
      this.running = false;
      this.emit("gone");
    }
  }

  private pushText(text: string) {
    this.textBuf += text;
    if (this.textBuf.length > TEXT_BUF_MAX) {
      this.textBuf = this.textBuf.slice(-TEXT_BUF_MAX);
    }
    const hit = this.textWaiters.filter((w) => w.re.test(this.textBuf));
    if (hit.length) {
      this.textWaiters = this.textWaiters.filter((w) => !w.re.test(this.textBuf));
      for (const w of hit) w.resolve(true);
    }
  }
}
