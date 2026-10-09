// ADC waveform scope: a collapsible panel below the workbench. Channel
// buttons list the pins bound to the ADC lane (max 4 traces); "run" turns on
// the firmware adc.stream batch feed, which also silences the chatty
// per-change adc_monitor. Frames arrive either as JSON ({"evt":"adc_w"}) or as
// compact binary struct frames (0xAA 'W' header, kind=1) depending on the
// toolbar format choice — both land in the same 2048-deep ring buffers.
//
// The canvas redraws once per animation frame, only when data arrived, so the
// wire rate can never turn into a render storm. Interaction: wheel = horizontal
// zoom (right-anchored to "now", window 32..2048 samples), shift+wheel =
// vertical zoom, double-click = reset to fit. autoX/autoY toggle whether the
// view keeps fitting the data. Each channel carries a y = k·x + b calibration
// applied in the raw domain at draw time. Everything persists in localStorage.
import { t, tf } from "../i18n";
import { NUM, R_ADC, type PinModel } from "../model/pins";
import type { JsonMsg, SerialLink } from "../serial";
import { el, clamp } from "./dom";

const CAP = 2048; // ring depth per channel
const MAX_CH = 4;
const STREAM_MS = 25; // device sample interval
const STREAM_BATCH = 25; // samples per adc_w frame
const WIN_MIN = 32;
const KEY = "picoharness-scope-v1";
const PALETTE = ["#c8a2d0", "#4fd0c0", "#e5c07b", "#7fb2d4"];
const VREF = 3.3;
const FULL = 65535;

type Ring = { buf: Uint16Array; head: number; count: number };
type Cal = { k: number; b: number };

export class Scope {
  private labelEl: HTMLElement;
  private chansEl: HTMLElement;
  private btnRun: HTMLButtonElement;
  private btnCollapse: HTMLButtonElement;
  private infoEl: HTMLElement;
  private btnAutoX: HTMLButtonElement;
  private btnAutoY: HTMLButtonElement;
  private btnUnit: HTMLButtonElement;
  private fmtSel: HTMLSelectElement;
  private btnCal: HTMLButtonElement;
  private calPanel: HTMLElement;
  private body: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private rings = new Map<number, Ring>();
  private ch: number[] = [];
  private open = true;
  private running = false;
  private dirty = false;
  private raf = 0;

  // view state
  private fmt: "json" | "bin" = "json";
  private yUnit: "V" | "raw" = "V";
  private autoX = true;
  private autoY = true;
  private win = CAP; // visible sample count when autoX is off
  private yLo = 0; // raw-domain vertical window when autoY is off
  private yHi = FULL;
  private sampleMs = STREAM_MS;
  private cal: Record<number, Cal> = {};
  // auto-range results from the last draw, used to seed a manual zoom
  private fitLo = 0;
  private fitHi = FULL;

  // Newest per-pin reading from each ingested frame, handed to the workbench so
  // the ADC chip digits keep updating while the stream runs (adc_monitor is
  // silent during streaming). Set by main.ts.
  onLatest: (vals: Record<number, number>) => void = () => {};

