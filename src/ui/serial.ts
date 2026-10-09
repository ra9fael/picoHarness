// Layer 3 — session facade. Composes Transport (bytes) and Rpc (protocol)
// into the link lifecycle the UI consumes: connect/handshake/REPL进出/state
// machine. Public API is exactly what console.ts and main.ts already use.
import { Transport } from "./core/transport";
import { Rpc } from "./core/rpc";
import { t } from "./i18n";
import type { JsonMsg, LinkState } from "./types";

export type { JsonMsg, LinkState };

const READY_TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SerialLink {
  onLog: (line: string) => void = () => {};
  onEvent: (msg: JsonMsg) => void = () => {};
  onRawData: (bytes: Uint8Array) => void = () => {};
  onStateChange: (state: LinkState) => void = () => {};

  private tp = new Transport();
  private rpc = new Rpc((s) => this.tp.writeRaw(s));

  constructor() {
    this.tp.on("log", (l: string) => this.onLog(l));
    this.tp.on("raw", (b: Uint8Array) => this.onRawData(b));
    this.tp.on("line", (l: string) => this.rpc.feed(l));
    this.tp.on("gone", () => {
      this.rpc.failAll(t("err_link_closed"));
      this.setState("closed");
    });
    this.rpc.on("log", (l: string) => this.onLog(l));
    this.rpc.on("event", (m: JsonMsg) => this.onEvent(m));
  }

  get state(): LinkState {
    return this._state;
  }

  get pendingCount(): number {
    return this.rpc.pendingCount;
  }

  async connect(): Promise<JsonMsg> {
    this.setState("connecting");
    await this.tp.open();
    return this.rehandshake();
  }

  // Restart the device program: Ctrl+C, then one Ctrl+D and wait briefly.
  // If no ready arrives, the first Ctrl+D probably only woke the "Press any
  // key" window — send a second one. A blindly-sent second Ctrl+D would
  // instead leak into code.py's stdin and glue onto the next request line.
  async rehandshake(): Promise<JsonMsg> {
    if (!this.tp.connected) throw new Error(t("err_not_connected"));
    this.setState("open");
    await this.tp.writeRaw("\x03");
    await sleep(500);
    await this.tp.writeRaw("\x04");
    let ready: JsonMsg;
    try {
      ready = await this.rpc.waitReady(2500);
    } catch {
      await this.tp.writeRaw("\x04");
      ready = await this.rpc.waitReady(READY_TIMEOUT_MS);
    }
    // Terminate any stray byte still in the RX buffer so it lands in an
    // ignorable line instead of our next request.
    await this.tp.writeRaw("\n");
    this.setState("ready");
    return ready;
  }

  // Interrupt code.py and land on the ">>>" prompt, verifying each step from
  // the raw device output. Returns true only when the prompt is confirmed.
  async enterRepl(): Promise<boolean> {
    if (!this.tp.connected) throw new Error(t("err_not_connected"));
    this.setState("open");
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.tp.writeRaw("\x03");
      // "Press any key" window opens ~instantly; if already at a prompt, or
      // code.py wasn't running, the next "\n" is equally harmless.
      await this.tp.waitForText(/Press any key|>>>/, 1200);
      await this.tp.writeRaw("\n");
      if (await this.tp.waitForText(/>>>/, 2000)) {
        this.setState("repl");
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  async writeRaw(s: string): Promise<void> {
    await this.tp.writeRaw(s);
  }

  waitReady(timeoutMs: number = READY_TIMEOUT_MS): Promise<JsonMsg> {
    return this.rpc.waitReady(timeoutMs);
  }

  async sendCmd(cmd: string, args: any = {}): Promise<JsonMsg> {
    if (!this.tp.connected) throw new Error(t("err_not_connected"));
    return this.rpc.sendCmd(cmd, args);
  }

  async disconnect(): Promise<void> {
    await this.tp.close();
    this.rpc.failAll(t("err_link_closed"));
    this.setState("closed");
  }

  private _state: LinkState = "closed";

  private setState(s: LinkState) {
    this._state = s;
    this.onStateChange(s);
  }
}
