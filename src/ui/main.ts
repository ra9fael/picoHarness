import { SerialLink, type LinkState } from "./serial";
import { ConsolePanel } from "./console";
import { Workbench } from "./workbench/workbench";
import { t, tf, getLang, setLang, type MsgKey } from "./i18n";

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const link = new SerialLink();
const btnConnect = $("btn-connect") as HTMLButtonElement;
const btnPing = $("btn-ping") as HTMLButtonElement;
const btnEcho = $("btn-echo") as HTMLButtonElement;
const btnMode = $("btn-mode") as HTMLButtonElement;
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
    applyModeLabels();
    syncUi();
  },
);

const wb = new Workbench(link, $("gpio"), (m) => consolePanel.note(m));

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
  btnPing.disabled = btnEcho.disabled = linkState !== "ready" || consolePanel.mode !== "monitor";
  wb.setActive(linkState === "ready" && consolePanel.mode === "monitor");
}

function applyStaticLabels() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n as MsgKey);
  });
  btnLang.textContent = t("btn_lang");
  wb.refreshLang();
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
  if (m.evt === "ready") return; // handshake notes are printed where awaited
  if (m.evt === "gpio_in") {
    wb.onEvent(m); // live levels: handled silently, LED-only refresh
    return;
  }
  consolePanel.note(tf("evt", JSON.stringify(m)));
};

btnConnect.addEventListener("click", async () => {
  if (linkState !== "closed") {
    await link.disconnect(); // fires onStateChange(closed); syncUi updates label
    consolePanel.reset();
    consolePanel.note(t("disconnected"));
    return;
  }
  try {
    const ready = await link.connect();
    wb.setCaps(ready.caps);
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

btnLang.addEventListener("click", () => {
  setLang(getLang() === "zh" ? "en" : "zh");
  applyStaticLabels();
});

$("btn-clear").addEventListener("click", () => consolePanel.clear());

$("btn-copy").addEventListener("click", async () => {
  try {
    const text = await consolePanel.copyAll();
    consolePanel.note(tf("log_copied", text.split("\n").length - 1));
  } catch (e: any) {
    consolePanel.note(tf("log_copy_fail", e.message));
  }
});

$("btn-export").addEventListener("click", () => {
  const { name } = consolePanel.exportFile();
  consolePanel.note(tf("log_exported", name));
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
