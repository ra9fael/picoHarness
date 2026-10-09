// Web Serial transport: JSON-lines request/response + device-initiated events.
// A single reader owns the port; raw bytes are teed to onRawData (terminal)
// while the line framer feeds the JSON protocol layer.
//
// LinkState models port reality, not wishful thinking:
//   closed      no port
//   connecting  requestPort/open in flight
//   open        port healthy, program handshake unconfirmed
//   ready       open + code.py answered with {"evt":"ready"}
//   repl        open + REPL prompt (>>>) confirmed

import { t, tf } from "./i18n";

export type JsonMsg = {
  id?: number | null;
  ok?: boolean;
  error?: string;
  data?: any;
  evt?: string;
  caps?: { pwm?: number[]; adc?: number[] };
};

export type LinkState = "connecting" | "open" | "ready" | "repl" | "closed" | "error";

const READY_TIMEOUT_MS = 8000;
const CMD_TIMEOUT_MS = 3000;
const TEXT_BUF_MAX = 4096;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SerialLink {
  onLog: (line: string) => void = () => {};
  onEvent: (msg: JsonMsg) => void = () => {};
  onRawData: (bytes: Uint8Array) => void = () => {};
  onStateChange: (state: LinkState) => void = () => {};

  private port: any = null;
  private reader: any = null;
  private writer: any = null;
  private running = false;
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: JsonMsg) => void; reject: (e: Error) => void }>();
  private buf = "";
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();
  private readyWaiters: ((m: JsonMsg) => void)[] = [];
  private textBuf = "";
  private textWaiters: { re: RegExp; resolve: (ok: boolean) => void }[] = [];

  async connect(): Promise<JsonMsg> {
    if (!("serial" in navigator)) {
      throw new Error(t("err_no_serial"));
    }
    this.setState("connecting");
    this.port = await (navigator as any).serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.running = true;
    this.pump();
    return this.rehandshake();
  }

  // Restart the device program: Ctrl+C, then one Ctrl+D and wait briefly.
  // If no ready arrives, the first Ctrl+D probably only woke the "Press any
  // key" window — send a second one. A blindly-sent second Ctrl+D would
  // instead leak into code.py's stdin and glue onto the next request line.
  async rehandshake(): Promise<JsonMsg> {
    if (!this.writer) throw new Error(t("err_not_connected"));
    this.setState("open");
    await this.writeRaw("\x03");
    await sleep(500);
    await this.writeRaw("\x04");
    let ready: JsonMsg;
    try {
      ready = await this.waitReady(2500);
    } catch {
      await this.writeRaw("\x04");
      ready = await this.waitReady();
    }
    // Terminate any stray byte still in the RX buffer so it lands in an
    // ignorable line instead of our next request.
    await this.writeRaw("\n");
    this.setState("ready");
    return ready;
  }

  // Interrupt code.py and land on the ">>>" prompt, verifying each step from
  // the raw device output. Returns true only when the prompt is confirmed.
  async enterRepl(): Promise<boolean> {
    if (!this.writer) throw new Error(t("err_not_connected"));
    this.setState("open");
    for (let attempt = 0; attempt < 2; attempt++) {
      this.textBuf = "";
      await this.writeRaw("\x03");
      // "Press any key" window opens ~instantly; if already at a prompt, or
      // code.py wasn't running, the next "\n" is equally harmless.
      await this.waitForText(/Press any key|>>>/, 1200);
      await this.writeRaw("\n");
      if (await this.waitForText(/>>>/, 2000)) {
        this.setState("repl");
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  async writeRaw(s: string) {
    if (!this.writer) throw new Error(t("err_not_connected"));
    await this.writer.write(this.encoder.encode(s));
  }

  waitReady(timeoutMs: number = READY_TIMEOUT_MS): Promise<JsonMsg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((f) => f !== waiter);
        reject(new Error(t("err_ready_timeout")));
      }, timeoutMs);
      const waiter = (m: JsonMsg) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.readyWaiters.push(waiter);
    });
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

  async sendCmd(cmd: string, args: any = {}): Promise<JsonMsg> {
    if (!this.writer) throw new Error(t("err_not_connected"));
    const id = this.nextId++;
    const req = { id, cmd, args };
    const line = JSON.stringify(req) + "\n";
    const reply = new Promise<JsonMsg>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(tf("err_cmd_timeout", cmd)));
        }
      }, CMD_TIMEOUT_MS);
    });
    this.onLog("<< " + line.trim());
    await this.writeRaw(line);
    return reply;
  }

  // Read loop with auto re-attach: a transient read error or stream-end while
  // the port is still alive must NOT flip the UI to "disconnected".
  private async pump() {
    while (this.running) {
      const reader = this.reader;
      let portGone = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("流结束");
          this.onRawData(chunk.value);
          const text = this.decoder.decode(chunk.value, { stream: true });
          this.pushText(text);
          this.buf += text;
          let idx: number;
          while ((idx = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, idx).replace("\r", "").trim();
            this.buf = this.buf.slice(idx + 1);
            if (line) this.handleLine(line);
          }
        }
      } catch (e: any) {
        if (!this.running) break;
        this.onLog("!! " + tf("err_read_break", String(e?.message ?? e)));
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
    if (!this.running) return; // disconnect() already handled state
    this.running = false;
    for (const p of this.pending.values()) p.reject(new Error(t("err_link_closed")));
    this.pending.clear();
    this.setState("closed");
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

  private handleLine(line: string) {
    const start = line.indexOf("{");
    if (start < 0) {
      this.onLog("   " + line); // REPL banner etc., non-protocol noise
      return;
    }
    if (start > 0) line = line.slice(start); // strip glued control bytes
    let msg: JsonMsg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onLog("   " + line);
      return;
    }
    this.onLog(">> " + line);
    if (msg.evt === "ready") {
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const f of waiters) f(msg);
    } else if (msg.evt) {
      this.onEvent(msg);
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg);
    }
  }

  private _state: LinkState = "closed";
  get state(): LinkState {
    return this._state;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private setState(s: LinkState) {
    this._state = s;
    this.onStateChange(s);
  }

  async disconnect() {
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
    for (const p of this.pending.values()) p.reject(new Error(t("err_link_closed")));
    this.pending.clear();
    this.setState("closed");
  }
}
