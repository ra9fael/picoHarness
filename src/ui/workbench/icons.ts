import { R_IN, R_OUT, R_PWM } from "../model/pins";

const svg = (p: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square">${p}</svg>`;

export const ICON: Record<number, string> = {
  [R_IN]: svg('<path d="M2 12h9"/><path d="M8 8l4 4-4 4"/><rect x="14" y="5" width="8" height="14"/>'),
  [R_OUT]: svg('<rect x="2" y="5" width="8" height="14"/><path d="M13 12h9"/><path d="M18 8l4 4-4 4"/>'),
  [R_PWM]: svg('<polyline points="2,17 6,17 6,7 11,7 11,17 16,17 16,7 22,7"/>'),
};
