import { SerialLink, type LinkState } from "./serial";
import { ConsolePanel } from "./console";
import { Workbench } from "./workbench/workbench";
import { Scope } from "./workbench/scope";
import { UartTerminals } from "./workbench/uartterm";
import { t, tf, getLang, setLang, type MsgKey } from "./i18n";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const link = new SerialLink();
const btnConnect = $("btn-connect") as HTMLButtonElement;
const btnPing = $("btn-ping") as HTMLButtonElement;
const btnEcho = $("btn-echo") as HTMLButtonElement;
const btnMode = $("btn-mode") as HTMLButtonElement;
const btnLog = $("btn-logport") as HTMLButtonElement;
const btnLang = $("btn-lang") as HTMLButtonElement;
const btnCollapse = $("btn-collapse") as HTMLButtonElement;
const statusEl = $("status");

let linkState: LinkState = "closed";
const hasSerial = "serial" in navigator;

const STATE_KEY: Record<LinkState, MsgKey> = {
  connecting: "st_connecting",
  open: "st_open",
  ready: "st_ready",
  repl: "st_repl",
  closed: "st_closed",
  error: "st_error",
};

const consolePanel = new ConsolePanel(
  link,
  $("term"),
  () => {
    if (consolePanel.mode === "repl") uartTerms.selectConsole();
    applyModeLabels();
    syncUi();
  },
);

const wb = new Workbench(link, $("gpio"), (m) => consolePanel.note(m));
const scope = new Scope(link, wb.model, (m) => consolePanel.note(m), $("scope"));
// Binary waveform frames bypass the JSON rpc layer entirely; the scope decodes
// them and feeds the newest row back into the model for the chip readouts.
link.onFrame = (payload) => scope.onFrame(payload);
scope.onLatest = (vals) => wb.model.ingestAdc(vals);

// One live terminal tab per UART bus, sharing the console dock with the raw
// mirror. Tabs follow the bus list; RX events route to the matching terminal.
const uartTerms = new UartTerminals(
  link,
  wb.model,
  $("console-tabs"),
  $("uart-panes"),
  $("term")
);
wb.model.on("config", () => uartTerms.sync());

function applyModeLabels() {
  const m = consolePanel.mode;
  const tag = $("mode-tag");
  tag.textContent = m === "repl" ? t("mode_repl") : t("mode_monitor");
  tag.className = m === "repl" ? "repl" : "";
  btnMode.textContent = m === "repl" ? t("btn_mode_monitor") : t("btn_mode_repl");
}

function syncUi() {
  statusEl.textContent = t(STATE_KEY[linkState]);
  statusEl.className =
    linkState === "ready" || linkState === "repl" ? "ok" : linkState === "closed" ? "" : "bad";
  btnConnect.textContent = linkState === "closed" ? t("btn_connect") : t("btn_disconnect");
  btnConnect.disabled = !hasSerial || linkState === "connecting";
  const logged = link.consoleAttached;
  btnLog.textContent = t(logged ? "btn_logport_on" : "btn_logport");
  btnLog.disabled = logged || linkState !== "ready";
  btnPing.disabled = btnEcho.disabled = linkState !== "ready" || consolePanel.mode !== "monitor";
  wb.setActive(linkState === "ready" && consolePanel.mode === "monitor");
  scope.setActive(linkState === "ready" && consolePanel.mode === "monitor");
}

function applyStaticLabels() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n as MsgKey);
  });
  btnLang.textContent = t("btn_lang");
  wb.refreshLang();
  scope.refreshLang();
  uartTerms.refreshLang();
  applyModeLabels();
  const dock = $("console-dock");
  btnCollapse.textContent = dock.classList.contains("collapsed")
    ? t("btn_expand")
    : t("btn_collapse");
  syncUi();
}

