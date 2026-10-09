export const el = (cls: string, tag = "div"): HTMLElement => {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
};

export const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
