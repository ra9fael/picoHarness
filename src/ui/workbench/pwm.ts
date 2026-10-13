// PWM function lane: per-pin freq/duty editors. One number box + a caret
// that opens the full 1..1000 preset grid (a datalist was tried and rejected:
// browsers filter suggestions by the current value, so typing 50 only shows
// 50/500) × one unit pick (mHz/Hz/kHz/MHz), plus a HW|PIO pick that chooses which
// generator drives the pin. The two have different windows and both ends come from
// the device's caps tables, never from a number typed in here: the slice cannot be
// asked for a period below 1 Hz, the PIO countdown reaches hundredths of a hertz,
// so the low end is where the PIO mode earns its place. Neither generator honours
// every request — 1..8 Hz on a slice all run at 9 Hz and 1000 Hz lands on 990 — so
// the firmware echoes the frequency the pin really produces and the box turns amber
// when it differs. Below the accept window the firmware answers with its own
// refusal and the card shows that line, which survives whatever the UI assumed.
// rp2 slices share frequency, so batching across pins would
// be wrong anyway — each pin has its own debounce timer; release stops the
// output immediately.
import { tf } from "../i18n";
import {
  C_PWM,
  C_PWM_PIO,
  NUM,
  R_PWM,
  PWM_UNIT_AUTO,
  pinLabel,
  type PwmBackend,
  type PwmParam,
} from "../model/pins";
import { el, clamp } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

const UNITS = [
  { exp: -3, label: "mHz" },
  { exp: 0, label: "Hz" },
  { exp: 3, label: "kHz" },
  { exp: 6, label: "MHz" },
];
const PRESETS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]; // numeric (mantissa) presets
// The two generators, in the order the pick shows them. A channel always has one,
// hardware first, because that is what every config saved before the PIO lane means.
const BACKENDS: PwmBackend[] = ["hw", "pio"];

const autoExp = (hz: number) => (hz >= 1e6 ? 6 : hz >= 1e3 ? 3 : hz >= 1 ? 0 : -3);

// mantissa × 10^exp lands on float noise (0.07 kHz → 70.00000000000001 Hz);
// six-decimal rounding keeps the box and the wire value clean.
const norm = (hz: number) => Math.round(hz * 1e6) / 1e6;

// A PIO period is a whole number of SM ticks, so the frequency the pin produces is
// clock/cycles and carries more decimals than a hardware slice ever reports. Six
// significant digits is well inside the divider's own error and keeps the text
// readable at 0.0175 Hz.
const fmtHz = (hz: number): string => String(Number(hz.toPrecision(6)));

// The window edges are exact divisions of the caps table, and the six-decimal rounding a
// box lands on can fall on the wrong side of one: the PIO floor is 0.01745533… Hz, and
// rounding that to nearest asks the firmware for a clock below its minimum. An edge is
// therefore always rounded inward, never to nearest.
const clampWin = (hz: number, lo: number, hi: number): number =>
  hz <= lo ? Math.ceil(lo * 1e6) / 1e6 : hz >= hi ? Math.floor(hi * 1e6) / 1e6 : norm(hz);

export class PwmDriver {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  // slot -> its frequency box, so a device reply can mark that box without a
  // full chip rebuild (which would destroy an input the user is typing into).
  private freqEls = new Map<number, HTMLInputElement>();
  // slot -> the function that repaints that box from the model, so a generator
  // switch can re-show the clamped frequency without rebuilding the chip.
  private showFns = new Map<number, () => void>();
  // slot -> the frequency the firmware last reported as actually generated.
  private hwFreq = new Map<number, number>();
  // slot -> the last refusal the firmware sent for this channel, shown in the card
  // as well as the console: "no free PIO state machine (12/12)" is about one pin.
  private errs = new Map<number, string>();
  private errEls = new Map<number, HTMLElement>();

  constructor(private api: FuncApi) {}

  schedule(n: number): void {
    const old = this.timers.get(n);
    if (old) clearTimeout(old);
    this.timers.set(
      n,
      setTimeout(() => {
        this.timers.delete(n);
        void this.sendNow(n);
      }, 250),
    );
  }

  scheduleAll(): void {
    for (let n = 0; n < NUM; n++) if (this.api.model.roles[n] === R_PWM) this.schedule(n);
  }

  async sendNow(n: number): Promise<void> {
    const { model, link, note } = this.api;
    const p = model.pwm[n];
    if (!p || link.state !== "ready") return;
    let err: string | null = null;
    try {
      const r = await link.sendCmd("pwm.cfg", {
        pin: n,
        freq: p.freq,
        duty: p.duty / 100,
        backend: p.backend,
      });
      if (r.ok) {
        model.applyState(r.data, true);
        this.markHardwareFreq(n, r.data);
      } else {
        err = String(r.error);
        note(tf("gpio_cmd_fail", err));
      }
    } catch (e: any) {
      err = e.message;
      note(tf("gpio_apply_fail", e.message));
    }
    this.setError(n, err);
  }