  constructor(
    private link: SerialLink,
    private model: PinModel,
    private note: (msg: string) => void,
    mount: HTMLElement,
  ) {
    this.restore();

    const bar = el("scope-bar");
    this.labelEl = el("label");
    this.chansEl = el("scope-chans");
    this.btnRun = el("scope-run", "button") as HTMLButtonElement;
    this.btnCollapse = el("scope-collapse", "button") as HTMLButtonElement;
    bar.append(this.labelEl, this.chansEl, el("spacer"), this.btnRun, this.btnCollapse);

    const tools = el("scope-tools");
    this.infoEl = el("scope-info");
    this.btnAutoX = el("scope-tbtn", "button") as HTMLButtonElement;
    this.btnAutoY = el("scope-tbtn", "button") as HTMLButtonElement;
    this.btnUnit = el("scope-tbtn", "button") as HTMLButtonElement;
    this.fmtSel = document.createElement("select");
    this.fmtSel.className = "scope-fmt";
    this.btnCal = el("scope-tbtn", "button") as HTMLButtonElement;
    tools.append(
      this.infoEl,
      el("spacer"),
      this.btnAutoX,
      this.btnAutoY,
      this.btnUnit,
      this.fmtSel,
      this.btnCal,
    );

    this.calPanel = el("scope-cal");
    this.body = el("scope-body");
    this.canvas = document.createElement("canvas");
    this.canvas.className = "scope-canvas";
    this.body.append(this.canvas, this.calPanel);
    this.ctx = this.canvas.getContext("2d")!;

    mount.append(bar, tools, this.body);

    this.btnRun.addEventListener("click", () => void this.toggleRun());
    this.btnCollapse.addEventListener("click", () => {
      this.open = !this.open;
      this.applyCollapse();
      this.save();
      if (this.open) this.invalidate();
    });
    this.btnAutoX.addEventListener("click", () => {
      this.autoX = !this.autoX;
      this.syncTools();
      this.save();
      this.invalidate();
    });
    this.btnAutoY.addEventListener("click", () => {
      this.autoY = !this.autoY;
      if (!this.autoY) {
        this.yLo = this.fitLo;
        this.yHi = this.fitHi;
      }
      this.syncTools();
      this.save();
      this.invalidate();
    });
    this.btnUnit.addEventListener("click", () => {
      this.yUnit = this.yUnit === "V" ? "raw" : "V";
      this.syncTools();
      this.save();
      this.invalidate();
    });
    this.btnCal.addEventListener("click", () => {
      this.calPanel.classList.toggle("open");
      this.btnCal.classList.toggle("on", this.calPanel.classList.contains("open"));
      if (this.calPanel.classList.contains("open")) this.buildCal();
    });
    this.fmtSel.addEventListener("change", () => {
      this.fmt = this.fmtSel.value === "bin" ? "bin" : "json";
      this.save();
      if (this.running) void this.startStream(); // re-issue with the new fmt
    });
    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener("dblclick", () => {
      this.autoX = true;
      this.autoY = true;
      this.win = CAP;
      this.syncTools();
      this.save();
      this.invalidate();
    });

    this.model.on("config", () => this.refreshChans());
    new ResizeObserver(() => this.invalidate()).observe(this.body);
    this.buildFmt();
    this.refreshChans();
    this.syncTools();
    this.applyCollapse();
  }

