// ADC waveform scope: a collapsible panel below the workbench. Channel
// buttons list the pins bound to the ADC lane (max 4 traces); "run" turns on
// the firmware adc.stream batch feed ({"evt":"adc_w"} frames, ~0.6 s each),
// which also silences the chatty per-change adc_monitor. Samples land in
// 2048-deep ring buffers and the canvas redraws once per animation frame,
// only when data arrived — the wire rate can therefore never turn into a
// render storm. Selection + open state persist in localStorage.
import { t, tf } from "../i18n";
import { NUM, R_ADC, type PinModel } from "../model/pins";
import type { JsonMsg, SerialLink } from "../serial";
import { el } from "./dom";

const CAP = 2048; // ring depth per channel
const MAX_CH = 4;
const STREAM_MS = 25; // device sample interval
const STREAM_BATCH = 25; // samples per adc_w frame
const KEY = "picoharness-scope-v1";
const PALETTE = ["#c8a2d0", "#4fd0c0", "#e5c07b", "#7fb2d4"];

type Ring = { buf: Uint16Array; head: number; count: number };

export class Scope {
  private labelEl: HTMLElement;
  private chansEl: HTMLElement;
  private btnRun: HTMLButtonElement;
  private btnCollapse: HTMLButtonElement;
  private body: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private rings = new Map<number, Ring>();
  private ch: number[] = [];
  private open = true;
  private running = false;
  private dirty = false;
  private raf = 0;

  constructor(
    private link: SerialLink,
    private model: PinModel,
    private note: (msg: string) => void,
    mount: HTMLElement,
  ) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (s && typeof s === "object") {
        this.open = s.open !== false;
        if (Array.isArray(s.ch))
          this.ch = s.ch
            .filter((n: number) => Number.isInteger(n) && n >= 0 && n < NUM)
            .slice(0, MAX_CH);
      }
    } catch {}

    const bar = el("scope-bar");
    this.labelEl = el("label");
    this.chansEl = el("scope-chans");
    this.btnRun = el("scope-run", "button") as HTMLButtonElement;
    this.btnCollapse = el("scope-collapse", "button") as HTMLButtonElement;
    bar.append(this.labelEl, this.chansEl, el("spacer"), this.btnRun, this.btnCollapse);

    this.body = el("scope-body");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "scope-canvas";
    this.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    mount.append(bar, this.body);

    this.btnRun.addEventListener("click", () => void this.toggleRun());
    this.btnCollapse.addEventListener("click", () => {
      this.open = !this.open;
      this.applyCollapse();
      this.save();
      if (this.open) this.invalidate();
    });
    this.model.on("config", () => this.refreshChans());
    new ResizeObserver(() => this.invalidate()).observe(this.body);
    this.refreshChans();
    this.applyCollapse();
  }

  setActive(a: boolean): void {
    this.btnRun.disabled = !a;
    if (!a && this.running) this.running = false; // device stream dies with the next soft reset anyway
    this.updateRunLabel();
  }

  refreshLang(): void {
    this.labelEl.textContent = t("scope_label");
    this.updateRunLabel();
    this.applyCollapse();
  }

  // —— channel selection ——
  private refreshChans(): void {
    this.ch = this.ch.filter((n) => this.model.roles[n] === R_ADC).slice(0, MAX_CH);
    this.chansEl.innerHTML = "";
    for (let n = 0; n < NUM; n++) {
      if (this.model.roles[n] !== R_ADC) continue;
      const i = this.ch.indexOf(n);
      const b = el("scope-chan c" + Math.max(0, i), "button") as HTMLButtonElement;
      b.textContent = "GP" + n;
      if (i >= 0) b.classList.add("on");
      b.addEventListener("click", () => {
        if (i >= 0) this.ch.splice(i, 1);
        else if (this.ch.length >= MAX_CH) {
          this.note(tf("scope_max", MAX_CH));
          return;
        } else this.ch.push(n);
        this.save();
        this.refreshChans();
        if (this.running) void this.startStream(); // retarget the live feed
      });
      this.chansEl.appendChild(b);
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ open: this.open, ch: this.ch }));
    } catch {}
  }

  // —— stream control ——
  private updateRunLabel(): void {
    this.btnRun.textContent = this.running ? t("scope_stop") : t("scope_run");
  }

  private async toggleRun(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.updateRunLabel();
      try {
        await this.link.sendCmd("adc.stream", { on: 0 });
      } catch {}
      return;
    }
    await this.startStream();
  }

  private async startStream(): Promise<void> {
    const pins = this.ch.filter((n) => this.model.roles[n] === R_ADC);
    if (!pins.length) {
      this.note(t("scope_no_ch"));
      return;
    }
    try {
      const r = await this.link.sendCmd("adc.stream", {
        on: 1,
        pins,
        ms: STREAM_MS,
        batch: STREAM_BATCH,
      });
      if (r.ok) {
        this.running = true;
      } else {
        this.running = false;
        this.note(tf("gpio_cmd_fail", String(r.error)));
      }
    } catch (e: any) {
      this.note(tf("gpio_apply_fail", e.message));
    }
    this.updateRunLabel();
  }

  // —— data ingest ——
  onMsg(m: JsonMsg): void {
    if (m.evt !== "adc_w" || !Array.isArray(m.pins) || !Array.isArray(m.v)) return;
    const pins = m.pins as number[];
    for (const p of pins)
      if (!this.rings.has(p)) this.rings.set(p, { buf: new Uint16Array(CAP), head: 0, count: 0 });
    for (const row of m.v as number[][]) {
      for (let i = 0; i < pins.length; i++) {
        const r = this.rings.get(pins[i]);
        if (!r || typeof row[i] !== "number") continue;
        r.buf[r.head] = row[i] & 0xffff;
        r.head = (r.head + 1) % CAP;
        if (r.count < CAP) r.count++;
      }
    }
    this.invalidate();
  }

  // —— rendering (one pass per frame, only when data landed) ——
  private invalidate(): void {
    this.dirty = true;
    if (!this.raf)
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.draw();
      });
  }

  private applyCollapse(): void {
    this.body.classList.toggle("hide", !this.open);
    this.btnCollapse.textContent = this.open ? t("btn_collapse") : t("btn_expand");
  }

  private draw(): void {
    if (!this.open || !this.dirty) return;
    this.dirty = false;
    const w = this.body.clientWidth,
      h = this.body.clientHeight;
    if (w < 40 || h < 40) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0b0e11";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#232c35";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= 8; i++) {
      const y = Math.round(((h - 1) * i) / 8) + 0.5;
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
    for (let x = 60; x < w; x += 60) {
      g.moveTo(Math.round(x) + 0.5, 0);
      g.lineTo(Math.round(x) + 0.5, h);
    }
    g.stroke();
    g.font = "10px Consolas, monospace";
    g.fillStyle = "#7a8896";
    for (let i = 0; i <= 4; i++) {
      const v = ((3.3 * (4 - i)) / 4).toFixed(2);
      g.fillText(v, 4, 2 + ((h - 1) * i) / 4);
    }
    this.ch.forEach((pin, ci) => {
      const r = this.rings.get(pin);
      if (!r || r.count < 2) return;
      const stride = Math.max(1, Math.floor(r.count / w));
      g.strokeStyle = PALETTE[ci % PALETTE.length];
      g.lineWidth = 1;
      g.beginPath();
      const first = (r.head - r.count + CAP * 2) % CAP;
      for (let k = 0; k < r.count; k += stride) {
        const val = r.buf[(first + k) % CAP];
        const x = (k / (r.count - 1)) * w;
        const y = h - 2 - (val / 65535) * (h - 4);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    });
  }
}