  registerFreqEl(n: number, box: HTMLInputElement, show: () => void): void {
    this.freqEls.set(n, box);
    this.showFns.set(n, show);
    this.paintFreq(n);
  }

  repaintValue(n: number): void {
    this.showFns.get(n)?.();
  }

  registerErrEl(n: number, node: HTMLElement): void {
    this.errEls.set(n, node);
    this.paintErr(n);
  }

  private setError(n: number, msg: string | null): void {
    if (msg === null) this.errs.delete(n);
    else this.errs.set(n, msg);
    this.paintErr(n);
  }

  private paintErr(n: number): void {
    const e = this.errEls.get(n);
    if (!e) return;
    const msg = this.errs.get(n);
    e.textContent = msg || "";
    e.classList.toggle("on", !!msg);
    e.title = msg || "";
  }

  // The frequency one generator echoed is not evidence about the other, so a
  // switch drops it and the next reply re-earns the marking.
  dropHardwareFreq(n: number): void {
    this.hwFreq.delete(n);
    this.paintFreq(n);
  }

  paintFreq(n: number): void {
    const box = this.freqEls.get(n);
    const p = this.api.model.pwm[n];
    const hw = this.hwFreq.get(n);
    if (!box || !p || hw === undefined) return;
    const off = Math.abs(hw - p.freq) / p.freq > 0.005;
    box.classList.toggle("hwdev", off);
    box.title = off ? tf("pwm_hw_hz", pinLabel(n), fmtHz(p.freq), fmtHz(hw)) : "";
  }

  // Anything the divider misses by more than half a percent marks the box; a
  // wide miss (1 Hz -> 9 Hz) also writes a log line, so it survives the tooltip.
  private markHardwareFreq(n: number, state: any): void {
    const p = this.api.model.pwm[n];
    const hw = Number(state?.pwm?.[String(n)]?.hfreq);
    if (!p || !Number.isFinite(hw) || hw <= 0) return;
    this.hwFreq.set(n, hw);
    this.paintFreq(n);
    if (Math.abs(hw - p.freq) / p.freq > 0.05)
      this.api.note(tf("pwm_hw_hz", pinLabel(n), fmtHz(p.freq), fmtHz(hw)));
  }

  stop(n: number): void {
    const { model, link, note } = this.api;
    model.pwm[n] = null;
    const timer = this.timers.get(n);
    if (timer) clearTimeout(timer);
    this.timers.delete(n);
    this.hwFreq.delete(n);
    this.freqEls.delete(n);
    this.showFns.delete(n);
    this.errs.delete(n);
    this.errEls.delete(n);
    if (link.state === "ready") {
      link
        .sendCmd("pwm.stop", { pin: n })
        .catch((e: any) => note(tf("gpio_apply_fail", e.message)));
    }
  }
}

function selOpt(value: string, label: string): HTMLOptionElement {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  return o;
}

// Only one preset grid may float at a time; chip click handlers call
// stopPropagation, so this closes via the capture phase, before any bubble
// handler can swallow the click.
let openFreqWrap: HTMLElement | null = null;
document.addEventListener(
  "click",
  (e) => {
    if (openFreqWrap && !openFreqWrap.contains(e.target as Node)) {
      openFreqWrap.classList.remove("open");
      openFreqWrap = null;
    }
  },
  true
);

function makeFreqCtl(drv: PwmDriver, api: FuncApi, n: number, p: PwmParam): HTMLElement[] {
  const model = api.model;
  const wrap = el("pwm-freq", "span");
  const mant = el("pwm-in", "input") as HTMLInputElement;
  const caret = el("pwm-caret", "button") as HTMLButtonElement;
  const panel = el("pwm-presets", "div");
  const unit = el("pwm-sel", "select") as HTMLSelectElement;
  for (const u of UNITS) unit.appendChild(selOpt(String(u.exp), u.label));
  mant.type = "number";
  mant.step = "0.01";
  caret.textContent = "▾";
  // AUTO sentinel = "follow the frequency"; any real exponent (-3..6) is an explicit pick.
  const exp = () => (model.pwmUnit[n] === PWM_UNIT_AUTO ? autoExp(p.freq) : model.pwmUnit[n]);
  const show = () => {
    mant.value = String(p.freq / 10 ** exp());
    unit.value = String(exp());
    drv.paintFreq(n);
  };
  drv.registerFreqEl(n, mant, show);
  show();
  const close = () => {
    wrap.classList.remove("open");
    if (openFreqWrap === wrap) openFreqWrap = null;
  };
  // The generator's own window, read from the caps tables every time: a channel that
  // switches backend is re-clamped by the same rule that guards typing into it.
  const setFreq = (hz: number) => {
    const [lo, hi] = model.pwmWindow(p.backend);
    p.freq = clampWin(hz, lo, hi);
  };
  for (const v of PRESETS) {
    const b = el("pwm-preset", "button") as HTMLButtonElement;
    b.textContent = String(v);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      mant.value = String(v);
      apply();
      close();
    });
    panel.appendChild(b);
  }
  caret.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (wrap.classList.contains("open")) close();
    else {
      if (openFreqWrap) openFreqWrap.classList.remove("open");
      openFreqWrap = wrap;
      wrap.classList.add("open");
    }
  });
  for (const e of [mant, unit]) e.addEventListener("click", (ev) => ev.stopPropagation());
  unit.addEventListener("change", () => {
    const m = parseFloat(mant.value) || p.freq / 10 ** exp();
    model.pwmUnit[n] = Number(unit.value); // 0 (Hz) is a real choice, not "unset"
    setFreq(m * 10 ** model.pwmUnit[n]);
    show();
    model.changed();
    api.schedulePwm(n);
  });
  function apply() {
    setFreq((+mant.value || 0) * 10 ** exp());
    show();
    model.changed();
    api.schedulePwm(n);
  }
  mant.addEventListener("change", apply);
  wrap.append(mant, caret, panel);
  return [wrap, unit];
}