link.onStateChange = (s) => {
  linkState = s;
  syncUi();
};
link.onEvent = (m) => {
  if (m.evt === "ready") {
    // Only reaches here when the program restarted under an established link
    // (reset button, or code.py saved from Explorer): caps may have changed.
    wb.setCaps(m.caps);
    consolePanel.note(tf("ready_again", JSON.stringify(m)));
    return;
  }
  if (m.evt === "adc_w") {
    scope.onMsg(m); // batched waveform frames: drawn on rAF, never logged
    return;
  }
  if (m.evt === "uart_rx") {
    uartTerms.onRx(m.id as number, m.data as number[]); // streamed RX bytes: typed into the tab, never logged
    return;
  }
  if (m.evt === "gpio_in" || m.evt === "adc") {
    wb.onEvent(m); // live levels / ADC readings: handled silently, targeted refresh
    return;
  }
  consolePanel.note(tf("evt", JSON.stringify(m)));
};

btnConnect.addEventListener("click", async () => {
  if (linkState !== "closed") {
    await link.disconnect(); // fires onStateChange(closed); syncUi updates label
    uartTerms.onDisconnect();
    consolePanel.reset();
    consolePanel.note(t("disconnected"));
    return;
  }
  try {
    const ready = await link.connect();
    wb.setCaps(ready.caps);
    uartTerms.onLinkReady();
    consolePanel.note(tf("handshake_ok", JSON.stringify(ready)));
  } catch (e: any) {
    consolePanel.note(tf("handshake_fail", e.message));
    if (link.state === "connecting") {
      linkState = "closed"; // port picker cancelled or open failed
      syncUi();
    }
  }
});

btnPing.addEventListener("click", async () => {
  try {
    const t0 = Date.now();
    const m = await link.sendCmd("ping", { t: t0 });
    consolePanel.note(tf("ping_rtt", Date.now() - t0, JSON.stringify(m.data ?? m.error)));
  } catch (e: any) {
    consolePanel.note(tf("ping_fail", e.message));
  }
});

btnEcho.addEventListener("click", async () => {
  try {
    const m = await link.sendCmd("echo", { msg: "hello pico" });
    consolePanel.note(tf("echo_reply", JSON.stringify(m.data ?? m.error)));
  } catch (e: any) {
    consolePanel.note(tf("echo_fail", e.message));
  }
});

btnMode.addEventListener("click", () =>
  consolePanel.setMode(consolePanel.mode === "monitor" ? "repl" : "monitor")
);

btnLog.addEventListener("click", async () => {
  try {
    await link.attachConsole();
    consolePanel.note(t("logport_ok"));
  } catch (e: any) {
    consolePanel.note(tf("logport_fail", e.message));
  }
  syncUi();
});

btnLang.addEventListener("click", () => {
  setLang(getLang() === "zh" ? "en" : "zh");
  applyStaticLabels();
});

$("btn-clear").addEventListener("click", () => {
  if (uartTerms.uartActive()) uartTerms.clearActive();
  else consolePanel.clear();
});

$("btn-copy").addEventListener("click", async () => {
  const uart = uartTerms.uartActive();
  const note = (m: string) => (uart ? uartTerms.noteActive(m) : consolePanel.note(m));
  try {
    const text = uart ? uartTerms.bufferText() : await consolePanel.copyAll();
    if (uart) await consolePanel.copyText(text);
    note(tf("log_copied", text.split("\n").length - 1));
  } catch (e: any) {
    note(tf("log_copy_fail", e.message));
  }
});

$("btn-export").addEventListener("click", () => {
  const uart = uartTerms.uartActive();
  const { name } = uart ? consolePanel.exportText(uartTerms.bufferText()) : consolePanel.exportFile();
  (uart ? (m: string) => uartTerms.noteActive(m) : (m: string) => consolePanel.note(m))(
    tf("log_exported", name)
  );
});

btnCollapse.addEventListener("click", () => {
  const dock = $("console-dock");
  dock.classList.toggle("collapsed");
  btnCollapse.textContent = dock.classList.contains("collapsed")
    ? t("btn_expand")
    : t("btn_collapse");
});

if (!hasSerial) {
  consolePanel.note(t("no_serial"));
}
applyStaticLabels();
