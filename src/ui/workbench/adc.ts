// ADC read lane: assigning a pin sends adc.cfg (firmware AnalogIn claim), the
// adc_monitor task then pushes {"evt":"adc","vals":{...}} batches on deadband
// changes — the chip itself never polls. The toggle button switches the chip
// between volts (3.3 V reference over the 16-bit span) and the raw reading.
import { tf } from "../i18n";
import { SLOTS, R_ADC, TEMP, toWire, type PinModel } from "../model/pins";
import { el } from "./dom";
import { ICON } from "./icons";
import type { FuncApi, FunctionDef } from "./types";

export const ADC_UNITS = ["V", "mV", "raw"] as const;

// The firmware ships the temperature channel as the raw 16-bit ADC code it
// synthesized from microcontroller.cpu.temperature, so the chip converts back
// to °C with the datasheet curve (V = raw*3.3/65535; °C = 27 - (V-0.706)/0.001721).
const tempC = (raw: number): number => 27 - ((raw * 3.3) / 65535 - 0.706) / 0.001721;

export const adcText = (model: PinModel, n: number): string => {
  const v = model.adcVal(n);
  if (v === undefined) return "—";
  if (n === TEMP) return model.adcFmt[n] % 3 === 2 ? String(Math.round(v)) : tempC(v).toFixed(1) + " °C";
  switch (model.adcFmt[n] % 3) {
    case 1:
      return Math.round((v * 3300) / 65535) + " mV";
    case 2:
      return String(Math.round(v));
    default:
      return ((v * 3.3) / 65535).toFixed(2) + " V";
  }
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
    for (let n = 0; n < SLOTS; n++) if (this.api.model.roles[n] === R_ADC) this.schedule(n);
  }

  async sendNow(n: number): Promise<void> {
    const { link, note } = this.api;
    if (link.state !== "ready") return;
    const w = toWire(n);
    try {
      const r = await link.sendCmd("adc.cfg", { pin: w });
      if (!r.ok) {
        note(tf("gpio_cmd_fail", String(r.error)));
        return;
      }
      // Subscribe for the retained snapshot + change events on this channel.
      // The temperature sensor needs a finer deadband than the ~0.5%-of-span
      // default: 18 LSB ≈ 0.5 °C, otherwise a slowly drifting chip never moves
      // enough to re-push and the readout looks frozen.
      const params = n === TEMP ? { deadband: 18 } : {};
      await link.sendCmd("sub", { topic: "adc." + w, params });
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
    model.resetAdc(n);
    if (link.state === "ready") {
      const w = toWire(n);
      link.sendCmd("unsub", { topic: "adc." + w }).catch(() => {});
      link
        .sendCmd("adc.stop", { pin: w })
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
      const unitLabel = () =>
        n === TEMP
          ? model.adcFmt[n] % 3 === 2
            ? "raw"
            : "°C"
          : ADC_UNITS[model.adcFmt[n] % 3];
      const show = () => {
        tg.textContent = unitLabel();
        val.textContent = adcText(model, n);
      };
      show();
      tg.addEventListener("click", (e) => {
        e.stopPropagation();
        model.adcFmt[n] =
          n === TEMP ? (model.adcFmt[n] % 3 === 2 ? 0 : 2) : (model.adcFmt[n] + 1) % 3;
        model.changed();
        show();
      });
      return { els: [val, tg], adcEl: val };
    },
  };
}