// The generator pick. It only exists when the firmware reported a PIO table AND a
// matrix on this pin (caps.pwm_pio.pins), so an older board keeps the single-mode
// card instead of offering a mode that would be refused.
function makeBackendCtl(drv: PwmDriver, api: FuncApi, n: number, p: PwmParam): HTMLElement | null {
  const model = api.model;
  const caps = model.pwmPio;
  if (!caps || !model.hasCap(n, C_PWM_PIO)) return null;
  const wrap = el("pwm-be", "span");
  const btns = BACKENDS.map((be) => {
    const [lo, hi] = model.pwmWindow(be);
    const b = el("pwm-be-btn", "button") as HTMLButtonElement;
    b.textContent = be === "hw" ? "HW" : "PIO";
    b.title =
      be === "hw"
        ? tf("pwm_be_hw", fmtHz(lo), fmtHz(hi))
        : tf("pwm_be_pio", fmtHz(lo), fmtHz(hi), String(caps.max_sm));
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // "Already on that generator" is the board's call, not the config's. A channel the
      // firmware refused runs on neither generator, so its button has to resend once the
      // reason for the refusal is gone -- free a state machine and press PIO again.
      if (p.backend === be && model.devPwmBackend(n, be)) return;
      p.backend = be;
      p.freq = clampWin(p.freq, ...model.pwmWindow(be));
      drv.dropHardwareFreq(n);
      drv.repaintValue(n);
      paint();
      model.changed();
      api.schedulePwm(n);
    });
    return [be, b] as const;
  });
  function paint() {
    for (const [be, b] of btns) b.classList.toggle("on", p.backend === be);
  }
  paint();
  for (const [, b] of btns) wrap.appendChild(b);
  return wrap;
}

function makeErrEl(drv: PwmDriver, n: number): HTMLElement {
  const e = el("pwm-err", "span");
  drv.registerErrEl(n, e);
  return e;
}

function dutyIn(api: FuncApi, n: number, p: PwmParam): HTMLElement {
  // pwm-duty, not just pwm-in: the duty box holds 0..100 while the frequency box has to
  // show what the generator really produces (0.0174553), so the two cannot share a width.
  const i = el("pwm-in pwm-duty", "input") as HTMLInputElement;
  i.type = "number";
  i.min = "0"; i.max = "100"; i.step = "1"; i.value = String(p.duty);
  i.title = "%";
  i.addEventListener("change", () => {
    p.duty = clamp(+i.value || 0, 0, 100);
    api.model.changed();
    api.schedulePwm(n);
  });
  i.addEventListener("click", (e) => e.stopPropagation());
  return i;
}

export function makePwmDef(drv: PwmDriver): FunctionDef {
  return {
    role: R_PWM,
    labelKey: "lane_pwm",
    cls: "l-pwm",
    icon: ICON[R_PWM],
    accept: (api, n) => api.model.hasCap(n, C_PWM),
    assign: (api, n) => {
      if (!api.model.pwm[n]) api.model.pwm[n] = { freq: 1000, duty: 50, backend: "hw" };
      drv.schedule(n);
    },
    release: (api, n) => drv.stop(n),
    activate: () => drv.scheduleAll(),
    chip: (api, n) => {
      const p = api.model.pwm[n]!;
      const u = (s: string) => {
        const e = el("unit", "span");
        e.textContent = s;
        return e;
      };
      const be = makeBackendCtl(drv, api, n, p);
      // The three number controls travel as one group: the lane is narrower than the
      // whole row of parts, and when the chip has to break, a frequency box separated
      // from its unit and duty boxes reads as three unrelated fields.
      const edit = el("pwm-edit", "span");
      edit.append(...makeFreqCtl(drv, api, n, p), dutyIn(api, n, p), u("%"));
      const els: HTMLElement[] = [];
      if (be) els.push(be);
      els.push(edit, makeErrEl(drv, n));
      return { els };
    },
  };
}
