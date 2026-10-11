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
export async function probePort(port: any, timeoutMs = 900): Promise<PortRole> {
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
  } finally {
    try {
      await port.close();
    } catch {}
  }
}

// Ask every port the browser is already allowed to use, so a reconnect after a
// page reload costs no click. Only when none of them answers do we open the
// picker. `others` are the ports that behaved like the console — candidates for
// the log/REPL link, and for kicking a stopped device program.
export async function findProtocolPort(): Promise<{ port: any; others: any[] }> {
  const others: any[] = [];
  for (const p of await grantedPorts()) {
    if ((await probePort(p)) === "protocol") return { port: p, others };
    others.push(p);
  }
  const p = await askNewPort();
  if ((await probePort(p)) === "protocol") return { port: p, others };
  others.push(p);
  return { port: null, others };
}
