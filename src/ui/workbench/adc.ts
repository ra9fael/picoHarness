// ADC read lane: assigning a pin sends adc.cfg (firmware AnalogIn claim), the
// adc_monitor task then pushes {"evt":"adc","vals":{...}} batches on deadband
// changes — the chip itself never polls. The toggle button switches the chip
// between volts (3.3 V reference over the 16-bit span) and the raw reading.
import { tf } from "../i18n";
import { NUM, R_ADC, type PinModel } from "../model/pins";
import { el } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

export const adcText = (model: PinModel, n: number): string => {
  const raw = model.devAdc[n];
  if (raw === undefined) return "—";
  return model.adcFmt[n]
    ? String(raw)
    : ((raw * 3.3) / 65535).toFixed(2) + " V";
};

export class AdcDriver {
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
    for (let n = 0; n < NUM; n++) if (this.api.model.roles[n] === R_ADC) this.schedule(n);
  }

  async sendNow(n: number): Promise<void> {
    const { link, note } = this.api;
    if (link.state !== "ready") return;
    try {
      const r = await link.sendCmd("adc.cfg", { pin: n });
      if (!r.ok) note(tf("gpio_cmd_fail", String(r.error)));
    } catch (e: any) {
      note(tf("gpio_apply_fail", e.message));
    }
  }

  stop(n: number): void {
    const { model, link, note } = this.api;
    const timer = this.timers.get(n);
    if (timer) clearTimeout(timer);
    this.timers.delete(n);
    delete model.devAdc[n];
    if (link.state === "ready") {
      link
        .sendCmd("adc.stop", { pin: n })
        .catch((e: any) => note(tf("gpio_apply_fail", e.message)));
    }
  }
}

export function makeAdcDef(drv: AdcDriver): FunctionDef {
  return {
    role: R_ADC,
    labelKey: "lane_adc",
    cls: "l-adc",
    icon: ICON[R_ADC],
    accept: (api, n) => api.model.adcCap(n),
    assign: (api, n) => drv.schedule(n),
    release: (api, n) => drv.stop(n),
    activate: () => drv.scheduleAll(),
    chip: (api, n) => {
      const { model } = api;
      const val = el("adc-val", "span");
      val.textContent = adcText(model, n);
      const tg = el("mini", "button") as HTMLButtonElement;
      const show = () => {
        tg.textContent = model.adcFmt[n] ? "raw" : "V";
        val.textContent = adcText(model, n);
      };
      show();
      tg.addEventListener("click", (e) => {
        e.stopPropagation();
        model.adcFmt[n] = model.adcFmt[n] ? 0 : 1;
        model.changed();
        show();
      });
      return { els: [val, tg], adcEl: val };
    },
  };
}
