// Minimal i18n: zh/en dictionaries, t()/tf() lookup, persisted choice.
// Dynamic console lines are translated when written; historic lines stay as-is.

export type Lang = "zh" | "en";

const dict = {
  zh: {
    subtitle: "USB CDC",
    btn_connect: "连接设备",
    btn_disconnect: "断开设备",
    btn_ping: "Ping",
    btn_echo: "Echo",
    btn_lang: "EN",
    console_label: "控制台",
    mode_monitor: "监听",
    mode_repl: "REPL 直通",
    btn_mode_repl: "进入 REPL",
    btn_mode_monitor: "返回监听",
    btn_clear: "清屏",
    btn_copy: "复制日志",
    btn_export: "导出",
    btn_collapse: "收起",
    btn_expand: "展开",
    st_connecting: "连接中…",
    st_open: "已连接 · 握手未完成",
    st_ready: "已连接",
    st_repl: "已连接 · REPL",
    st_closed: "未连接",
    st_error: "错误",
    welcome: "PicoHarness 调试控制台 — 设备原始输出镜像",
    no_serial: "当前浏览器不支持 Web Serial，请使用桌面版 Chrome/Edge 打开本页面。",
    handshake_ok: "握手成功: {0}",
    handshake_fail: "握手失败: {0}（端口已打开，可稍后返回监听重试）",
    disconnected: "已断开连接",
    repl_enter: "— 进入 REPL：发送 Ctrl+C，确认 >>> 提示符 —",
    repl_ready: "REPL 就绪，键盘直通设备",
    repl_fail: "未能确认 REPL 提示符，可在终端内按 Ctrl+C 后回车，或重新点击本按钮",
    back_monitor: "— 返回监听：重新握手… —",
    monitor_ready: "ready: {0}",
    handshake_short: "握手失败: {0}",
    ping_rtt: "ping 往返 {0} ms, 应答: {1}",
    ping_fail: "ping 失败: {0}",
    echo_reply: "echo 应答: {0}",
    echo_fail: "echo 失败: {0}",
    evt: "事件: {0}",
    log_copied: "日志已复制到剪贴板（{0} 行）",
    log_copy_fail: "复制失败: {0}，请改用导出",
    log_exported: "已导出 {0}",
    err_no_serial: "Web Serial 不可用：请使用桌面版 Chrome/Edge",
    err_not_connected: "未连接",
    err_ready_timeout: "握手超时：未收到设备 ready 行",
    err_cmd_timeout: "命令超时: {0}",
    err_read_break: "串口读取中断: {0}",
    err_link_closed: "连接已断开",
    wb_help:
      "拖动或点选 GP 芯片放入泳道，修改即时下发；拖回池中（或点 ×）释放引脚。同一引脚只属于一个功能。",
    lane_in: "数字输入",
    lane_out: "数字输出",
    lane_pwm: "PWM 信号源",
    lane_adc: "ADC 读取",
    pwm_preset: "频率预设…",
    hint_sel: "已选中 GP{0} — 点击高亮泳道绑定；点空白处取消",
    hint_no_pwm: "GP{0} 不在固件 PWM 能力表中",
    pull_up: "上拉",
    pull_down: "下拉",
    pull_none: "无",
    gpio_apply_fail: "GPIO 应用失败: {0}",
    gpio_cmd_fail: "GPIO 命令失败: {0}",
  },
  en: {
    subtitle: "USB CDC",
    btn_connect: "Connect",
    btn_disconnect: "Disconnect",
    btn_ping: "Ping",
    btn_echo: "Echo",
    btn_lang: "中文",
    console_label: "Console",
    mode_monitor: "Monitor",
    mode_repl: "REPL Live",
    btn_mode_repl: "Enter REPL",
    btn_mode_monitor: "Back to Monitor",
    btn_clear: "Clear",
    btn_copy: "Copy Log",
    btn_export: "Export",
    btn_collapse: "Collapse",
    btn_expand: "Expand",
    st_connecting: "Connecting…",
    st_open: "Connected · no handshake",
    st_ready: "Connected",
    st_repl: "Connected · REPL",
    st_closed: "Disconnected",
    st_error: "Error",
    welcome: "PicoHarness debug console — raw device output mirror",
    no_serial: "This browser has no Web Serial API. Open the page in desktop Chrome/Edge.",
    handshake_ok: "Handshake OK: {0}",
    handshake_fail: "Handshake failed: {0} (port is open; retry later via Back to Monitor)",
    disconnected: "Disconnected",
    repl_enter: "— Entering REPL: Ctrl+C sent, waiting for >>> prompt —",
    repl_ready: "REPL ready, keyboard routed to device",
    repl_fail: "Could not confirm the >>> prompt — press Ctrl+C then Enter in the terminal, or click this button again",
    back_monitor: "— Back to monitor: re-handshaking… —",
    monitor_ready: "ready: {0}",
    handshake_short: "Handshake failed: {0}",
    ping_rtt: "ping RTT {0} ms, reply: {1}",
    ping_fail: "ping failed: {0}",
    echo_reply: "echo reply: {0}",
    echo_fail: "echo failed: {0}",
    evt: "event: {0}",
    log_copied: "Log copied to clipboard ({0} lines)",
    log_copy_fail: "Copy failed: {0} — use Export instead",
    log_exported: "Exported {0}",
    err_no_serial: "Web Serial unavailable — use desktop Chrome/Edge",
    err_not_connected: "Not connected",
    err_ready_timeout: "Handshake timeout: no ready line from device",
    err_cmd_timeout: "Command timeout: {0}",
    err_read_break: "Serial read interrupted: {0}",
    err_link_closed: "Link closed",
    wb_help:
      "Drag or click a GP chip into a lane — changes apply instantly; drag back to the pool (or click ×) to release. Each pin belongs to one function.",
    lane_in: "Digital Input",
    lane_out: "Digital Output",
    lane_pwm: "PWM Source",
    lane_adc: "ADC Read",
    pwm_preset: "Preset…",
    hint_sel: "GP{0} selected — click a highlighted lane to bind; click empty space to cancel",
    hint_no_pwm: "GP{0} is not in the firmware PWM caps table",
    pull_up: "Up",
    pull_down: "Down",
    pull_none: "None",
    gpio_apply_fail: "GPIO apply failed: {0}",
    gpio_cmd_fail: "GPIO command failed: {0}",
  },
};

export type MsgKey = keyof (typeof dict)["zh"];

let current: Lang = (() => {
  let saved = "";
  try {
    saved = localStorage.getItem("picoharness-lang") || "";
  } catch {}
  if (saved === "zh" || saved === "en") return saved;
  return (navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
})();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem("picoharness-lang", l);
  } catch {}
}

export function t(key: MsgKey): string {
  return dict[current][key];
}

export function tf(key: MsgKey, ...args: (string | number)[]): string {
  let s = dict[current][key];
  args.forEach((a, i) => (s = s.replace("{" + i + "}", String(a))));
  return s;
}
