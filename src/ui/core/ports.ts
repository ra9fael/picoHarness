// Port identification. With boot.py the board enumerates TWO CDC serial ports
// that share one VID/PID, and Web Serial exposes nothing that distinguishes
// them — getInfo() gives the same vendor/product for both. So the only oracle
// is to ask: the protocol port answers a ping with the nonce we sent, and the
// CircuitPython console never can.
import { t } from "../i18n";

const PROBE_ID = 987654;

export type PortRole = "protocol" | "console";

export async function grantedPorts(): Promise<any[]> {
  if (!("serial" in navigator)) throw new Error(t("err_no_serial"));
  return await (navigator as any).serial.getPorts();
}

export async function askNewPort(): Promise<any> {
  if (!("serial" in navigator)) throw new Error(t("err_no_serial"));
  return await (navigator as any).serial.requestPort();
}

// Open a port just long enough to classify it, then close it again. A reply
// carrying our nonce can only come from code.py, so "protocol" is a positive
// identification; "console" is everything else, including a port whose device
// program is stopped at the REPL.
//
// The answer is remembered per port object because classification costs a full
// open/round-trip/close and the same two ports get asked on every connect, every
// auto-attach and every retry. Two things bound the staleness: the object is
// created fresh whenever the browser sees the device again, so a replug or a
// re-grant can never inherit an old role; and a restart of the device program
// goes through forgetRole(), which is exactly the one event that can flip a
// port from "no answer" to "protocol".
const roleCache = new WeakMap<object, { role: PortRole; at: number }>();
const ROLE_TTL_MS = 4000;

// A probe owns the port for its whole duration, so a second caller asking about
// the same port waits for the first answer instead of opening it a second time
// (which the browser refuses, and which would then look like a dead port).
const inFlight = new WeakMap<object, Promise<PortRole>>();

export function probePort(port: any, timeoutMs = 900): Promise<PortRole> {
  const hit = roleCache.get(port);
  if (hit && Date.now() - hit.at < ROLE_TTL_MS) return Promise.resolve(hit.role);
  const pending = inFlight.get(port);
  if (pending) return pending;
  const ask = classify(port, timeoutMs).then((role) => {
    inFlight.delete(port);
    if (role === null) return "console";
    roleCache.set(port, { role, at: Date.now() });
    return role;
  });
  inFlight.set(port, ask);
  return ask;
}

// Which candidate to send Ctrl+C/Ctrl+D to when nothing answers a ping: control
// bytes only reach the CircuitPython console, and a silent protocol port and an
// idle console look identical to the ping probe. What separates them is chatter
// — a console at a prompt, printing a banner, or showing a traceback puts bytes
// on the wire, and the data port of a stopped program puts nothing. So the port
// that said anything is the one worth kicking.
const chatter = new WeakMap<object, number>();

// Orders ports so the most talkative comes first; used for the kick candidate.
export function byChatter(ports: any[]): any[] {
  return ports.slice().sort((a, b) => (chatter.get(b) ?? 0) - (chatter.get(a) ?? 0));
}

// Forget an answer. A port we just restarted with Ctrl+C/Ctrl+D can genuinely
// change role — code.py was not running when we asked — so its cached verdict
// must not decide the next attempt.
export function forgetRole(port: any): void {
  roleCache.delete(port);
}

export function forgetRoles(ports: any[]): void {
  for (const p of ports) forgetRole(p);
}

// The asking itself. null means "I could not even ask" (the port refused to
// open), which probePort answers as "console" for the caller but does not
// remember — a failed question is not evidence about the port.
async function classify(port: any, timeoutMs: number): Promise<PortRole | null> {
  const nonce = "p" + Date.now().toString(36);
  const line = JSON.stringify({ id: PROBE_ID, cmd: "ping", args: { t: nonce } }) + "\n";
  let text = "";
  try {
    await port.open({ baudRate: 115200 });
    const w = port.writable.getWriter();
    await w.write(new TextEncoder().encode(line));
    w.releaseLock();
    const r = port.readable.getReader();
    const dec = new TextDecoder();
    const until = Date.now() + timeoutMs;
    try {
      while (Date.now() < until) {
        const winner: any = await Promise.race([
          r.read(),
          new Promise((res) => setTimeout(() => res({ timeout: true }), Math.max(50, until - Date.now()))),
        ]);
        if (winner.timeout) break;
        if (winner.done) break;
        text += dec.decode(winner.value, { stream: true });
        if (text.indexOf('"pong":"' + nonce) >= 0) return "protocol";
      }
    } finally {
      try {
        await r.cancel();
      } catch {}
      try {
        r.releaseLock();
      } catch {}
    }
    return "console";
  } catch {
    return null;
  } finally {
    chatter.set(port, text.length);
    try {
      await port.close();
    } catch {}
  }
}

// Ask every port the browser is already allowed to use, so a reconnect after a
// page reload costs no click. The questions go out together and the first
// positive answer wins: a port that never replies is only ever a "console" by
// elimination, which costs the full timeout, and waiting for that verdict before
// connecting was the slow part. The other probes keep running in the background
// and land in the role cache, so the log-port attach right after is free.
// `others` are the ports that are not the protocol port — candidates for the
// log/REPL link, and for kicking a stopped device program.
//
// The picker only opens when the browser holds no grant at all. When ports are
// granted but none answers, code.py is simply not running: the caller restarts
// it and asks again, and a picker in between would only earn a cancel.
export async function findProtocolPort(): Promise<{ port: any; others: any[] }> {
  const granted = await grantedPorts();
  if (granted.length) {
    const probes = granted.map((p) => probePort(p));
    const i = await new Promise<number>((resolve) => {
      probes.forEach((pr, j) => void pr.then((role) => role === "protocol" && resolve(j)));
      void Promise.all(probes).then(() => resolve(-1));
    });
    if (i >= 0) return { port: granted[i], others: granted.filter((_, j) => j !== i) };
    // resolve(-1) only happens once every probe has answered, so the caller's
    // restart of the device program is clearing cache entries that are fresh.
    return { port: null, others: granted };
  }
  const p = await askNewPort();
  if ((await probePort(p)) === "protocol") return { port: p, others: [] };
  return { port: null, others: [p] };
}