  private restore(): void {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!s || typeof s !== "object") return;
      this.open = s.open !== false;
      if (Array.isArray(s.ch))
        this.ch = s.ch
          .filter((n: number) => Number.isInteger(n) && n >= 0 && n < NUM)
          .slice(0, MAX_CH);
      if (s.fmt === "bin") this.fmt = "bin";
      if (s.yUnit === "raw") this.yUnit = "raw";
      if (typeof s.autoX === "boolean") this.autoX = s.autoX;
      if (typeof s.autoY === "boolean") this.autoY = s.autoY;
      if (typeof s.win === "number") this.win = clamp(Math.round(s.win), WIN_MIN, CAP);
      if (typeof s.yLo === "number" && typeof s.yHi === "number" && s.yHi > s.yLo) {
        this.yLo = s.yLo;
        this.yHi = s.yHi;
      }
      if (s.cal && typeof s.cal === "object") {
        for (const k of Object.keys(s.cal)) {
          const c = s.cal[k];
          if (typeof c?.k === "number" && typeof c?.b === "number")
            this.cal[Number(k)] = { k: c.k, b: c.b };
        }
      }
    } catch {}
  }

  setActive(a: boolean): void {
    this.btnRun.disabled = !a;
    if (!a && this.running) this.running = false; // device stream dies with the next soft reset anyway
    this.updateRunLabel();
  }

  refreshLang(): void {
    this.labelEl.textContent = t("scope_label");
    this.buildFmt();
    this.updateRunLabel();
    this.syncTools();
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
        if (this.calPanel.classList.contains("open")) this.buildCal();
        if (this.running) void this.startStream(); // retarget the live feed
      });
      this.chansEl.appendChild(b);
    }
  }

  private save(): void {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          open: this.open,
          ch: this.ch,
          fmt: this.fmt,
          yUnit: this.yUnit,
          autoX: this.autoX,
          autoY: this.autoY,
          win: this.win,
          yLo: this.yLo,
          yHi: this.yHi,
          cal: this.cal,
        }),
      );
    } catch {}
  }

  // —— stream control ——
  private buildFmt(): void {
    this.fmtSel.innerHTML = "";
    const a = document.createElement("option");
    a.value = "json";
    a.textContent = "JSON";
    const b = document.createElement("option");
    b.value = "bin";
    b.textContent = t("scope_fmt_bin");
    this.fmtSel.append(a, b);
    this.fmtSel.value = this.fmt;
  }

  private updateRunLabel(): void {
    this.btnRun.textContent = this.running ? t("scope_stop") : t("scope_run");
  }

  private syncTools(): void {
    this.btnAutoX.textContent = t("scope_autox");
    this.btnAutoY.textContent = t("scope_autoy");
    this.btnCal.textContent = t("scope_cal");
    this.btnUnit.textContent = this.yUnit === "V" ? "V" : "raw";
    this.btnAutoX.classList.toggle("on", this.autoX);
    this.btnAutoY.classList.toggle("on", this.autoY);
    this.fmtSel.value = this.fmt;
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
        fmt: this.fmt,
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
  private ring(pin: number): Ring {
    let r = this.rings.get(pin);
    if (!r) {
      r = { buf: new Uint16Array(CAP), head: 0, count: 0 };
      this.rings.set(pin, r);
    }
    return r;
  }

  private push(pin: number, val: number): void {
    const r = this.ring(pin);
    r.buf[r.head] = val & FULL;
    r.head = (r.head + 1) % CAP;
    if (r.count < CAP) r.count++;
  }

  onMsg(m: JsonMsg): void {
    if (m.evt !== "adc_w" || !Array.isArray(m.pins) || !Array.isArray(m.v)) return;
    const pins = m.pins as number[];
    if (typeof m.ms === "number" && m.ms > 0) this.sampleMs = m.ms;
    const rows = m.v as number[][];
    for (const row of rows)
      for (let i = 0; i < pins.length; i++)
        if (typeof row[i] === "number") this.push(pins[i], row[i]);
    const last = rows[rows.length - 1];
    if (Array.isArray(last)) {
      const vals: Record<number, number> = {};
      for (let i = 0; i < pins.length; i++)
        if (typeof last[i] === "number") vals[pins[i]] = last[i];
      this.onLatest(vals);
    }
    this.invalidate();
  }

  // Binary struct frame payload: "<BBHH"(kind, nch, ms, nrows) + u16[nch] pins
  // + u16[nrows*nch] samples (row-major). kind 1 = ADC waveform batch.
  onFrame(p: Uint8Array): void {
    if (p.length < 6) return;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (dv.getUint8(0) !== 1) return;
    const nch = dv.getUint8(1);
    const ms = dv.getUint16(2, true);
    const nrows = dv.getUint16(4, true);
    if (ms > 0) this.sampleMs = ms;
    const pins: number[] = [];
    for (let i = 0; i < nch; i++) pins.push(dv.getUint16(6 + i * 2, true));
    let off = 6 + nch * 2;
    if (off + nrows * nch * 2 > p.length) return;
    const vals: Record<number, number> = {};
    for (let rIdx = 0; rIdx < nrows; rIdx++)
      for (let c = 0; c < nch; c++) {
        const v = dv.getUint16(off, true);
        off += 2;
        this.push(pins[c], v);
        if (rIdx === nrows - 1) vals[pins[c]] = v;
      }
    if (nrows > 0) this.onLatest(vals);
    this.invalidate();
  }

  // —— interaction ——
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const out = e.deltaY > 0; // wheel down = zoom out
    if (e.shiftKey) {
      if (this.autoY) {
        this.autoY = false;
        this.yLo = this.fitLo;
        this.yHi = this.fitHi;
      }
      const center = (this.yLo + this.yHi) / 2;
      const span = this.yHi - this.yLo;
      const ns = clamp(span * (out ? 1.25 : 0.8), 16, FULL * 2);
      this.yLo = center - ns / 2;
      this.yHi = center + ns / 2;
    } else {
      this.autoX = false;
      this.win = Math.round(clamp(this.win * (out ? 1.25 : 0.8), WIN_MIN, CAP));
    }
    this.syncTools();
    this.save();
    this.invalidate();
  }

  private getCal(pin: number): Cal {
    return this.cal[pin] || { k: 1, b: 0 };
  }

  private corrected(pin: number, raw: number): number {
    const c = this.getCal(pin);
    return c.k * raw + c.b;
  }

  // —— calibration editor ——
  private buildCal(): void {
    this.calPanel.innerHTML = "";
    const head = el("scope-cal-head");
    head.textContent = t("scope_cal");
    this.calPanel.appendChild(head);
    if (!this.ch.length) {
      const empty = el("scope-cal-empty");
      empty.textContent = t("scope_no_ch");
      this.calPanel.appendChild(empty);
      return;
    }
    this.ch.forEach((pin, ci) => {
      const row = el("scope-cal-row");
      const tag = el("scope-cal-tag c" + ci);
      tag.textContent = "GP" + pin;
      const c = this.getCal(pin);
      row.appendChild(tag);
      row.appendChild(this.calInput("k", c.k, pin));
      row.appendChild(this.calInput("b", c.b, pin));
      this.calPanel.appendChild(row);
    });
  }

  private calInput(which: "k" | "b", val: number, pin: number): HTMLElement {
    const wrap = el("scope-cal-fld");
    const lab = el("scope-cal-lbl");
    lab.textContent = which;
    const inp = document.createElement("input");
    inp.className = "scope-cal-in";
    inp.type = "number";
    inp.step = which === "k" ? "0.0001" : "1";
    inp.value = String(val);
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      const cur = this.getCal(pin);
      this.cal[pin] = { k: cur.k, b: cur.b, [which]: Number.isFinite(v) ? v : cur[which] };
      this.save();
      this.invalidate();
    });
    wrap.append(lab, inp);
    return wrap;
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
    if (w < 60 || h < 60) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#0b0e11";
    g.fillRect(0, 0, w, h);

    const ML = 46,
      MR = 8,
      MT = 8,
      MB = 16;
    const pw = w - ML - MR;
    const ph = h - MT - MB;
    if (pw < 20 || ph < 20) return;

    // visible window = most recent n samples, right-anchored to "now"
    let maxCount = 0;
    for (const pin of this.ch) {
      const r = this.rings.get(pin);
      if (r && r.count > maxCount) maxCount = r.count;
    }
    const n = Math.max(2, Math.min(this.autoX ? CAP : this.win, maxCount || CAP));
    const sps = 1000 / this.sampleMs;
    const spanS = (n * this.sampleMs) / 1000;
    this.infoEl.textContent = tf(
      "scope_info",
      sps % 1 === 0 ? String(sps) : sps.toFixed(1),
      spanS < 1 ? spanS.toFixed(2) : spanS.toFixed(1),
    );

    // vertical range
    let lo: number, hi: number;
    if (this.autoY) {
      let a = Infinity,
        b = -Infinity;
      for (const pin of this.ch) {
        const r = this.rings.get(pin);
        if (!r) continue;
        const first = (r.head - Math.min(r.count, n) + CAP * 2) % CAP;
        const cnt = Math.min(r.count, n);
        for (let k = 0; k < cnt; k++) {
          const v = this.corrected(pin, r.buf[(first + k) % CAP]);
          if (v < a) a = v;
          if (v > b) b = v;
        }
      }
      if (!isFinite(a) || !isFinite(b)) {
        a = 0;
        b = FULL;
      }
      if (b - a < 16) {
        const mid = (a + b) / 2;
        a = mid - 8;
        b = mid + 8;
      }
      const pad = (b - a) * 0.08;
      lo = a - pad;
      hi = b + pad;
      this.fitLo = lo;
      this.fitHi = hi;
    } else {
      lo = this.yLo;
      hi = this.yHi;
      this.fitLo = lo;
      this.fitHi = hi;
    }
    const span = hi - lo || 1;

    // grid + Y axis labels
    g.strokeStyle = "#232c35";
    g.lineWidth = 1;
    g.font = "10px Consolas, monospace";
    g.fillStyle = "#7a8896";
    g.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(MT + (ph * i) / 4) + 0.5;
      g.moveTo(ML, y);
      g.lineTo(ML + pw, y);
      const raw = hi - (span * i) / 4;
      const lab = this.yUnit === "V" ? ((raw / FULL) * VREF).toFixed(2) : Math.round(raw).toString();
      g.fillText(lab, 4, y + 3);
    }
    const xt = 5;
    for (let i = 0; i <= xt; i++) {
      const x = Math.round(ML + (pw * i) / xt) + 0.5;
      g.moveTo(x, MT);
      g.lineTo(x, MT + ph);
      const secs = -spanS * (1 - i / xt);
      const lab = (secs > -0.005 ? "0" : secs.toFixed(spanS < 1 ? 2 : 1)) + "s";
      g.fillText(lab, Math.min(x + 2, ML + pw - 22), MT + ph + 12);
    }
    g.stroke();

    // traces
    this.ch.forEach((pin, ci) => {
      const r = this.rings.get(pin);
      if (!r || r.count < 2) return;
      const cnt = Math.min(r.count, n);
      const first = (r.head - cnt + CAP * 2) % CAP;
      const stride = Math.max(1, Math.floor(cnt / pw));
      g.strokeStyle = PALETTE[ci % PALETTE.length];
      g.lineWidth = 1;
      g.beginPath();
      let started = false;
      for (let k = 0; k < cnt; k += stride) {
        const raw = r.buf[(first + k) % CAP];
        const v = this.corrected(pin, raw);
        const x = ML + pw - ((cnt - 1 - k) / (n - 1 || 1)) * pw; // right-anchored to "now"
        const y = MT + ph - ((v - lo) / span) * ph;
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else g.lineTo(x, y);
      }
      g.stroke();
    });
  }
}
