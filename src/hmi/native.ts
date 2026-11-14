/**
 * An HMI screen as a native CODESYS visualization: the same layout as the HTML
 * screen (1280x720), built from CODESYS's own elements, with SVG symbols in an
 * embedded image pool and a small helper program that scales values for bars
 * and tank levels. The watcher builds it (watcher/mcp_visu.py).
 */
import { tileBox, CANVAS } from "./render.js";
import { routed } from "./route.js";
import type { ProcessItem, Screen, Tone, Widget } from "./spec.js";
import { screenVariables } from "./spec.js";

type Argb = number;
export interface NativeElement {
  kind: "rect" | "round" | "circle" | "switcher" | "image";
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  font?: [string, number] | [string, number, "bold"];
  color?: Argb;
  align?: "LEFT" | "HCENTER" | "RIGHT";
  fill?: Argb | null;
  frame?: Argb | null;
  lineWidth?: number;
  gradient?: [Argb, Argb, number];
  radius?: number;
  invisible?: string;
  props?: Record<string, string | number | boolean | { argb: Argb }>;
  click?: string;
}

export interface NativePlan {
  visu: string;
  imagePool: string;
  background: Argb;
  elements: NativeElement[];
  images: { id: string; svg: string }[];
  helper: { name: string; declaration: string; implementation: string };
}

interface Palette {
  bg: Argb;
  header: [Argb, Argb];
  headerText: Argb;
  tile: Argb;
  tile2: Argb;
  border: Argb;
  text: Argb;
  muted: Argb;
  track: Argb;
  pipe: Argb;
  shell: Argb;
  liquid: [Argb, Argb];
  tones: Record<Tone, Argb>;
  soft: Record<Tone, Argb>;
}

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: {
    bg: 0xff0a1222,
    header: [0xff0b1630, 0xff1e3a8a],
    headerText: 0xffe6edf7,
    tile: 0xff141e33,
    tile2: 0xff0f1729,
    border: 0xff24324a,
    text: 0xffe6edf7,
    muted: 0xff8193ad,
    track: 0xff26324a,
    pipe: 0xff334155,
    shell: 0xff1e293b,
    liquid: [0xff38bdf8, 0xff0369a1],
    tones: { accent: 0xff38bdf8, ok: 0xff22c55e, warn: 0xfff59e0b, alarm: 0xffef4444, neutral: 0xff64748b },
    soft: { accent: 0xff0c3a52, ok: 0xff0f3d24, warn: 0xff3f2a07, alarm: 0xff4a1515, neutral: 0xff26324a },
  },
  light: {
    bg: 0xffeef2f7,
    header: [0xff0f172a, 0xff1e3a8a],
    headerText: 0xffffffff,
    tile: 0xffffffff,
    tile2: 0xfff8fafc,
    border: 0xffe2e8f0,
    text: 0xff0f172a,
    muted: 0xff64748b,
    track: 0xffe2e8f0,
    pipe: 0xff94a3b8,
    shell: 0xffcbd5e1,
    liquid: [0xff38bdf8, 0xff0284c7],
    tones: { accent: 0xff0284c7, ok: 0xff16a34a, warn: 0xffd97706, alarm: 0xffdc2626, neutral: 0xff94a3b8 },
    soft: { accent: 0xffe0f2fe, ok: 0xffdcfce7, warn: 0xfffef3c7, alarm: 0xfffee2e2, neutral: 0xfff1f5f9 },
  },
};

const FONT = "Segoe UI";
const SEMI = "Segoe UI Semibold";
const LIGHT = "Segoe UI Light";
const hex = (c: Argb) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
const c = (argb: Argb) => ({ argb });
const r = Math.round;

/** Severity order of tones; the visualization shows two colours per element, so the most important band wins. */
function band(bands: { from: number; tone: Tone }[] | undefined): { from: number; tone: Tone } | undefined {
  const rank: Record<Tone, number> = { alarm: 3, warn: 2, ok: 1, accent: 0, neutral: 0 };
  const hot = (bands ?? []).filter((b) => rank[b.tone] >= 2).sort((a, b) => a.from - b.from);
  return hot[0];
}

