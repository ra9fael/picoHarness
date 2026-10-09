// PWM function lane: per-pin freq/duty editors. Each pin has its own
// debounce timer (rp2 slices share frequency, so batching across pins would
// be wrong anyway); release stops the output immediately.
import { tf } from "../i18n";
import { NUM, R_PWM, type PwmParam } from "../model/pins";
import { el, clamp } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

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

function numIn(
  api: FuncApi,
  n: number,
  p: PwmParam,
  which: "freq" | "duty",
): HTMLElement {
  const i = el("pwm-in", "input") as HTMLInputElement;
  i.type = "number";
  if (which === "freq") {
    i.min = "1"; i.max = "200000"; i.step = "1"; i.value = String(p.freq);
    i.title = "Hz";
  } else {
    i.min = "0"; i.max = "100"; i.step = "1"; i.value = String(p.duty);
    i.title = "%";
  }
  i.addEventListener("change", () => {
    if (which === "freq") p.freq = clamp(Math.round(+i.value || 1), 1, 200000);
    else p.duty = clamp(+i.value || 0, 0, 100);
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
      return { els: [numIn(api, n, p, "freq"), u("Hz"), numIn(api, n, p, "duty"), u("%")] };
    },
  };
}
