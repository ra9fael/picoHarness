// Layer 2 — JSON-lines protocol. Turns framed text lines into JsonMsg:
// resolves request/response pairs by id, fans device-initiated events out,
// and tracks waiters for the {"evt":"ready"} handshake line. Knows nothing
// about ports; it just consumes lines and writes strings via a callback.
import { Emitter } from "./events";
import { t, tf } from "../i18n";
import type { JsonMsg } from "../types";

const CMD_TIMEOUT_MS = 3000;

export class Rpc extends Emitter {
  private nextId = 1;
  private pending = new Map<number, { resolve: (m: JsonMsg) => void; reject: (e: Error) => void }>();
  private readyWaiters: ((m: JsonMsg) => void)[] = [];

  constructor(private write: (s: string) => Promise<void>) {
    super();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  async sendCmd(cmd: string, args: any = {}): Promise<JsonMsg> {
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, args }) + "\n";
    const reply = new Promise<JsonMsg>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(tf("err_cmd_timeout", cmd)));
        }
      }, CMD_TIMEOUT_MS);
    });
    this.emit("log", "<< " + line.trim());
    await this.write(line);
    return reply;
  }

  waitReady(timeoutMs: number): Promise<JsonMsg> {
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

  failAll(err: string): void {
    for (const p of this.pending.values()) p.reject(new Error(err));
    this.pending.clear();
  }

  // Consume one framed line from the transport.
  feed(line: string): void {
    const start = line.indexOf("{");
    if (start < 0) {
      this.emit("log", "   " + line); // REPL banner etc., non-protocol noise
      return;
    }
    if (start > 0) line = line.slice(start); // strip glued control bytes
    let msg: JsonMsg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit("log", "   " + line);
      return;
    }
    this.emit("log", ">> " + line);
    if (msg.evt === "ready") {
      // Always announced, so the session can tell a handshake reply from a
      // device program that restarted underneath an established link.
      this.emit("ready", msg);
      const waiters = this.readyWaiters;
      this.readyWaiters = [];
      for (const f of waiters) f(msg);
    } else if (msg.evt) {
      this.emit("event", msg);
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const { resolve } = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg);
    }
  }
}
