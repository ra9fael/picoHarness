// ADC waveform scope: a collapsible panel below the workbench. Channel
// buttons list the pins bound to the ADC lane (max 4 traces); "run" turns on
// the firmware adc.stream batch feed, which also silences the chatty
// per-change adc_monitor. Frames arrive either as JSON ({"evt":"adc_w"}) or as
// compact binary struct frames (0xAA 'W' header) depending on the toolbar
// format choice — both land in the same per-channel ring buffers. Binary frames
// carry a leading kind byte and are routed through a small kind→handler table,
// so new telemetry kinds can be added without touching the frame plumbing.
//
// Each channel's colour comes from a stable pin→slot map, so toggling other
// channels off never re-shuffles the colours of the ones still visible.
//
// The canvas redraws once per animation frame, only when data arrived, so the
// wire rate can never turn into a render storm. Two acquisition modes share the
// same ring buffers: "roll" keeps a fixed 2048-deep history, "fifo" keeps a
// user-chosen depth and always shows the whole window. Interaction: wheel =
// horizontal zoom anchored at the cursor, shift+wheel = vertical zoom anchored
// at the cursor, drag = pan back through history, double-click = reset to fit.
// autoX/autoY toggle whether the view keeps fitting the data. An optional
// crosshair tracks the cursor and reads out time + per-channel values. Each
// channel carries a y = k·x + b calibration applied in the raw domain at draw
// time. Everything persists in localStorage.
import { t, tf } from "../i18n";
import { SLOTS, R_ADC, toWire, fromWire, pinLabel, type PinModel } from "../model/pins";
import type { JsonMsg, SerialLink } from "../serial";
import { el, clamp } from "./dom";

const ROLL_DEPTH = 2048; // fixed ring depth in "roll" mode
const FIFO_LENS = [256, 512, 1024, 2048, 4096]; // selectable depths in "fifo" mode
const MAX_CH = 4;
const STREAM_MS = 25; // device sample interval
const STREAM_BATCH = 25; // samples per adc_w frame
const WIN_MIN = 32;
const KIND_ADC_W = 1; // binary frame kind = ADC waveform batch
const KEY = "picoharness-scope-v1";
const PALETTE = ["#c8a2d0", "#4fd0c0", "#e5c07b", "#7fb2d4"];
const VREF = 3.3;
const FULL = 65535;