/** SVG symbols for the image pool (100x100). */
export function symbols(p: Palette): { id: string; svg: string }[] {
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${body}</svg>`;
  const pump = (on: boolean) => {
    const ring = on ? hex(p.tones.ok) : hex(p.tones.neutral);
    const blades = [0, 60, 120, 180, 240, 300].map((a) => `<path d="M0 0 Q 12 -10 5 -26" transform="rotate(${a})" fill="none" stroke="${ring}" stroke-width="4.5" stroke-linecap="round"/>`).join("");
    return wrap(`<defs><radialGradient id="h" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="${hex(p.shell === 0xff1e293b ? 0xff475569 : 0xfff1f5f9)}"/><stop offset="1" stop-color="${hex(p.shell === 0xff1e293b ? 0xff0f172a : 0xffcbd5e1)}"/></radialGradient>
<filter id="g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${on ? 3 : 0.01}"/></filter></defs>
${on ? `<circle cx="50" cy="50" r="46" fill="none" stroke="${ring}" stroke-width="6" opacity=".55" filter="url(#g)"/>` : ""}
<circle cx="50" cy="50" r="47" fill="none" stroke="${ring}" stroke-width="5"/><circle cx="50" cy="50" r="41" fill="url(#h)"/>
<g transform="translate(50 50)">${blades}<circle r="6" fill="${ring}"/></g>`);
  };
  const fan = (on: boolean) => {
    const col = on ? hex(p.tones.ok) : hex(p.tones.neutral);
    const blades = [0, 120, 240].map((a) => `<path d="M0 0 C 18 -7 20 -30 0 -33 C -8 -24 -4 -8 0 0Z" transform="rotate(${a})" fill="${col}"/>`).join("");
    return wrap(`<circle cx="50" cy="50" r="47" fill="none" stroke="${col}" stroke-width="5"/><circle cx="50" cy="50" r="41" fill="${hex(p.tile2)}"/><g transform="translate(50 50)">${blades}<circle r="6" fill="${hex(p.tile)}" stroke="${col}" stroke-width="2"/></g>`);
  };
  const valve = (open: boolean) => {
    const col = open ? hex(p.tones.ok) : hex(p.tones.neutral);
    return wrap(`<line x1="50" y1="50" x2="50" y2="18" stroke="${hex(p.muted)}" stroke-width="4"/><rect x="36" y="8" width="28" height="12" rx="3" fill="${hex(p.shell)}" stroke="${hex(p.border)}"/>
<path d="M1 30 L99 70 L99 30 L1 70 Z" fill="${col}" stroke="${hex(p.border)}" stroke-width="1.5" stroke-linejoin="round"/>`);
  };
  return [
    { id: "pump_on", svg: pump(true) },
    { id: "pump_off", svg: pump(false) },
    { id: "fan_on", svg: fan(true) },
    { id: "fan_off", svg: fan(false) },
    { id: "valve_open", svg: valve(true) },
    { id: "valve_closed", svg: valve(false) },
    { id: "valve_open_v", svg: valve(true).replace(/(<svg[^>]*>)([\s\S]*)(<\/svg>)/, '$1<g transform="rotate(90 50 50)">$2</g>$3') },
    { id: "valve_closed_v", svg: valve(false).replace(/(<svg[^>]*>)([\s\S]*)(<\/svg>)/, '$1<g transform="rotate(90 50 50)">$2</g>$3') },
  ];
}

export function nativePlan(screen: Screen): NativePlan {
  const p = PALETTES[screen.theme];
  const visu = `Visu_${screen.name}`;
  const pool = `IP_${screen.name}`;
  const helperName = `PRG_HMI_${screen.name}`;
  const els: NativeElement[] = [];
  const templates = symbols(p);
  const needed = new Map<string, string>();
  const decl: string[] = [];
  const impl: string[] = [];
  let n = 0;
  /** A REAL copy of a variable for display (works for any numeric type). */
  const real = (v: string) => {
    const name = `rV${++n}`;
    decl.push(`    ${name} : REAL; // ${v}`);
    impl.push(`${name} := ANY_TO_REAL(${v});`);
    return `${helperName}.${name}`;
  };
  /** Pixels for a value between min and max over a length. */
  const pixels = (v: string, min: number, max: number, len: number, negative = false) => {
    const name = `iP${++n}`;
    decl.push(`    ${name} : INT; // ${v}`);
    impl.push(`${name} := ${negative ? "-" : ""}REAL_TO_INT(LIMIT(0.0, (ANY_TO_REAL(${v}) - (${num(min)})) / (${num(max - min || 1)}), 1.0) * ${len}.0);`);
    return `${helperName}.${name}`;
  };
  const above = (v: string, from: number) => {
    const name = `xB${++n}`;
    decl.push(`    ${name} : BOOL; // ${v} >= ${from}`);
    impl.push(`${name} := ANY_TO_REAL(${v}) >= ${num(from)};`);
    return `${helperName}.${name}`;
  };
  const fmt = (d?: number) => `%.${d ?? 1}f`;
  const text = (x: number, y: number, w: number, h: number, t: string, font: NativeElement["font"], color: Argb, align: NativeElement["align"] = "LEFT", extra: Partial<NativeElement> = {}): NativeElement => ({
    kind: "rect", x: r(x), y: r(y), w: r(w), h: r(h), text: t, font, color, align, fill: null, frame: null, ...extra,
  });

  // Canvas and header.
  els.push({ kind: "rect", name: "Header", x: 0, y: 0, w: CANVAS.w, h: 62, fill: p.header[0], frame: null, gradient: [p.header[0], p.header[1], 0] });
  els.push(text(24, 8, 760, 30, screen.title, [SEMI, 17], p.headerText));
  if (screen.subtitle) els.push(text(24, 34, 760, 20, screen.subtitle, [FONT, 9.5], 0xffa5b4fc));

  screen.widgets.forEach((wg, i) => {
    const b = tileBox(screen, wg.at);
    const by = b.y; // the header band is 62 px; tiles start at 76
    els.push({ kind: "round", name: `Tile${i + 1}`, x: r(b.x), y: r(by), w: r(b.w), h: r(b.h), fill: p.tile, frame: p.border, lineWidth: 1, gradient: [p.tile, p.tile2, 90], radius: 14 });
    if (wg.title) els.push(text(b.x + 16, by + 10, b.w - 32, 20, wg.title.toUpperCase(), [SEMI, 8.5], p.muted));
    const box = { x: b.x + 16, y: by + (wg.title ? 36 : 14), w: b.w - 32, h: b.h - (wg.title ? 46 : 26) };
    widget(wg, box);
  });

  function widget(w: Widget, box: { x: number; y: number; w: number; h: number }) {
    switch (w.type) {
      case "value": {
        const hot = band(w.bands);
        const size = Math.max(16, Math.min(40, box.h * 0.32));
        els.push(text(box.x, box.y, box.w, box.h * 0.6, `${fmt(w.decimals)}${w.unit ? ` ${w.unit}` : ""}`, [LIGHT, size], p.text, "LEFT", {
          props: { "Text variables.Text variable": real(w.value), ...(hot ? { "Color variables.Toggle color": above(w.value, hot.from), "Text properties.Font alarm color": c(p.tones[hot.tone]) } : {}) },
        }));
        break;
      }
      case "gauge":
      case "bar": {
        const hot = band(w.bands);
        const size = Math.max(16, Math.min(40, box.h * 0.3));
        els.push(text(box.x, box.y, box.w, box.h * 0.5, `${fmt(w.type === "gauge" ? w.decimals : 1)}${w.unit ? ` ${w.unit}` : ""}`, [LIGHT, size], p.text, w.type === "gauge" ? "HCENTER" : "LEFT", { props: { "Text variables.Text variable": real(w.value) } }));
        const ty = box.y + box.h * 0.62;
        const len = r(box.w);
        els.push({ kind: "round", x: r(box.x), y: r(ty), w: len, h: 14, fill: p.track, frame: null, radius: 7 });
        els.push({
          kind: "round", x: r(box.x), y: r(ty), w: 1, h: 14, fill: p.tones.accent, frame: null, radius: 7, gradient: [p.liquid[1], p.tones.accent, 0],
          props: { "Relative movement.Movement bottom-right.X": pixels(w.value, w.min, w.max, len - 1), ...(hot ? { "Color variables.Toggle color": above(w.value, hot.from), "Colors.Alarm state.Fill color": c(p.tones[hot.tone]), "Colors.Alarm state.Frame color": c(p.tones[hot.tone]) } : {}) },
        });
        els.push(text(box.x, ty + 18, box.w / 2, 16, String(w.min), [FONT, 8], p.muted));
        els.push(text(box.x + box.w / 2, ty + 18, box.w / 2, 16, String(w.max), [FONT, 8], p.muted, "RIGHT"));
        break;
      }
      case "status": {
        const rowH = Math.min(26, box.h / w.items.length);
        w.items.forEach((it, k) => {
          const y = box.y + k * rowH;
          const tone = p.tones[it.tone ?? "ok"];
          els.push({ kind: "circle", x: r(box.x), y: r(y + rowH / 2 - 6), w: 12, h: 12, fill: p.track, frame: null, props: { "Color variables.Toggle color": it.invert ? `NOT ${it.on}` : it.on, "Colors.Alarm state.Fill color": c(tone), "Colors.Alarm state.Frame color": c(tone) } });
          els.push(text(box.x + 22, y, box.w - 22, rowH, it.label, [FONT, 10], p.text));
        });
        break;
      }
      case "buttons": {
        const gap = 10;
        const vertical = w.items.length > 2 && box.w < 360;
        const bw = vertical ? box.w : (box.w - gap * (w.items.length - 1)) / w.items.length;
        const bh = vertical ? Math.min(46, (box.h - gap * (w.items.length - 1)) / w.items.length) : Math.min(50, box.h);
        w.items.forEach((it, k) => {
          const tone = p.tones[it.tone ?? (/stop|reset|off/i.test(it.label) ? "alarm" : "accent")];
          const x = vertical ? box.x : box.x + k * (bw + gap);
          const y = vertical ? box.y + k * (bh + gap) : box.y + (box.h - bh) / 2;
          const props: NativeElement["props"] = { "Colors.Alarm state.Fill color": c(darken(tone, 0.25)), "Colors.Alarm state.Frame color": c(darken(tone, 0.25)) };
          let click: string | undefined;
          if (it.action === "tap") props["Input configuration.Tap.Variable"] = it.variable;
          else if (it.action === "toggle") props["Input configuration.Toggle.Variable"] = it.variable;
          else click = `${it.variable} := ${it.action === "set" ? "TRUE" : "FALSE"};`;
          els.push({ kind: "round", x: r(x), y: r(y), w: r(bw), h: r(bh), text: it.label, font: [SEMI, 11], color: 0xffffffff, fill: tone, frame: tone, radius: 10, gradient: [tone, darken(tone, 0.18), 90], props, ...(click ? { click } : {}) });
        });
        break;
      }
      case "switch": {
        const y = box.y + box.h / 2 - 15;
        els.push({ kind: "round", x: r(box.x), y: r(y), w: 58, h: 30, fill: p.track, frame: null, radius: 15, props: { "Input configuration.Toggle.Variable": w.variable, "Color variables.Toggle color": w.variable, "Colors.Alarm state.Fill color": c(p.tones.ok), "Colors.Alarm state.Frame color": c(p.tones.ok) } });
        els.push({ kind: "circle", x: r(box.x + 3), y: r(y + 3), w: 24, h: 24, fill: 0xffffffff, frame: null, invisible: w.variable });
        els.push({ kind: "circle", x: r(box.x + 31), y: r(y + 3), w: 24, h: 24, fill: 0xffffffff, frame: null, invisible: `NOT ${w.variable}` });
        els.push(text(box.x + 72, y, box.w - 120, 30, w.label ?? "", [FONT, 11], p.text));
        els.push(text(box.x + box.w - 48, y, 48, 30, "ON", [SEMI, 9], p.tones.ok, "RIGHT", { invisible: `NOT ${w.variable}` }));
        els.push(text(box.x + box.w - 48, y, 48, 30, "OFF", [SEMI, 9], p.muted, "RIGHT", { invisible: w.variable }));
        break;
      }
      case "setpoint": {
        const step = w.step ?? 1;
        const dec = Number.isInteger(step) ? 0 : String(step).split(".")[1]!.length;
        const y = box.y + Math.max(0, box.h / 2 - 22);
        const btn = (x: number, label: string, delta: string): NativeElement => ({ kind: "round", x: r(x), y: r(y), w: 40, h: 40, text: label, font: [SEMI, 14], color: p.text, fill: p.track, frame: p.border, radius: 10, click: `${w.variable} := LIMIT(${w.min}, ${w.variable} ${delta} ${step}, ${w.max});` });
        els.push(btn(box.x, "−", "-"));
        els.push(text(box.x + 46, y, box.w - 92, 40, `${fmt(dec)}${w.unit ? ` ${w.unit}` : ""}`, [SEMI, 18], p.text, "HCENTER", { props: { "Text variables.Text variable": real(w.variable) } }));
        els.push(btn(box.x + box.w - 40, "+", "+"));
        els.push(text(box.x, y + 46, box.w / 2, 16, String(w.min), [FONT, 8], p.muted));
        els.push(text(box.x + box.w / 2, y + 46, box.w / 2, 16, String(w.max), [FONT, 8], p.muted, "RIGHT"));
        break;
      }
      case "trend": {
        // No trend element by script: the series' current values, one per row.
        const rowH = Math.min(30, box.h / (w.series.length + 1));
        w.series.forEach((s, k) => {
          const y = box.y + k * rowH;
          els.push({ kind: "round", x: r(box.x), y: r(y + rowH / 2 - 2), w: 12, h: 4, fill: SERIES[k % SERIES.length]!, frame: null, radius: 2 });
          els.push(text(box.x + 20, y, box.w * 0.55, rowH, s.label ?? s.value.split(".").pop()!, [FONT, 10], p.muted));
          els.push(text(box.x + box.w * 0.55, y, box.w * 0.45, rowH, "%.1f", [SEMI, 11], p.text, "RIGHT", { props: { "Text variables.Text variable": real(s.value) } }));
        });
        els.push(text(box.x, box.y + box.h - 18, box.w, 18, "Trend chart: in the live HMI (open_hmi)", [FONT, 8], p.muted));
        break;
      }
      case "alarms": {
        const rowH = Math.min(34, (box.h - 6 * (w.items.length - 1)) / w.items.length);
        els.push(text(box.x, box.y, box.w, 24, "No active alarms", [FONT, 10], p.tones.ok, "LEFT", { invisible: w.items.map((a) => a.active).join(" OR ") }));
        w.items.forEach((a, k) => {
          const tone: Tone = a.severity === "info" ? "accent" : a.severity === "warning" ? "warn" : "alarm";
          els.push({ kind: "round", x: r(box.x), y: r(box.y + k * (rowH + 6)), w: r(box.w), h: r(rowH), text: `  ${a.text}`, font: [SEMI, 9.5], color: p.tones[tone], align: "LEFT", fill: p.soft[tone], frame: p.tones[tone], radius: 8, invisible: `NOT ${a.active}` });
        });
        break;
      }
      case "text":
        els.push(text(box.x, box.y, box.w, box.h, w.text, [FONT, 10.5], p.muted));
        break;
      case "process": {
        const sx = box.w / 100;
        const sy = box.h / 100;
        const X = (x: number) => box.x + x * sx;
        const Y = (y: number) => box.y + y * sy;
        const items = routed(w.items, box.h / box.w).sort((a, b2) => (a.type === "pipe" ? -1 : 0) - (b2.type === "pipe" ? -1 : 0));
        for (const it of items) processItem(it, X, Y, sx);
        break;
      }
    }
  }

  function processItem(it: ProcessItem, X: (x: number) => number, Y: (y: number) => number, sx: number) {
    const label = (cx: number, y: number, t?: string) => t && els.push(text(cx - 60, y, 120, 18, t, [SEMI, 8.5], p.muted, "HCENTER"));
    switch (it.type) {
      case "pipe": {
        const th = 7;
        const pts = it.points ?? [];
        for (let k = 1; k < pts.length; k++) {
          const [x1, y1] = pts[k - 1]!;
          const [x2, y2] = pts[k]!;
          const segs: [number, number, number, number][] = x1 === x2 || y1 === y2 ? [[x1, y1, x2, y2]] : [[x1, y1, x2, y1], [x2, y1, x2, y2]];
          for (const [a1, b1, a2, b2] of segs) {
            const x = Math.min(X(a1), X(a2)) - th / 2, y = Math.min(Y(b1), Y(b2)) - th / 2;
            els.push({ kind: "round", x: r(x), y: r(y), w: r(Math.abs(X(a2) - X(a1)) + th), h: r(Math.abs(Y(b2) - Y(b1)) + th), fill: p.pipe, frame: null, radius: 3, ...(it.flow ? { props: { "Color variables.Toggle color": it.flow, "Colors.Alarm state.Fill color": c(p.tones.accent), "Colors.Alarm state.Frame color": c(p.tones.accent) } } : {}) });
          }
        }
        break;
      }
      case "tank": {
        const x = X(it.x), y = Y(it.y), w = it.w * sx, h = Y(it.y + it.h) - y;
        els.push({ kind: "round", x: r(x), y: r(y), w: r(w), h: r(h), fill: p.shell, frame: p.border, radius: 12, gradient: [p.shell, darken(p.shell, -0.12), 0] });
        els.push({ kind: "rect", x: r(x + 3), y: r(y + h - 3), w: r(w - 6), h: 1, fill: p.liquid[0], frame: null, gradient: [p.liquid[0], p.liquid[1], 90], props: { "Relative movement.Movement top-left.Y": pixels(it.level, 0, it.max, r(h - 6), true) } });
        els.push(text(x, y + h / 2 - 18, w, 36, `%.0f${it.unit ? ` ${it.unit}` : ""}`, [SEMI, 15], 0xffffffff, "HCENTER", { props: { "Text variables.Text variable": real(it.level) } }));
        label(x + w / 2, y + h + 4, it.label);
        break;
      }
      case "pump":
      case "fan":
      case "valve": {
        const size = (it.type === "valve" ? it.size : it.size) * sx;
        const cx = X(it.x), cy = Y(it.y);
        const vert = it.type === "valve" && it.vertical ? "_v" : "";
        const [on, off, v] = it.type === "valve" ? [`valve_open${vert}`, `valve_closed${vert}`, it.open] : [`${it.type}_on`, `${it.type}_off`, it.running];
        // CODESYS draws an image at its own size from the box's corner, so each size gets its own SVG.
        const px = r(size);
        els.push({ kind: "switcher", x: r(cx - px / 2), y: r(cy - px / 2), w: px, h: px, props: { 'Image settings.Image, if "on"': `${pool}.${image(on, px)}`, 'Image settings.Image, if  "off"': `${pool}.${image(off, px)}`, Variable: v } });
        if (it.type === "valve" && it.label) els.push(text(cx + size / 2 + 6, cy - 9, 120, 18, it.label, [SEMI, 8.5], p.muted));
        else label(cx, cy + size / 2 + 2, it.label);
        break;
      }
      case "sensor": {
        const cx = X(it.x), cy = Y(it.y);
        els.push({ kind: "round", x: r(cx - 58), y: r(cy - 15), w: 116, h: 30, text: `%.${it.decimals ?? 1}f${it.unit ? ` ${it.unit}` : ""}`, font: [SEMI, 10], color: p.text, fill: p.tile2, frame: p.tones.accent, radius: 15, props: { "Text variables.Text variable": real(it.value) } });
        if (it.label) els.push(text(cx - 58, cy - 33, 116, 16, it.label, [SEMI, 8], p.muted, "HCENTER"));
        break;
      }
      case "lamp": {
        const cx = X(it.x), cy = Y(it.y);
        const tone = p.tones[it.tone ?? "ok"];
        els.push({ kind: "circle", x: r(cx - 9), y: r(cy - 9), w: 18, h: 18, fill: p.track, frame: null, props: { "Color variables.Toggle color": it.on, "Colors.Alarm state.Fill color": c(tone), "Colors.Alarm state.Frame color": c(tone) } });
        if (it.label) els.push(text(cx + 16, cy - 10, 140, 20, it.label, [SEMI, 9], p.muted));
        break;
      }
      case "label":
        els.push(text(X(it.x), Y(it.y) - 10, 220, 20, it.text, [SEMI, 10], p.text));
        break;
      case "junction":
        els.push({ kind: "circle", x: r(X(it.x) - 6), y: r(Y(it.y) - 6), w: 12, h: 12, fill: p.pipe, frame: null });
        break;
    }
  }

  function image(base: string, px: number): string {
    const id = `${base}_${px}`;
    if (!needed.has(id)) {
      const svg = templates.find((t) => t.id === base)!.svg.replace('width="100" height="100"', `width="${px}" height="${px}"`);
      needed.set(id, svg);
    }
    return id;
  }

  const vars = screenVariables(screen);
  return {
    visu,
    imagePool: pool,
    background: p.bg,
    elements: els,
    images: [...needed].map(([id, svg]) => ({ id, svg })),
    helper: {
      name: helperName,
      declaration: `PROGRAM ${helperName}\n// Generated by codesys-mcp-toolkit for the HMI screen '${screen.name}' (${vars.length} variables). Rebuilt on every export.\nVAR\n${decl.join("\n") || "    xUnused : BOOL;"}\nEND_VAR`,
      implementation: impl.join("\n") || ";",
    },
  };
}

const SERIES = [0xff38bdf8, 0xffa78bfa, 0xfffbbf24, 0xff34d399, 0xfff472b6, 0xff60a5fa];

function num(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

function darken(c: Argb, f: number): Argb {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >>> s) & 255) * (1 - f))));
  return ((0xff << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}
