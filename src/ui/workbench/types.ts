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
}

export interface ChipView {
  els: HTMLElement[]; // interactive extras appended into the chip
  levelEl?: HTMLElement; // element whose "hi" class tracks the pin level
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
}
