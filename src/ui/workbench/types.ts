// Plugin contract for workbench functions. Adding e.g. I2C later means one
// new module exporting a FunctionDef (plus its driver) and one line in the
// workbench registry — lanes, drag/drop rules, chips and apply scheduling
// all come from the definition.
import type { SerialLink } from "../serial";
import type { PinModel } from "../model/pins";
import type { MsgKey } from "../i18n";

export interface FuncApi {
  model: PinModel;
  link: SerialLink;
  note(msg: string): void; // user-visible failure note (console line)
  rerender(): void;
  scheduleGpio(): void; // debounced gpio.cfg push
  sendGpioNow(): Promise<void>;
  flipOut(n: number): void;
  schedulePwm(n: number): void; // debounced per-pin pwm.cfg push
  stopPwm(n: number): void;
  scheduleAdc(n: number): void; // debounced per-pin adc.cfg claim
  stopAdc(n: number): void;
  releasePin(n: number): void; // stop whatever function (gpio/pwm/adc) owns this pin now
}

export interface ChipView {
  els: HTMLElement[]; // interactive extras appended into the chip
  levelEl?: HTMLElement; // element whose "hi" class tracks the pin level
  adcEl?: HTMLElement; // element whose text tracks the pin's ADC reading
}

export interface FunctionDef {
  role: number; // value stored in PinModel.roles
  labelKey: MsgKey;
  cls: string; // lane CSS class
  icon: string; // lane-head SVG
  accept(api: FuncApi, pin: number): boolean; // drag/click eligibility
  assign(api: FuncApi, pin: number): void;
  release(api: FuncApi, pin: number): void;
  activate(api: FuncApi): void; // link became ready: push my config
  chip(api: FuncApi, pin: number): ChipView;
  // Multi-pin functions (I2C/SPI buses) own their lane zone: when present, the
  // engine does not place per-pin chips here and does not accept generic drops
  // — the def renders bus cards with their own labeled pin slots instead.
  renderLane?(api: FuncApi, zoneEl: HTMLElement): void;
  // Pointer-only path for those card slots: the user clicked an empty slot (it is
  // now PinModel.slotSel and the pool lit the pins it may take), then clicked a
  // chip. Returns false when this lane no longer owns a focusable slot, so the
  // engine falls back to the ordinary pin pick.
  bindSlot?(pin: number): boolean;
}
