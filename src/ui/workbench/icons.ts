import { R_IN, R_OUT, R_PWM, R_ADC, R_I2C, R_UART } from "../model/pins";

const svg = (p: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="square">${p}</svg>`;

export const ICON: Record<number, string> = {
  [R_IN]: svg('<path d="M2 12h9"/><path d="M8 8l4 4-4 4"/><rect x="14" y="5" width="8" height="14"/>'),
  [R_OUT]: svg('<rect x="2" y="5" width="8" height="14"/><path d="M13 12h9"/><path d="M18 8l4 4-4 4"/>'),
  [R_PWM]: svg('<polyline points="2,17 6,17 6,7 11,7 11,17 16,17 16,7 22,7"/>'),
  [R_ADC]: svg('<path d="M2 18a10 10 0 0 1 20 0"/><path d="M12 18l5-7"/><path d="M2 18h2M20 18h2"/>'),
  [R_I2C]: svg('<path d="M4 8h16M4 16h16"/><circle cx="8" cy="8" r="2"/><circle cx="16" cy="16" r="2"/>'),
  [R_UART]: svg('<path d="M2 8h16"/><path d="M14 5l4 3-4 3"/><path d="M22 16h-16"/><path d="M10 13l-4 3 4 3"/>'),
};
