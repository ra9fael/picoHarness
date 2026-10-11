// Layer 1 — byte plumbing. Owns one Web Serial port and its single reader:
// opens it, and byte-scans the inbound stream for two interleaved kinds of
// data — ASCII text lines (framed on "\n", emitted as "line", and teed to the
// terminal as "raw") and binary waveform frames (0xAA 'W' + u16le len +
// payload, emitted as "frame" with the payload bytes).
// Our text is pure ASCII JSON so the 0xAA magic can never occur inside it,
// which makes the scan unambiguous. It survives transient read breaks by
// re-attaching the reader as long as the port is alive. Emits "log" for
// wire-level chatter and "gone" when the link actually died.
// It knows nothing about JSON or commands, and one instance is used per port:
// the protocol port and, when the user attaches it, the CircuitPython console.
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
  private raw: number[] = [];
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private textBuf = "";
  private textWaiters: { re: RegExp; resolve: (ok: boolean) => void }[] = [];

  get connected(): boolean {
    return this.writer !== null;
  }

  // `port` lets the caller hand in a port it already found and identified;
  // without one the browser picker asks the user.
  async open(port?: any): Promise<void> {
    if (!("serial" in navigator)) throw new Error(t("err_no_serial"));
    this.port = port ?? (await (navigator as any).serial.requestPort());
    await this.port.open({ baudRate: 115200 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.running = true;
    void this.pump();
  }

  owns(port: any): boolean {
    return this.port === port;
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
          this.feedBytes(chunk.value);
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
      this.raw = [];
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

  // Append a chunk to the byte buffer, then split it into text runs and
  // complete binary frames. Bytes that could be the start of a not-yet-
  // complete frame stay buffered until the rest arrives.
  private feedBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.raw.push(bytes[i]);
    this.drainRaw();
  }

  private drainRaw(): void {
    const r = this.raw;
    let pos = 0;
    while (pos < r.length) {
      const m = r.indexOf(0xaa, pos);
      if (m < 0) {
        this.feedText(r.slice(pos));
        pos = r.length;
        break;
      }
      if (m > pos) this.feedText(r.slice(pos, m));
      pos = m;
      if (pos + 1 >= r.length) break; // wait for the byte after 0xAA
      if (r[pos + 1] !== 0x57) {
        pos += 1; // spurious 0xAA in an ASCII stream — drop and keep scanning
        continue;
      }
      if (pos + 4 > r.length) break; // wait for the u16 length
      const len = r[pos + 2] | (r[pos + 3] << 8);
      if (pos + 4 + len > r.length) break; // wait for the full payload
      this.emit("frame", new Uint8Array(r.slice(pos + 4, pos + 4 + len)));
      pos += 4 + len;
    }
    this.raw = r.slice(pos);
  }

  private feedText(bytes: number[]): void {
    if (!bytes.length) return;
    const u8 = new Uint8Array(bytes);
    this.emit("raw", u8);
    const text = this.decoder.decode(u8);
    this.pushText(text);
    this.buf += text;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace("\r", "").trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.emit("line", line);
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
