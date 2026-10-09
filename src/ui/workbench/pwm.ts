// PWM function lane: per-pin freq/duty editors. One number box + a caret
// that opens the full 1..1000 preset grid (a datalist was tried and rejected:
// browsers filter suggestions by the current value, so typing 50 only shows
// 50/500) × one unit pick (mHz/Hz/kHz/MHz). Sub-1 Hz values are entered
// freely; the device answers honestly (rp2 PWMOut only takes whole hertz,
// floor ~7.4 Hz). rp2 slices share frequency, so batching across pins would
// be wrong anyway — each pin has its own debounce timer; release stops the
// output immediately.
import { tf } from "../i18n";
import { NUM, R_PWM, PWM_UNIT_AUTO, type PwmParam } from "../model/pins";
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
const FREQ_MAX = 3e7; // rp2 PWM tops out here (duty resolution shrinks fast)

const autoExp = (hz: number) => (hz >= 1e6 ? 6 : hz >= 1e3 ? 3 : hz >= 1 ? 0 : -3);

// mantissa × 10^exp lands on float noise (0.07 kHz → 70.00000000000001 Hz);
// six-decimal rounding keeps the box and the wire value clean.
const norm = (hz: number) => Math.round(hz * 1e6) / 1e6;

export class PwmDriver {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

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
    try {
      const r = await link.sendCmd("pwm.cfg", { pin: n, freq: p.freq, duty: p.duty / 100 });
      if (r.ok) model.applyState(r.data, true);
      else note(tf("gpio_cmd_fail", String(r.error)));
    } catch (e: any) {
      note(tf("gpio_apply_fail", e.message));
    }
  }

  stop(n: number): void {
    const { model, link, note } = this.api;
    model.pwm[n] = null;
    const timer = this.timers.get(n);
    if (timer) clearTimeout(timer);
    this.timers.delete(n);
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

function makeFreqCtl(api: FuncApi, n: number, p: PwmParam): HTMLElement[] {
  const model = api.model;
  const wrap = el("pwm-freq", "span");
  const mant = el("pwm-in", "input") as HTMLInputElement;
  const caret = el("pwm-caret", "button") as HTMLButtonElement;
  const panel = el("pwm-presets", "div");
  const unit = el("pwm-sel", "select") as HTMLSelectElement;
  for (const u of UNITS) unit.appendChild(selOpt(String(u.exp), u.label));
  mant.type = "number";
  mant.min = "0.01";
  mant.step = "0.01";
  caret.textContent = "▾";
  // AUTO sentinel = "follow the frequency"; any real exponent (-3..6) is an explicit pick.
  const exp = () => (model.pwmUnit[n] === PWM_UNIT_AUTO ? autoExp(p.freq) : model.pwmUnit[n]);
  const show = () => {
    mant.value = String(p.freq / 10 ** exp());
    unit.value = String(exp());
  };
  show();
  const close = () => {
    wrap.classList.remove("open");
    if (openFreqWrap === wrap) openFreqWrap = null;
  };
  const apply = () => {
    p.freq = norm(clamp((+mant.value || 0) * 10 ** exp(), 0.001, FREQ_MAX));
    show();
    model.changed();
    api.schedulePwm(n);
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
    p.freq = norm(clamp(m * 10 ** model.pwmUnit[n], 0.001, FREQ_MAX));
    show();
    model.changed();
    api.schedulePwm(n);
  });
  mant.addEventListener("change", apply);
  wrap.append(mant, caret, panel);
  return [wrap, unit];
}

function dutyIn(api: FuncApi, n: number, p: PwmParam): HTMLElement {
  const i = el("pwm-in", "input") as HTMLInputElement;
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
    accept: (api, n) => api.model.pwmCap(n),
    assign: (api, n) => {
      if (!api.model.pwm[n]) api.model.pwm[n] = { freq: 1000, duty: 50 };
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
      return { els: [...makeFreqCtl(api, n, p), dutyIn(api, n, p), u("%")] };
    },
  };
}