// plot geometry (CSS pixels, margins around the trace area)
const ML = 46;
const MR = 8;
const MT = 8;
const MB = 16;

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
  private btnCross: HTMLButtonElement;
  private fmtSel: HTMLSelectElement;
  private modeSel: HTMLSelectElement;
  private depthSel: HTMLSelectElement;
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
  private mode: "roll" | "fifo" = "roll";
  private fifoLen = 1024;
  private cross = true;
  private autoX = true;
  private autoY = true;
  private viewSpan = ROLL_DEPTH; // visible sample count when autoX is off
  private viewOffset = 0; // samples back from newest (0 = live) when autoX off
  private yLo = 0; // raw-domain vertical window when autoY is off
  private yHi = FULL;
  private sampleMs = STREAM_MS;
  private cal: Record<number, Cal> = {};
  private slot: Record<number, number> = {}; // pin → stable colour slot 0..MAX_CH-1
  // auto-range results from the last draw, used to seed a manual zoom
  private fitLo = 0;
  private fitHi = FULL;

  // cursor / drag state (CSS pixels relative to the canvas)
  private mx = 0;
  private my = 0;
  private mouseIn = false;
  private dragging = false;
  private dragX = 0;
  private dragOffset = 0;

  // kind → decoder for binary frames (payload after the 0xAA 'W' len header)
  private frameHandlers: Record<number, (dv: DataView, len: number) => void> = {};

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
    this.frameHandlers[KIND_ADC_W] = (dv, len) => this.decodeAdcW(dv, len);

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
    this.btnCross = el("scope-tbtn", "button") as HTMLButtonElement;
    this.fmtSel = this.mkSelect("scope-fmt");
    this.modeSel = this.mkSelect("scope-fmt");
    this.depthSel = this.mkSelect("scope-fmt");
    this.btnCal = el("scope-tbtn", "button") as HTMLButtonElement;
    tools.append(
      this.infoEl,
      el("spacer"),
      this.modeSel,
      this.depthSel,
      this.btnAutoX,
      this.btnAutoY,
      this.btnCross,
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
      if (!this.autoX) {
        this.viewSpan = clamp(this.viewSpan, WIN_MIN, this.depth());
        this.viewOffset = clamp(this.viewOffset, 0, this.maxBack());
      }
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
    this.btnCross.addEventListener("click", () => {
      this.cross = !this.cross;
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
    this.modeSel.addEventListener("change", () => {
      this.mode = this.modeSel.value === "fifo" ? "fifo" : "roll";
      this.applyDepth();
      this.save();
    });
    this.depthSel.addEventListener("change", () => {
      const v = parseInt(this.depthSel.value, 10);
      if (Number.isFinite(v)) this.fifoLen = v;
      this.applyDepth();
      this.save();
    });

    this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener("mousedown", (e) => this.onDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.onMove(e));
    this.canvas.addEventListener("mouseleave", () => {
      this.mouseIn = false;
      this.dragging = false;
      this.canvas.classList.remove("grabbing");
      this.invalidate();
    });
    this.canvas.addEventListener("dblclick", () => this.resetView());
    window.addEventListener("mouseup", () => {
      if (this.dragging) {
        this.dragging = false;
        this.canvas.classList.remove("grabbing");
        this.save();
      }
    });

    this.model.on("config", () => this.refreshChans());
    new ResizeObserver(() => this.invalidate()).observe(this.body);
    this.buildFmt();
    this.buildMode();
    this.buildDepth();
    this.reconcileSlots();
    this.refreshChans();
    this.syncTools();
    this.applyCollapse();
  }

  private mkSelect(cls: string): HTMLSelectElement {
    const s = document.createElement("select");
    s.className = cls;
    return s;
  }

  private restore(): void {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || "null");
      if (!s || typeof s !== "object") return;
      this.open = s.open !== false;
      if (Array.isArray(s.ch))
        this.ch = s.ch
          .filter((n: number) => Number.isInteger(n) && n >= 0 && n < SLOTS)
          .slice(0, MAX_CH);
      if (s.fmt === "bin") this.fmt = "bin";
      if (s.yUnit === "raw") this.yUnit = "raw";
      if (s.mode === "fifo") this.mode = "fifo";
      if (typeof s.fifoLen === "number" && FIFO_LENS.includes(s.fifoLen)) this.fifoLen = s.fifoLen;
      if (typeof s.cross === "boolean") this.cross = s.cross;
      if (typeof s.autoX === "boolean") this.autoX = s.autoX;
      if (typeof s.autoY === "boolean") this.autoY = s.autoY;
      if (typeof s.viewSpan === "number")
        this.viewSpan = clamp(Math.round(s.viewSpan), WIN_MIN, this.depth());
      if (typeof s.viewOffset === "number") this.viewOffset = Math.max(0, Math.round(s.viewOffset));
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
      if (s.slot && typeof s.slot === "object") {
        for (const k of Object.keys(s.slot)) {
          const v = s.slot[k];
          if (Number.isInteger(v) && v >= 0 && v < MAX_CH) this.slot[Number(k)] = v;
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
    this.buildMode();
    this.updateRunLabel();
    this.syncTools();
    this.applyCollapse();
  }

  // —— stable colour slots (#28) ——
  // Slots are assigned per pin and kept while the pin stays bound to the ADC
  // lane, so turning a channel off/on never re-colours the remaining traces.
  private reconcileSlots(): void {
    const bound = new Set(this.ch);
    for (const k of Object.keys(this.slot))
      if (!bound.has(Number(k))) delete this.slot[Number(k)];
    for (const pin of this.ch) {
      if (this.slot[pin] !== undefined) continue;
      const used = new Set(Object.values(this.slot));
      let s = 0;
      while (used.has(s) && s < MAX_CH - 1) s++;
      this.slot[pin] = s;
    }
  }

  private slotOf(pin: number): number {
    const s = this.slot[pin];
    return s === undefined ? 0 : s;
  }

  private colorOf(pin: number): string {
    return PALETTE[this.slotOf(pin) % PALETTE.length];
  }

  // —— channel selection ——
  private refreshChans(): void {
    this.ch = this.ch.filter((n) => this.model.roles[n] === R_ADC).slice(0, MAX_CH);
    this.reconcileSlots();
    this.chansEl.innerHTML = "";
    for (let n = 0; n < SLOTS; n++) {
      if (this.model.roles[n] !== R_ADC) continue;
      const on = this.ch.indexOf(n) >= 0;
      const b = el("scope-chan c" + this.slotOf(n), "button") as HTMLButtonElement;
      b.textContent = pinLabel(n);
      if (on) b.classList.add("on");
      b.addEventListener("click", () => {
        const i = this.ch.indexOf(n);
        if (i >= 0) this.ch.splice(i, 1);
        else if (this.ch.length >= MAX_CH) {
          this.note(tf("scope_max", MAX_CH));
          return;
        } else this.ch.push(n);
        this.reconcileSlots();
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
          mode: this.mode,
          fifoLen: this.fifoLen,
          cross: this.cross,
          autoX: this.autoX,
          autoY: this.autoY,
          viewSpan: this.viewSpan,
          viewOffset: this.viewOffset,
          yLo: this.yLo,
          yHi: this.yHi,
          cal: this.cal,
          slot: this.slot,
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

  private buildMode(): void {
    this.modeSel.innerHTML = "";
    const a = document.createElement("option");
    a.value = "roll";
    a.textContent = t("scope_mode_roll");
    const b = document.createElement("option");
    b.value = "fifo";
    b.textContent = t("scope_mode_fifo");
    this.modeSel.append(a, b);
    this.modeSel.value = this.mode;
  }

  private buildDepth(): void {
    this.depthSel.innerHTML = "";
    for (const len of FIFO_LENS) {
      const o = document.createElement("option");
      o.value = String(len);
      o.textContent = String(len);
      this.depthSel.appendChild(o);
    }
    this.depthSel.value = String(this.fifoLen);
  }

  private updateRunLabel(): void {
    this.btnRun.textContent = this.running ? t("scope_stop") : t("scope_run");
  }

  private syncTools(): void {
    this.btnAutoX.textContent = t("scope_autox");
    this.btnAutoY.textContent = t("scope_autoy");
    this.btnCal.textContent = t("scope_cal");
    this.btnCross.textContent = t("scope_cross");
    this.btnUnit.textContent = this.yUnit === "V" ? "V" : "raw";
    this.btnAutoX.classList.toggle("on", this.autoX);
    this.btnAutoY.classList.toggle("on", this.autoY);
    this.btnCross.classList.toggle("on", this.cross);
    this.fmtSel.value = this.fmt;
    this.modeSel.value = this.mode;
    this.depthSel.value = String(this.fifoLen);
    this.depthSel.disabled = this.mode !== "fifo";
    this.depthSel.title = t("scope_depth");
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
        pins: pins.map(toWire),
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
  private depth(): number {
    return this.mode === "fifo" ? this.fifoLen : ROLL_DEPTH;
  }

  // Ring depth or mode changed: drop the buffers so they reallocate at the new
  // depth, and pull the view back inside the new bounds. FIFO always shows the
  // whole (fixed-length) window, so re-enable autoX there.
  private applyDepth(): void {
    this.rings.clear();
    if (this.mode === "fifo") this.autoX = true;
    this.viewSpan = clamp(this.viewSpan, WIN_MIN, this.depth());
    this.viewOffset = 0;
    this.syncTools();
    this.invalidate();
  }

  private ring(pin: number): Ring {
    let r = this.rings.get(pin);
    if (!r) {
      r = { buf: new Uint16Array(this.depth()), head: 0, count: 0 };
      this.rings.set(pin, r);
    }
    return r;
  }

  private push(pin: number, val: number): void {
    const r = this.ring(pin);
    const d = r.buf.length;
    r.buf[r.head] = val & FULL;
    r.head = (r.head + 1) % d;
    if (r.count < d) r.count++;
  }

  // sample `back` positions before the newest (back 0 = newest), or undefined
  // if the ring does not reach that far yet
  private sampleAt(r: Ring, back: number): number | undefined {
    if (back < 0 || back >= r.count) return undefined;
    const d = r.buf.length;
    return r.buf[(r.head - 1 - back + d * 2) % d];
  }

  onMsg(m: JsonMsg): void {
    if (m.evt !== "adc_w" || !Array.isArray(m.pins) || !Array.isArray(m.v)) return;
    const pins = m.pins as number[];
    if (typeof m.ms === "number" && m.ms > 0) this.sampleMs = m.ms;
    const rows = m.v as number[][];
    for (const row of rows)
      for (let i = 0; i < pins.length; i++)
        if (typeof row[i] === "number") this.push(fromWire(pins[i]), row[i]);
    const last = rows[rows.length - 1];
    if (Array.isArray(last)) {
      const vals: Record<number, number> = {};
      for (let i = 0; i < pins.length; i++)
        if (typeof last[i] === "number") vals[pins[i]] = last[i];
      this.onLatest(vals);
    }
    this.invalidate();
  }

  // Binary frames start with a kind byte; route through the handler table so
  // future telemetry kinds plug in without touching this dispatch.
  onFrame(p: Uint8Array): void {
    if (p.length < 1) return;
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const kind = dv.getUint8(0);
    const h = this.frameHandlers[kind];
    if (h) h(dv, p.length);
  }

  // kind 1 payload: "<BBHH"(kind, nch, ms, nrows) + u16[nch] pins
  // + u16[nrows*nch] samples (row-major).
  private decodeAdcW(dv: DataView, len: number): void {
    if (len < 6) return;
    const nch = dv.getUint8(1);
    const ms = dv.getUint16(2, true);
    const nrows = dv.getUint16(4, true);
    if (ms > 0) this.sampleMs = ms;
    const pins: number[] = [];
    for (let i = 0; i < nch; i++) pins.push(dv.getUint16(6 + i * 2, true));
    let off = 6 + nch * 2;
    if (off + nrows * nch * 2 > len) return;
    const vals: Record<number, number> = {};
    for (let rIdx = 0; rIdx < nrows; rIdx++)
      for (let c = 0; c < nch; c++) {
        const v = dv.getUint16(off, true);
        off += 2;
        this.push(fromWire(pins[c]), v);
        if (rIdx === nrows - 1) vals[pins[c]] = v;
      }
    if (nrows > 0) this.onLatest(vals);
    this.invalidate();
  }

  // —— view helpers ——
  private maxCount(): number {
    let m = 0;
    for (const pin of this.ch) {
      const r = this.rings.get(pin);
      if (r && r.count > m) m = r.count;
    }
    return m;
  }

  // how far back the view can pan before it runs out of history
  private maxBack(): number {
    return Math.max(0, this.maxCount() - 1);
  }

  // —— interaction (#30) ——
  private onDown(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.dragging = true;
    this.dragX = e.clientX - r.left;
    this.dragOffset = this.viewOffset;
    this.autoX = false; // panning implies a manual window
    this.canvas.classList.add("grabbing");
    this.syncTools();
  }

  private onMove(e: MouseEvent): void {
    const r = this.canvas.getBoundingClientRect();
    this.mx = e.clientX - r.left;
    this.my = e.clientY - r.top;
    this.mouseIn = true;
    if (this.dragging) {
      const pw = Math.max(1, r.width - ML - MR);
      const span = this.spanNow();
      const dSamples = ((this.mx - this.dragX) / pw) * span; // drag right → look further back
      this.viewOffset = clamp(
        Math.round(this.dragOffset + dSamples),
        0,
        this.maxBack(),
      );
      this.save();
    }
    this.invalidate();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    const out = e.deltaY > 0; // wheel down = zoom out
    const pw = Math.max(1, r.width - ML - MR);
    const ph = Math.max(1, r.height - MT - MB);
    if (e.shiftKey) {
      // vertical zoom anchored at the cursor value
      if (this.autoY) {
        this.autoY = false;
        this.yLo = this.fitLo;
        this.yHi = this.fitHi;
      }
      const fy = clamp((this.my - MT) / ph, 0, 1); // 0 = top = hi
      const vCur = this.yHi - fy * (this.yHi - this.yLo);
      const ns = clamp((this.yHi - this.yLo) * (out ? 1.25 : 0.8), 16, FULL * 2);
      this.yHi = vCur + fy * ns;
      this.yLo = this.yHi - ns;
    } else {
      // horizontal zoom anchored at the sample under the cursor
      this.autoX = false;
      const f = clamp((this.mx - ML) / pw, 0, 1); // 0 = left = oldest visible
      const span = this.spanNow();
      const off = this.offsetNow();
      const backCur = off + (1 - f) * (span - 1); // samples-back at the cursor
      const ns = Math.round(clamp(span * (out ? 1.25 : 0.8), WIN_MIN, this.depth()));
      this.viewSpan = ns;
      this.viewOffset = clamp(Math.round(backCur - (1 - f) * (ns - 1)), 0, this.maxBack());
    }
    this.syncTools();
    this.save();
    this.invalidate();
  }

  private resetView(): void {
    this.autoX = true;
    this.autoY = true;
    this.viewOffset = 0;
    this.viewSpan = this.depth();
    this.syncTools();
    this.save();
    this.invalidate();
  }

  // effective visible span / offset for the current data + auto flags
  private spanNow(): number {
    const cnt = this.maxCount();
    if (this.autoX) return Math.max(2, cnt || 2);
    return clamp(this.viewSpan, WIN_MIN, this.depth());
  }

  private offsetNow(): number {
    if (this.autoX) return 0;
    return clamp(this.viewOffset, 0, this.maxBack());
  }

  private getCal(pin: number): Cal {
    return this.cal[pin] || { k: 1, b: 0 };
  }

  private corrected(pin: number, raw: number): number {
    const c = this.getCal(pin);
    return c.k * raw + c.b;
  }

  private unitText(raw: number): string {
    return this.yUnit === "V" ? ((raw / FULL) * VREF).toFixed(3) : Math.round(raw).toString();
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
    for (const pin of this.ch) {
      const row = el("scope-cal-row");
      const tag = el("scope-cal-tag c" + this.slotOf(pin));
      tag.textContent = pinLabel(pin);
      const c = this.getCal(pin);
      row.appendChild(tag);
      row.appendChild(this.calInput("k", c.k, pin));
      row.appendChild(this.calInput("b", c.b, pin));
      this.calPanel.appendChild(row);
    }
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

    const pw = w - ML - MR;
    const ph = h - MT - MB;
    if (pw < 20 || ph < 20) return;

    const span = this.spanNow();
    const off = this.offsetNow();
    const sps = 1000 / this.sampleMs;
    const spanS = (span * this.sampleMs) / 1000;
    this.infoEl.textContent = tf(
      "scope_info",
      sps % 1 === 0 ? String(sps) : sps.toFixed(1),
      spanS < 1 ? spanS.toFixed(2) : spanS.toFixed(1),
    );

    // x maps logical k (0 = oldest visible) → px; back = off + span-1-k
    const xOf = (k: number) => ML + (span === 1 ? pw : (k / (span - 1)) * pw);

    // vertical range (auto scans only the visible window)
    let lo: number, hi: number;
    if (this.autoY) {
      let a = Infinity,
        b = -Infinity;
      for (const pin of this.ch) {
        const r = this.rings.get(pin);
        if (!r) continue;
        for (let k = 0; k < span; k++) {
          const raw = this.sampleAt(r, off + span - 1 - k);
          if (raw === undefined) continue;
          const v = this.corrected(pin, raw);
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
    const vspan = hi - lo || 1;
    const yOf = (v: number) => MT + ph - ((v - lo) / vspan) * ph;

    // grid + axis labels
    g.strokeStyle = "#232c35";
    g.lineWidth = 1;
    g.font = "10px Consolas, monospace";
    g.fillStyle = "#7a8896";
    g.beginPath();
    for (let i = 0; i <= 4; i++) {
      const y = Math.round(MT + (ph * i) / 4) + 0.5;
      g.moveTo(ML, y);
      g.lineTo(ML + pw, y);
      const raw = hi - (vspan * i) / 4;
      const lab = this.yUnit === "V" ? ((raw / FULL) * VREF).toFixed(2) : Math.round(raw).toString();
      g.fillText(lab, 4, y + 3);
    }
    const xt = 5;
    for (let i = 0; i <= xt; i++) {
      const x = Math.round(ML + (pw * i) / xt) + 0.5;
      g.moveTo(x, MT);
      g.lineTo(x, MT + ph);
      const back = off + span - 1 - (span - 1) * (i / xt); // k = (span-1)*i/xt
      const secs = (back * this.sampleMs) / 1000;
      const lab = (secs < 0.005 ? "0" : "-" + (secs < 1 ? secs.toFixed(2) : secs.toFixed(1))) + "s";
      g.fillText(lab, Math.min(x + 2, ML + pw - 24), MT + ph + 12);
    }
    g.stroke();

    // traces (colour from the stable slot map)
    const stride = Math.max(1, Math.floor(span / pw));
    for (const pin of this.ch) {
      const r = this.rings.get(pin);
      if (!r || r.count < 2) continue;
      g.strokeStyle = this.colorOf(pin);
      g.lineWidth = 1;
      g.beginPath();
      let started = false;
      for (let k = 0; k < span; k += stride) {
        const raw = this.sampleAt(r, off + span - 1 - k);
        if (raw === undefined) {
          started = false;
          continue;
        }
        const x = xOf(k);
        const y = yOf(this.corrected(pin, raw));
        if (!started) {
          g.moveTo(x, y);
          started = true;
        } else g.lineTo(x, y);
      }
      g.stroke();
    }

    if (this.cross && this.mouseIn) this.drawCross(g, pw, ph, span, off, lo, vspan);
  }

  // dashed crosshair at the cursor + a readout of time and per-channel values
  private drawCross(
    g: CanvasRenderingContext2D,
    pw: number,
    ph: number,
    span: number,
    off: number,
    lo: number,
    vspan: number,
  ): void {
    const cx = clamp(this.mx, ML, ML + pw);
    const cy = clamp(this.my, MT, MT + ph);
    const f = span === 1 ? 1 : (cx - ML) / pw; // 0 = oldest visible
    const k = Math.round(f * (span - 1));
    const back = off + span - 1 - k;
    const secs = (back * this.sampleMs) / 1000;

    g.save();
    g.strokeStyle = "#5a6a7a";
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(Math.round(cx) + 0.5, MT);
    g.lineTo(Math.round(cx) + 0.5, MT + ph);
    g.moveTo(ML, Math.round(cy) + 0.5);
    g.lineTo(ML + pw, Math.round(cy) + 0.5);
    g.stroke();
    g.setLineDash([]);

    // cursor vertical value (raw domain, top = hi)
    const fy = clamp((cy - MT) / ph, 0, 1);
    const curRaw = lo + (1 - fy) * vspan;

    // readout box, top-left of the plot area
    const lines: string[] = ["t -" + (secs < 1 ? secs.toFixed(2) : secs.toFixed(1)) + "s"];
    const colors: string[] = ["#7a8896"];
    lines.push((this.yUnit === "V" ? "cursor " : "cur ") + this.unitText(curRaw));
    colors.push("#7a8896");
    for (const pin of this.ch) {
      const r = this.rings.get(pin);
      if (!r) continue;
      const raw = this.sampleAt(r, back);
      if (raw === undefined) continue;
      lines.push(pinLabel(pin) + " " + this.unitText(this.corrected(pin, raw)));
      colors.push(this.colorOf(pin));
    }
    g.font = "10px Consolas, monospace";
    let bw = 0;
    for (const s of lines) bw = Math.max(bw, g.measureText(s).width);
    bw += 12;
    const bh = lines.length * 12 + 6;
    const bx = ML + 4;
    const by = MT + 4;
    g.fillStyle = "rgba(11,14,17,0.82)";
    g.fillRect(bx, by, bw, bh);
    g.strokeStyle = "#2b3641";
    g.strokeRect(bx + 0.5, by + 0.5, bw, bh);
    for (let i = 0; i < lines.length; i++) {
      g.fillStyle = colors[i];
      g.fillText(lines[i], bx + 6, by + 14 + i * 12);
    }
    g.restore();
  }
}
