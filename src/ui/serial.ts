// Layer 3 — session facade. Composes Transport (bytes) and Rpc (protocol)
// into the link lifecycle the UI consumes: port finding, handshake, REPL and
// the state machine. With the dual-CDC firmware (boot.py) the protocol runs on
// one port and the CircuitPython console on another, so control bytes (Ctrl+C /
// Ctrl+D), REPL typing and the mirrored device output belong to the console
// link while requests and replies stay here. On a board without boot.py both
// roles share the single port and this class collapses back to one transport.
import { Transport } from "./core/transport";
import { Rpc } from "./core/rpc";
import { askNewPort, findProtocolPort, grantedPorts, probePort } from "./core/ports";
import type { PortRole } from "./core/ports";
import { t } from "./i18n";
import type { JsonMsg, LinkState } from "./types";

export type { JsonMsg, LinkState };

const READY_TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SerialLink {
  onLog: (line: string) => void = () => {};
  onEvent: (msg: JsonMsg) => void = () => {};
  onRawData: (bytes: Uint8Array, role: PortRole) => void = () => {};
  onFrame: (payload: Uint8Array) => void = () => {};
  onStateChange: (state: LinkState) => void = () => {};
  // Explains a step while it happens (the port picker is about to open again).
  // Separate from onLog, which carries wire chatter.
  onHint: (msg: string) => void = () => {};

  private tp = new Transport();
  private rpc = new Rpc((s) => this.tp.writeRaw(s));
  private ctl: Transport | null = null;
  private capsUsbData = false;

  constructor() {
    this.tp.on("log", (l: string) => this.onLog(l));
    // Tag every mirrored byte with the port it came from. On a dual-CDC board
    // the two ports carry unrelated traffic — the panel decides what to show.
    this.tp.on("raw", (b: Uint8Array) => this.onRawData(b, "protocol"));
    this.tp.on("frame", (b: Uint8Array) => this.onFrame(b));
    this.tp.on("line", (l: string) => this.rpc.feed(l));
    this.tp.on("gone", () => {
      this.rpc.failAll(t("err_link_closed"));
      this.setState("closed");
    });
    this.rpc.on("log", (l: string) => this.onLog(l));
    this.rpc.on("event", (m: JsonMsg) => this.onEvent(m));
    this.rpc.on("ready", (m: JsonMsg) => {
      this.learnCaps(m);
      if (this._state === "ready") this.onEvent(m); // restarted under our feet
    });
  }

  get state(): LinkState {
    return this._state;
  }

  get pendingCount(): number {
    return this.rpc.pendingCount;
  }

  get consoleAttached(): boolean {
    return this.ctl !== null;
  }

  // Whether the board exposes a separate data port (boot.py present and applied
  // on a hard reset). Drives the status bar and the log-port affordance.
  get dualCdc(): boolean {
    return this.capsUsbData;
  }

  // Attach the console port if the browser is already allowed to use it. Never
  // opens the picker, so it is safe to call from the connect flow: a user who
  // has not authorised the second port simply gets false and the button.
  async autoAttachConsole(): Promise<boolean> {
    if (this.ctl) return true;
    for (const p of await grantedPorts()) {
      if (this.tp.owns(p)) continue;
      if ((await probePort(p)) === "console") {
        await this.openConsole(p);
        return true;
      }
    }
    return false;
  }

  // The transport control bytes go to: the console port when we have one,
  // otherwise the single port that does everything.
  private control(): Transport {
    if (!this.tp.connected && !this.ctl) throw new Error(t("err_not_connected"));
    return this.ctl ?? this.tp;
  }

  // On a dual-CDC board Ctrl+C/Ctrl+D mean nothing to the protocol port, so get
  // the console attached before anything tries to restart the device program.
  private async ensureControl(): Promise<Transport> {
    if (!this.ctl && this.capsUsbData) await this.attachConsole();
    return this.control();
  }

  private learnCaps(m: JsonMsg): void {
    const usb = m.caps && m.caps.usb;
    if (usb) this.capsUsbData = !!usb.data;
  }

  // Find the protocol port (already-authorized ones first, the picker only if
  // none answers), open it, and get the device description.
  async connect(): Promise<JsonMsg> {
    this.setState("connecting");
    let found = await findProtocolPort();
    if (!found.port) {
      // Nothing answered a ping, so code.py is not running (stopped at the REPL
      // or crashed). Ctrl+C/Ctrl+D on a console port restarts it, then look
      // again — the protocol port only ever answers once the program is up.
      // The retry opens the picker a second time, so say so first.
      this.onHint(t("hint_second_picker"));
      const cand = found.others[0] ?? (await askNewPort());
      await this.kick(cand);
      found = await findProtocolPort();
    }
    if (!found.port) throw new Error(t("err_no_protocol_port"));
    await this.tp.open(found.port);
    this.setState("open");
    const info = await this.fetchInfo();
    this.setState("ready");
    return info;
  }

  // 0.1.13+ answers hello, so a host that joined after the boot broadcast still
  // gets caps/version without restarting the device. Anything else — older
  // firmware without the command, a device that did not answer at all — takes
  // the legacy path: restart the program and wait for its broadcast ready line.
  private async fetchInfo(): Promise<JsonMsg> {
    let m: JsonMsg | null = null;
    try {
      m = await this.rpc.sendCmd("hello");
    } catch {
      m = null;
    }
    if (!m || !m.ok || !m.data) return this.rehandshake();
    this.learnCaps({ caps: m.data.caps } as JsonMsg);
    return { evt: "ready", ...m.data } as JsonMsg;
  }

  // Send Ctrl+C then Ctrl+D to a port we are not otherwise using, so a stopped
  // device program comes back without leaving that port open.
  private async kick(port: any): Promise<void> {
    const tp = new Transport();
    try {
      await tp.open(port);
      await tp.writeRaw("\x03");
      await sleep(500);
      await tp.writeRaw("\x04");
      await sleep(1200);
    } finally {
      await tp.close();
    }
  }

  // Restart the device program and wait for its ready line.
  async rehandshake(): Promise<JsonMsg> {
    const ctl = await this.ensureControl();
    this.setState("open");
    // Register the ready waiter before the restart bytes go out: a device that
    // answers instantly would otherwise have its ready line dropped.
    const first = this.rpc.waitReady(2500);
    await ctl.writeRaw("\x03");
    await sleep(500);
    await ctl.writeRaw("\x04");
    let ready: JsonMsg;
    try {
      ready = await first;
    } catch {
      await ctl.writeRaw("\x04");
      ready = await this.rpc.waitReady(READY_TIMEOUT_MS);
    }
    // Terminate any stray byte still in the RX buffer so it lands in an
    // ignorable line instead of our next request.
    await ctl.writeRaw("\n");
    this.setState("ready");
    return ready;
  }

  // Attach the CircuitPython console port: device output for the terminal, plus
  // the only place Ctrl+C/Ctrl+D and REPL typing are understood.
  async attachConsole(): Promise<void> {
    if (this.ctl) return;
    for (const p of await grantedPorts()) {
      if (this.tp.owns(p)) continue;
      if ((await probePort(p)) === "console") return this.openConsole(p);
    }
    const p = await askNewPort();
    if (this.tp.owns(p)) throw new Error(t("err_same_port"));
    if ((await probePort(p)) === "protocol") throw new Error(t("err_console_is_protocol"));
    return this.openConsole(p);
  }

  private async openConsole(port: any): Promise<void> {
    const ctl = new Transport();
    ctl.on("raw", (b: Uint8Array) => this.onRawData(b, "console"));
    ctl.on("log", (l: string) => this.onLog(l));
    ctl.on("gone", () => {
      this.ctl = null;
      this.onLog("!! " + t("log_port_lost"));
    });
    await ctl.open(port);
    this.ctl = ctl;
  }

  // Interrupt code.py and land on the ">>>" prompt, verifying each step from
  // the console output. Returns true only when the prompt is confirmed. On a
  // dual-CDC board this attaches the console port first, which works because
  // the caller is a click and the browser only grants pickers on one.
  async enterRepl(): Promise<boolean> {
    const ctl = await this.ensureControl();
    this.setState("open");
    for (let attempt = 0; attempt < 2; attempt++) {
      await ctl.writeRaw("\x03");
      // "Press any key" window opens ~instantly; if already at a prompt, or
      // code.py wasn't running, the next "\n" is equally harmless.
      await ctl.waitForText(/Press any key|>>>/, 1200);
      await ctl.writeRaw("\n");
      if (await ctl.waitForText(/>>>/, 2000)) {
        this.setState("repl");
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  // REPL keystrokes go to the console port, wherever the protocol link happens
  // to be — on a dual-CDC board those are two different sockets.
  async writeToRepl(s: string): Promise<void> {
    await this.control().writeRaw(s);
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
    if (this.ctl) await this.ctl.close();
    this.ctl = null;
    this.rpc.failAll(t("err_link_closed"));
    this.setState("closed");
  }

  private _state: LinkState = "closed";

  private setState(s: LinkState) {
    this._state = s;
    this.onStateChange(s);
  }
}
