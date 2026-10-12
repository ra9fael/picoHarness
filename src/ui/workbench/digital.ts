// Digital GPIO function: input lane (pull cycling) + output lane (LED
// toggle). One shared driver debounces gpio.cfg pushes so rapid assignments
// collapse into a single command.
import { t, tf } from "../i18n";
import { R_IN, R_OUT, isBit } from "../model/pins";
import { el } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

const PULL_KEYS = ["pull_up", "pull_down", "pull_none"] as const;

export class DigitalDriver {
  busy = false;
  private cfgTimer: ReturnType<typeof setTimeout> | 0 = 0;

  constructor(private api: FuncApi) {}

  get scheduling(): boolean {
    return this.cfgTimer !== 0;
  }

  schedule(): void {
    if (!this.cfgTimer) {
      this.cfgTimer = setTimeout(() => {
        this.cfgTimer = 0;
        void this.sendNow();
      }, 120);
    }
  }

  async sendNow(): Promise<void> {
    if (this.busy) return;
    const { model, link, note } = this.api;
    if (link.state !== "ready") return;
    this.busy = true;
    try {
      const masks = model.cfgMasks();
      const r = await link.sendCmd("gpio.cfg", masks);
      if (r.ok) {
        model.applyState(r.data, true);
        await this.subInputs(masks.in);
      } else note(tf("gpio_cmd_fail", String(r.error)));
    } catch (e: any) {
      note(tf("gpio_apply_fail", e.message));
    } finally {
      this.busy = false;
    }
  }

  // Keep the firmware's gpio.in subscription aligned with the current input
  // set: edges only flow for pins we actually watch, and re-subscribing pulls a
  // retained snapshot so levels refresh without waiting for the next change.
  private async subInputs(mask: number): Promise<void> {
    const { link } = this.api;
    try {
      if (mask) await link.sendCmd("sub", { topic: "gpio.in", params: { mask } });
      else await link.sendCmd("unsub", { topic: "gpio.in" });
    } catch {}
  }

  async flipOut(n: number): Promise<void> {
    const { model, link, note } = this.api;
    if (link.state !== "ready") return;
    const val = isBit(model.devOut, n) ? 0 : 1;
    model.setOutBit(n, val); // optimistic: instant feedback
    try {
      // 2**n rather than 1<<n: GP32..GP47 masks are past JavaScript's 32-bit shift,
      // which would wrap to a different pin entirely.
      const bit = 2 ** n;
      const r = await link.sendCmd("gpio.out", { mask: bit, vals: val * bit });
      if (r.ok) model.applyState(r.data, true);
      else {
        model.setOutBit(n, val ^ 1);
        note(tf("gpio_cmd_fail", String(r.error)));
      }
    } catch (e: any) {
      model.setOutBit(n, val ^ 1);
      note(tf("gpio_apply_fail", e.message));
    }
  }
}

export function makeDigitalDefs(drv: DigitalDriver): FunctionDef[] {
  const inDef: FunctionDef = {
    role: R_IN,
    labelKey: "lane_in",
    cls: "l-in",
    icon: ICON[R_IN],
    accept: () => true,
    assign: (api) => api.scheduleGpio(),
    release: (api) => api.scheduleGpio(),
    activate: () => {},
    chip: (api, n) => {
      const { model } = api;
      const lvl = el("lvl" + (model.level(n) ? " hi" : ""), "span");
      const b = el("mini", "button") as HTMLButtonElement;
      b.textContent = t(PULL_KEYS[model.pulls[n]]);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        model.pulls[n] = (model.pulls[n] + 1) % 3;
        b.textContent = t(PULL_KEYS[model.pulls[n]]);
        model.changed();
        api.scheduleGpio();
      });
      return { els: [lvl, b], levelEl: lvl };
    },
  };

  const outDef: FunctionDef = {
    role: R_OUT,
    labelKey: "lane_out",
    cls: "l-out",
    icon: ICON[R_OUT],
    accept: () => true,
    assign: (api) => api.scheduleGpio(),
    release: (api) => api.scheduleGpio(),
    activate: () => {},
    chip: (api, n) => {
      const b = el("led" + (api.model.level(n) ? " hi" : ""), "button") as HTMLButtonElement;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        void drv.flipOut(n);
      });
      return { els: [b], levelEl: b };
    },
  };

  return [inDef, outDef];
}
