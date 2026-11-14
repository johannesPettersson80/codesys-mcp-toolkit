/**
 * An HMI screen as a native CODESYS visualization: the same layout as the HTML
 * screen (1280x720), built from CODESYS's own elements, with SVG symbols in an
 * embedded image pool and a small helper program that scales values for bars
 * and tank levels. The watcher builds it (watcher/mcp_visu.py).
 */
import { darkTextOn } from "./color.js";
import { canvasOf, tileBox } from "./render.js";
import { routed } from "./route.js";
import type { Faceplate, ProcessItem, Screen, Tone, Widget } from "./spec.js";
import { screenVariables, USER_GROUPS } from "./spec.js";
import { BUILTIN_SYMBOLS, findSymbol, symbolPicture, symbolSize, type SymbolColors, type SymbolLib } from "./symbols.js";

type Argb = number;
export interface NativeElement {
  kind: "rect" | "round" | "circle" | "switcher" | "image" | "complex";
  /** complex: CODESYS's element type, e.g. VisuFbElemMeter180 (made through the visual editor, so only with CODESYS's window). */
  type_name?: string;
  /** complex: properties in the order to set them. */
  pairs?: [string, string | number | boolean][];
  /** complex: what to draw instead when CODESYS has no window. */
  fallback?: NativeElement[];
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
  /** CODESYS access rights per user group (VisuAccessRightType). */
  access?: [string, "Operable" | "OnlyVisible" | "Invisible"][];
  props?: Record<string, string | number | boolean | { argb: Argb }>;
  click?: string;
  /** Switch the client to another visualization on click. */
  goto?: string;
  /** Open a dialog visualization on click. */
  dialog?: { name: string; x?: number; y?: number };
  /** Close this dialog on click. */
  close_dialog?: string;
  /** Open CODESYS's login dialog on click (visualization user management). */
  login?: boolean;
}

export interface NativeDialog {
  name: string;
  size: [number, number];
  background: Argb;
  elements: NativeElement[];
}

export interface NativePlan {
  /** Canvas size of the page. */
  size: [number, number];
  /** Faceplate dialogs opened from symbols. */
  dialogs: NativeDialog[];
  visu: string;
  imagePool: string;
  background: Argb;
  elements: NativeElement[];
  images: { id: string; svg: string }[];
  helper: { name: string; declaration: string; implementation: string };
}

export interface Palette {
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
  /** Dark surfaces (symbol bodies and shading follow it). */
  dark: boolean;
}

const PALETTES: Record<"dark" | "light" | "contrast", Palette> = {
  dark: {
    dark: true,
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
    dark: false,
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
  // High contrast: black, white outlines and full-strength colours.
  contrast: {
    dark: true,
    bg: 0xff000000,
    header: [0xff000000, 0xff000000],
    headerText: 0xffffffff,
    tile: 0xff000000,
    tile2: 0xff000000,
    border: 0xffffffff,
    text: 0xffffffff,
    muted: 0xffd1d5db,
    track: 0xff4b5563,
    pipe: 0xff9ca3af,
    shell: 0xff1f2937,
    liquid: [0xff00e5ff, 0xff0091ea],
    tones: { accent: 0xff00e5ff, ok: 0xff00ff6a, warn: 0xffffd400, alarm: 0xffff3b30, neutral: 0xff9ca3af },
    soft: { accent: 0xff003844, ok: 0xff003d1a, warn: 0xff403500, alarm: 0xff4a0d0a, neutral: 0xff1f2937 },
  },
};

/** 0xAARRGGBB from '#rrggbb'. */
const argbOf = (h: string): Argb => (0xff000000 | parseInt(h.slice(1), 16)) >>> 0;
/** a over b by t (0..1), per channel. */
function mix(a: Argb, b: Argb, t: number): Argb {
  const ch = (x: Argb, s: number) => (x >>> s) & 0xff;
  const m = (s: number) => Math.round(ch(a, s) * t + ch(b, s) * (1 - t)) << s;
  return (0xff000000 | m(16) | m(8) | m(0)) >>> 0;
}

/**
 * Rights per user group for a tile operated from group `min` up. "None" is CODESYS's group
 * for a client where nobody is logged in: it gets what the groups below `min` get.
 */
export function accessRights(min: (typeof USER_GROUPS)[number], below: "see" | "hide"): [string, "Operable" | "OnlyVisible" | "Invisible"][] {
  const from = USER_GROUPS.indexOf(min);
  const lower = below === "hide" ? "Invisible" : "OnlyVisible";
  return [["None", lower], ...USER_GROUPS.map((g, k): [string, "Operable" | "OnlyVisible" | "Invisible"] => [g, k >= from ? "Operable" : lower])];
}

/** Black or white text, whichever reads better on a colour (WCAG relative luminance). */
export function onColor(c: Argb): Argb {
  return darkTextOn(c & 0xffffff) ? 0xff04121f : 0xffffffff;
}

/** The screen's palette: its theme, with the brand colour as the accent. */
export function paletteFor(screen: { theme: "dark" | "light" | "contrast"; accent?: string }): Palette {
  const p = PALETTES[screen.theme];
  if (!screen.accent) return p;
  const a = argbOf(screen.accent);
  return { ...p, tones: { ...p.tones, accent: a }, soft: { ...p.soft, accent: mix(a, p.tile, p.dark ? 0.28 : 0.14) } };
}

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

/** Pictures per turn of a running pump or fan. */
export const FRAMES = 8;

/** SVG symbols for the image pool (100x100). */
export function symbols(p: Palette): { id: string; svg: string }[] {
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${body}</svg>`;
  const pump = (on: boolean, angle = 0) => {
    const ring = on ? hex(p.tones.ok) : hex(p.tones.neutral);
    const blades = [0, 60, 120, 180, 240, 300].map((a) => `<path d="M0 0 Q 12 -10 5 -26" transform="rotate(${a})" fill="none" stroke="${ring}" stroke-width="4.5" stroke-linecap="round"/>`).join("");
    return wrap(`<defs><radialGradient id="h" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="${hex(p.dark ? 0xff475569 : 0xfff1f5f9)}"/><stop offset="1" stop-color="${hex(p.dark ? 0xff0f172a : 0xffcbd5e1)}"/></radialGradient>
<filter id="g" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${on ? 3 : 0.01}"/></filter></defs>
${on ? `<circle cx="50" cy="50" r="46" fill="none" stroke="${ring}" stroke-width="6" opacity=".55" filter="url(#g)"/>` : ""}
<circle cx="50" cy="50" r="47" fill="none" stroke="${ring}" stroke-width="5"/><circle cx="50" cy="50" r="41" fill="url(#h)"/>
<g transform="translate(50 50) rotate(${angle})">${blades}<circle r="6" fill="${ring}"/></g>`);
  };
  const fan = (on: boolean, angle = 0) => {
    const col = on ? hex(p.tones.ok) : hex(p.tones.neutral);
    const blades = [0, 120, 240].map((a) => `<path d="M0 0 C 18 -7 20 -30 0 -33 C -8 -24 -4 -8 0 0Z" transform="rotate(${a})" fill="${col}"/>`).join("");
    return wrap(`<circle cx="50" cy="50" r="47" fill="none" stroke="${col}" stroke-width="5"/><circle cx="50" cy="50" r="41" fill="${hex(p.tile2)}"/><g transform="translate(50 50) rotate(${angle})">${blades}<circle r="6" fill="${hex(p.tile)}" stroke="${col}" stroke-width="2"/></g>`);
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
    // Running frames: CODESYS can't rotate an image, so the impeller turns through 8 pictures.
    ...Array.from({ length: FRAMES }, (_, k) => ({ id: `pump_f${k}`, svg: pump(true, (k * 60) / FRAMES) })),
    ...Array.from({ length: FRAMES }, (_, k) => ({ id: `fan_f${k}`, svg: fan(true, (k * 120) / FRAMES) })),
    { id: "valve_open", svg: valve(true) },
    { id: "valve_closed", svg: valve(false) },
    { id: "valve_open_v", svg: valve(true).replace(/(<svg[^>]*>)([\s\S]*)(<\/svg>)/, '$1<g transform="rotate(90 50 50)">$2</g>$3') },
    { id: "valve_closed_v", svg: valve(false).replace(/(<svg[^>]*>)([\s\S]*)(<\/svg>)/, '$1<g transform="rotate(90 50 50)">$2</g>$3') },
  ];
}

/**
 * alarmIndex: each HMI alarm's position in the CODESYS alarm group AG_HMI (when the export put
 * them there); those rows then follow CODESYS's alarm states and can be acknowledged.
 */
export function nativePlan(screen: Screen, pages: { name: string; title: string }[] = [], custom: SymbolLib = {}, alarmIndex?: Record<string, number>, languages: string[] = []): NativePlan {
  const p = paletteFor(screen);
  const lib: SymbolLib = { ...BUILTIN_SYMBOLS, ...custom };
  const dark = p.dark;
  const symColors = (state: "off" | "on" | "fault"): SymbolColors => ({
    state: hex(state === "on" ? p.tones.ok : state === "fault" ? p.tones.alarm : p.tones.neutral),
    body: dark ? "#334155" : "#f1f5f9",
    body2: dark ? "#1e293b" : "#cbd5e1",
    line: hex(p.muted),
    accent: hex(p.tones.accent),
  });
  const visu = `Visu_${screen.name}`;
  const pool = `IP_${screen.name}`;
  const helperName = `PRG_HMI_${screen.name}`;
  const els: NativeElement[] = [];
  const templates = symbols(p);
  const dialogs: NativeDialog[] = [];
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
  // Flow in pipes: dashes inside the pipe slide with the clock (not per cycle) while the flow
  // variable is TRUE; each moves by up to one gap and the pattern repeats, so it looks endless.
  const FLOW_GAP = 24;
  let flowVar: { pos: string; neg: string } | undefined;
  const flowPhase = () => {
    if (!flowVar) {
      decl.push("    iFlow : INT; // pipe flow phase, px", "    iFlowN : INT;");
      impl.push(`iFlow := DINT_TO_INT((TIME_TO_DINT(TIME()) / 20) MOD ${FLOW_GAP});`, "iFlowN := -iFlow;");
      flowVar = { pos: `${helperName}.iFlow`, neg: `${helperName}.iFlowN` };
    }
    return flowVar;
  };
  const flowDashes = (x1: number, y1: number, x2: number, y2: number, flow: string) => {
    const horiz = y1 === y2;
    const lo = horiz ? Math.min(x1, x2) : Math.min(y1, y2);
    const hi = horiz ? Math.max(x1, x2) : Math.max(y1, y2);
    const dash = 9;
    const thick = 3;
    const fwd = horiz ? x2 >= x1 : y2 >= y1;
    if (hi - lo < FLOW_GAP + dash + 8) return;
    const move = fwd ? flowPhase().pos : flowPhase().neg;
    const axis = horiz ? "X" : "Y";
    for (let d = 4; d + FLOW_GAP + dash <= hi - lo - 4; d += FLOW_GAP) {
      const at = fwd ? lo + d : hi - d - dash;
      els.push({
        kind: "rect",
        ...(horiz ? { x: r(at), y: r(y1 - thick / 2), w: dash, h: thick } : { x: r(x1 - thick / 2), y: r(at), w: thick, h: dash }),
        fill: onColor(p.tones.accent),
        frame: null,
        invisible: `NOT (${flow})`,
        props: { [`Relative movement.Movement top-left.${axis}`]: move, [`Relative movement.Movement bottom-right.${axis}`]: move },
      });
    }
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
  const cv = canvasOf(screen);
  els.push({ kind: "rect", name: "Header", x: 0, y: 0, w: cv.w, h: cv.header - 14, fill: p.header[0], frame: null, gradient: [p.header[0], p.header[1], 0] });
  els.push(text(24, 8, 760, 30, screen.title, [SEMI, 17], p.headerText));
  if (screen.subtitle) els.push(text(24, 34, 760, 20, screen.subtitle, [FONT, 9.5], 0xffa5b4fc));
  const navCount = pages.length > 1 ? pages.length : 0;
  const loginX = cv.w - 24 - navCount * 140 - 96;
  // No language buttons yet: checked on SP21, VisuElems.VisuFctChangeLanguage runs, but
  // CODESYS doesn't look up texts set by script in the GlobalTextList, so nothing changed.
  void languages;
  els.push({ kind: "round", name: "Login", x: r(loginX), y: 13, w: 84, h: 34, text: "Login", font: [SEMI, 10], color: p.headerText, fill: p.header[1], frame: 0x55ffffff, radius: 10, login: true });
  if (pages.length > 1) {
    const bw = 132, gap = 8;
    let x = cv.w - 24 - pages.length * bw - (pages.length - 1) * gap;
    for (const pg of pages) {
      const cur = pg.name === screen.name;
      els.push({ kind: "round", name: `Nav_${pg.name}`, x: r(x), y: 13, w: bw, h: 34, text: pg.title, font: [SEMI, 10], color: cur ? onColor(p.tones.accent) : p.headerText, fill: cur ? p.tones.accent : 0x33ffffff, frame: cur ? p.tones.accent : 0x55ffffff, radius: 10, ...(cur ? {} : { goto: `Visu_${pg.name}` }) });
      x += bw + gap;
    }
  }

  screen.widgets.forEach((wg, i) => {
    const first = els.length;
    const b = tileBox(screen, wg.at);
    const by = b.y; // the header band is 62 px; tiles start at 76
    els.push({ kind: "round", name: `Tile${i + 1}`, x: r(b.x), y: r(by), w: r(b.w), h: r(b.h), fill: p.tile, frame: p.border, lineWidth: 1, gradient: [p.tile, p.tile2, 90], radius: 14 });
    if (wg.title) els.push(text(b.x + 16, by + 10, b.w - 32, 20, wg.title.toUpperCase(), [SEMI, 8.5], p.muted));
    const box = { x: b.x + 16, y: by + (wg.title ? 36 : 14), w: b.w - 32, h: b.h - (wg.title ? 46 : 26) };
    widget(wg, box);
    // Access rights go on every element of the tile: operating ones turn inoperative, or all hide.
    if (wg.access) {
      const rights = accessRights(wg.access.min, wg.access.below);
      for (let k = first; k < els.length; k++) els[k] = { ...els[k]!, access: rights };
    }
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
      case "gauge": {
        // The browser's arc gauge as pictures: one per GAUGE_STEPS of the range, in the band's
        // colour, chosen by the helper program; the value and limits are text on top.
        const s = Math.max(80, Math.min(box.w, (box.h - 6) * 1.16));
        const gw = r(s), gh = r(s * 0.86);
        const gx = box.x + (box.w - gw) / 2, gy = box.y + Math.max(0, (box.h - gh) / 2);
        const idx = `iG${++n}`;
        decl.push(`    ${idx} : INT; // gauge ${w.value}`);
        impl.push(`${idx} := REAL_TO_INT(LIMIT(0.0, (ANY_TO_REAL(${w.value}) - (${num(w.min)})) / (${num(w.max - w.min || 1)}), 1.0) * ${GAUGE_STEPS}.0);`);
        const ids: string[] = [];
        for (let k = 0; k <= GAUGE_STEPS; k++) {
          const id = `gauge_${gw}_${k}${w.bands?.length ? `_${bandKey(w.bands)}` : ""}`;
          if (!needed.has(id)) needed.set(id, gaugeSvg(p, k / GAUGE_STEPS, toneAt(w.bands, w.min + (k / GAUGE_STEPS) * (w.max - w.min)), gw, gh));
          ids.push(id);
        }
        const prefix = `gauge_${gw}_`;
        const suffix = w.bands?.length ? `_${bandKey(w.bands)}` : "";
        els.push({ kind: "image", x: r(gx), y: r(gy), w: gw, h: gh, props: { "Static ID": `${pool}.${ids[0]}`, "Bitmap ID variable.Bitmap ID": `CONCAT('${pool}.${prefix}', CONCAT(INT_TO_STRING(${helperName}.${idx}), '${suffix}'))` } });
        const hot = band(w.bands);
        els.push(text(gx, gy + gh * 0.44, gw, gh * 0.2, fmt(w.decimals), [SEMI, Math.max(12, Math.min(28, gw * 0.12))], p.text, "HCENTER", {
          props: { "Text variables.Text variable": real(w.value), ...(hot ? { "Color variables.Toggle color": above(w.value, hot.from), "Text properties.Font alarm color": c(p.tones[hot.tone]) } : {}) },
        }));
        if (w.unit) els.push(text(gx, gy + gh * 0.64, gw, gh * 0.12, w.unit, [FONT, Math.max(8, Math.min(12, gw * 0.055))], p.muted, "HCENTER"));
        els.push(text(gx + gw * 0.08, gy + gh * 0.86, gw * 0.3, gh * 0.12, String(w.min), [FONT, 8], p.muted));
        els.push(text(gx + gw * 0.62, gy + gh * 0.86, gw * 0.3, gh * 0.12, String(w.max), [FONT, 8], p.muted, "RIGHT"));
        break;
      }
      case "bar": {
        const hot = band(w.bands);
        const size = Math.max(16, Math.min(40, box.h * 0.3));
        els.push(text(box.x, box.y, box.w, box.h * 0.5, `${fmt(1)}${w.unit ? ` ${w.unit}` : ""}`, [LIGHT, size], p.text, "LEFT", { props: { "Text variables.Text variable": real(w.value) } }));
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
        const open: string[] = [];
        const rows: (() => void)[] = [];
        w.items.forEach((a, k) => {
          const tone: Tone = a.severity === "info" ? "accent" : a.severity === "warning" ? "warn" : "alarm";
          const y = box.y + k * (rowH + 6);
          const idx = alarmIndex?.[a.active];
          if (idx === undefined) {
            // Not a CODESYS alarm (yet): the row shows while the variable is TRUE.
            open.push(a.active);
            rows.push(() => els.push({ kind: "round", x: r(box.x), y: r(y), w: r(box.w), h: r(rowH), text: `  ${a.text}`, font: [SEMI, 9.5], color: p.tones[tone], align: "LEFT", fill: p.soft[tone], frame: p.tones[tone], radius: 8, invisible: `NOT ${a.active}` }));
            return;
          }
          // A CODESYS alarm: the row stays until it is acknowledged, with its state, time and ACK.
          const al = `__Alm__GVL.g_inst.gen_Inst_AG_HMI_AlarmGroup.gen_ArrAllAlarms[${idx}]`;
          const m = ++n;
          decl.push(`    iAs${m} : INT; // alarm ${a.active}`, `    xAo${m} : BOOL;`, `    xAk${m} : BOOL;`, `    sAs${m} : STRING(24);`, `    sAt${m} : STRING(12);`);
          impl.push(
            `iAs${m} := TO_INT(${al}.m_eState);`,
            `xAo${m} := iAs${m} <> 0;`,
            `xAk${m} := iAs${m} = 2 OR iAs${m} = 3 OR iAs${m} = 5;`,
            `CASE iAs${m} OF 1: sAs${m} := 'pending'; 2: sAs${m} := 'ACTIVE'; 3: sAs${m} := 'cleared - confirm'; 4: sAs${m} := 'acknowledged'; 5: sAs${m} := 'cleared - acknowledge'; ELSE sAs${m} := ''; END_CASE`,
            // m_liTimestampActive is a FILETIME (100 ns since 1601, UTC); m_iOffsetActive the local offset in minutes.
            `IF xAo${m} THEN sAt${m} := RIGHT(DT_TO_STRING(LINT_TO_DT(${al}.m_liTimestampActive / 10000000 - 11644473600 + INT_TO_LINT(${al}.m_iOffsetActive) * 60)), 8); END_IF`,
          );
          open.push(`${helperName}.xAo${m}`);
          rows.push(() => {
            const hide = `NOT ${helperName}.xAo${m}`;
            els.push({ kind: "round", x: r(box.x), y: r(y), w: r(box.w), h: r(rowH), fill: p.soft[tone], frame: p.tones[tone], radius: 8, invisible: hide });
            els.push(text(box.x + 12, y, 70, rowH, "%s", [SEMI, 9], p.muted, "LEFT", { invisible: hide, props: { "Text variables.Text variable": `${helperName}.sAt${m}` } }));
            els.push(text(box.x + 84, y, box.w - 270, rowH, a.text, [SEMI, 9.5], p.tones[tone], "LEFT", { invisible: hide }));
            els.push(text(box.x + box.w - 186, y, 120, rowH, "%s", [SEMI, 8.5], p.tones[tone], "RIGHT", { invisible: hide, props: { "Text variables.Text variable": `${helperName}.sAs${m}` } }));
            els.push({ kind: "round", x: r(box.x + box.w - 58), y: r(y + 4), w: 50, h: r(rowH - 8), text: "ACK", font: [SEMI, 9], color: 0xffffffff, fill: p.tones[tone], frame: p.tones[tone], radius: 6, invisible: `NOT ${helperName}.xAk${m}`, click: `${al}.m_xToAcknowledge := TRUE;` });
          });
        });
        els.push(text(box.x, box.y, box.w, 24, "No active alarms", [FONT, 10], p.tones.ok, "LEFT", { invisible: open.join(" OR ") }));
        rows.forEach((f) => f());
        break;
      }
      case "text":
        els.push(text(box.x, box.y, box.w, box.h, w.text, [FONT, 10.5], p.muted));
        break;
      case "recipe": {
        const prg = `PRG_Recipe_${w.recipe}`;
        els.push(text(box.x, box.y, 60, 22, "Active", [FONT, 9], p.muted));
        els.push(text(box.x + 60, box.y, box.w - 60, 22, "%s", [SEMI, 11], p.tones.accent, "LEFT", { props: { "Text variables.Text variable": `${prg}.sActive` } }));
        const rowH = Math.min(42, (box.h - 30) / w.recipes.length);
        w.recipes.forEach((name, k) => {
          const y = box.y + 30 + k * rowH;
          const bh = Math.min(32, rowH - 6);
          els.push(text(box.x, y, box.w - 170, rowH - 6, name, [SEMI, 10.5], p.text));
          const btn = (x: number, label: string, tone: Argb, code: string): NativeElement => ({ kind: "round", x: r(x), y: r(y), w: 76, h: r(bh), text: label, font: [SEMI, 9.5], color: 0xffffffff, fill: tone, frame: tone, radius: 8, gradient: [tone, darken(tone, 0.18), 90], click: code });
          els.push(btn(box.x + box.w - (w.save ? 160 : 76), "Apply", p.tones.accent, `${prg}.iApply := ${k};`));
          if (w.save) els.push(btn(box.x + box.w - 76, "Save", p.tones.neutral, `${prg}.iSave := ${k};`));
        });
        break;
      }
      case "process": {
        const sx = box.w / 100;
        const sy = box.h / 100;
        const X = (x: number) => box.x + x * sx;
        const Y = (y: number) => box.y + y * sy;
        const items = routed(w.items, box.h / box.w, lib).sort((a, b2) => (a.type === "pipe" ? -1 : 0) - (b2.type === "pipe" ? -1 : 0));
        for (const it of items) processItem(it, X, Y, sx);
        break;
      }
    }
  }

  function processItem(it: ProcessItem, X: (x: number) => number, Y: (y: number) => number, sx: number) {
    const label = (cx: number, y: number, t?: string) => t && els.push(text(cx - 60, y, 120, 18, t, [SEMI, 8.5], p.muted, "HCENTER"));
    switch (it.type) {
      case "symbol": {
        const f = findSymbol(lib, it.symbol);
        if (!f) break;
        const [name, d] = f;
        const rot = it.rotate ?? 0;
        const { w, h } = symbolSize(d, it.size);
        const [vw, vh] = rot % 180 ? [h, w] : [w, h];
        const wpx = Math.max(4, r(vw * sx)), hpx = Math.max(4, r(vh * sx));
        const cx = X(it.x), cy = Y(it.y);
        // One picture per state; the bitmap ID expression picks it (fault wins over on).
        const pic = (state: "off" | "on" | "fault") => {
          const id = `sym_${name}_${state}${rot ? `_r${rot}` : ""}_${wpx}x${hpx}`;
          if (!needed.has(id)) needed.set(id, symbolPicture(d, name, symColors(state), rot, wpx, hpx));
          return `${pool}.${id}`;
        };
        let expr = `'${pic("off")}'`;
        if (it.on) expr = `SEL(${it.on}, ${expr}, '${pic("on")}')`;
        if (it.fault) expr = `SEL(${it.fault}, ${expr}, '${pic("fault")}')`;
        els.push({ kind: "image", x: r(cx - wpx / 2), y: r(cy - hpx / 2), w: wpx, h: hpx, props: { "Static ID": pic("off"), ...(it.on || it.fault ? { "Bitmap ID variable.Bitmap ID": expr } : {}) } });
        if (it.faceplate) els.push({ kind: "rect", x: r(cx - wpx / 2), y: r(cy - hpx / 2), w: wpx, h: hpx, fill: null, frame: null, dialog: { name: dialogFor(it.label ?? name, it.faceplate, it), x: r(cx + wpx / 2 + 10), y: r(cy - 60) } });
        label(cx, cy + hpx / 2 + 2, it.label);
        break;
      }
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
            if (it.flow) flowDashes(X(a1), Y(b1), X(a2), Y(b2), it.flow);
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
        // Images take no clicks (CODESYS asserts on input actions there), so a faceplate opens from a clear area over the symbol.
        const faceDialog = "faceplate" in it && it.faceplate ? { name: dialogFor(it.label ?? it.type, it.faceplate, it), x: r(cx + px / 2 + 10), y: r(cy - 60) } : undefined;
        const face = {};
        if (it.type === "valve") {
          els.push({ kind: "switcher", x: r(cx - px / 2), y: r(cy - px / 2), w: px, h: px, props: { 'Image settings.Image, if "on"': `${pool}.${image(on, px)}`, 'Image settings.Image, if  "off"': `${pool}.${image(off, px)}`, Variable: v }, ...face });
        } else {
          // A turning impeller: a frame counter in the helper program picks the picture while running.
          const frame = `iF${++n}`;
          decl.push(`    ${frame} : INT; // ${it.label ?? it.type} frame`);
          // From the clock, not per cycle: a steady 10 pictures a second whatever the task's interval.
          impl.push(`IF ${v} THEN ${frame} := DINT_TO_INT((TIME_TO_DINT(TIME()) / 100) MOD ${FRAMES}); END_IF`);
          for (let k = 0; k < FRAMES; k++) image(`${it.type}_f${k}`, px);
          const offId = `${pool}.${image(off, px)}`;
          const expr = `SEL(${v}, '${offId}', CONCAT('${pool}.${it.type}_f', CONCAT(INT_TO_STRING(${helperName}.${frame}), '_${px}')))`;
          els.push({ kind: "image", x: r(cx - px / 2), y: r(cy - px / 2), w: px, h: px, props: { "Static ID": offId, "Bitmap ID variable.Bitmap ID": expr }, ...face });
        }
        if (faceDialog) els.push({ kind: "rect", x: r(cx - px / 2), y: r(cy - px / 2), w: px, h: px, fill: null, frame: null, dialog: faceDialog });
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

  /** A faceplate as a dialog visualization; returns its name. */
  function dialogFor(title: string, f: Faceplate, sym: ProcessItem): string {
    const name = `Dlg_${screen.name}_${title.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 60);
    const W = 380;
    const d: NativeElement[] = [];
    let y = 0;
    d.push({ kind: "rect", x: 0, y: 0, w: W, h: 50, fill: p.header[0], frame: null, gradient: [p.header[0], p.header[1], 0] });
    d.push(text(18, 10, W - 90, 30, f.title ?? title, [SEMI, 13], p.headerText));
    d.push({ kind: "round", x: W - 46, y: 10, w: 30, h: 30, text: "x", font: [SEMI, 11], color: p.headerText, fill: p.header[1], frame: null, radius: 8, close_dialog: name });
    y = 64;
    const lamp = (label: string, v: string, tone: Tone, x: number) => {
      d.push({ kind: "circle", x, y: y + 4, w: 14, h: 14, fill: p.track, frame: null, props: { "Color variables.Toggle color": v, "Colors.Alarm state.Fill color": c(p.tones[tone]), "Colors.Alarm state.Frame color": c(p.tones[tone]) } });
      d.push(text(x + 22, y, 120, 22, label, [FONT, 10], p.text));
    };
    const running = sym.type === "pump" || sym.type === "fan" ? sym.running : sym.type === "symbol" ? sym.on : undefined;
    const open = sym.type === "valve" ? sym.open : undefined;
    const fault = sym.type === "pump" || sym.type === "symbol" ? sym.fault : undefined;
    if (running) lamp("Running", running, "ok", 18);
    if (open) lamp("Open", open, "ok", 18);
    if (fault) lamp("Fault", fault, "alarm", 160);
    if (running || open || fault) y += 36;
    if (f.auto) {
      d.push({ kind: "round", x: 18, y, w: 58, h: 30, fill: p.track, frame: null, radius: 15, props: { "Input configuration.Toggle.Variable": f.auto, "Color variables.Toggle color": f.auto, "Colors.Alarm state.Fill color": c(p.tones.ok), "Colors.Alarm state.Frame color": c(p.tones.ok) } });
      d.push({ kind: "circle", x: 21, y: y + 3, w: 24, h: 24, fill: 0xffffffff, frame: null, invisible: f.auto });
      d.push({ kind: "circle", x: 49, y: y + 3, w: 24, h: 24, fill: 0xffffffff, frame: null, invisible: `NOT ${f.auto}` });
      d.push(text(90, y, 200, 30, "Automatic", [FONT, 11], p.text));
      y += 44;
    }
    const btns = [["Start", f.start, "ok"], ["Stop", f.stop, "alarm"], ["Open", f.open, "ok"], ["Close", f.close, "alarm"], ["Reset", f.reset, "warn"]].filter((b) => b[1]) as [string, string, Tone][];
    if (btns.length) {
      const bw = (W - 36 - (btns.length - 1) * 10) / btns.length;
      btns.forEach(([label, v, tone], k) => {
        const col = p.tones[tone];
        d.push({ kind: "round", x: r(18 + k * (bw + 10)), y, w: r(bw), h: 42, text: label, font: [SEMI, 11], color: 0xffffffff, fill: col, frame: col, radius: 10, gradient: [col, darken(col, 0.18), 90], props: { "Input configuration.Tap.Variable": v, "Colors.Alarm state.Fill color": c(darken(col, 0.25)), "Colors.Alarm state.Frame color": c(darken(col, 0.25)) } });
      });
      y += 56;
    }
    for (const x of f.values ?? []) {
      d.push(text(18, y, 200, 24, x.label, [FONT, 10], p.muted));
      d.push(text(W - 178, y, 160, 24, `%.${x.decimals ?? 1}f${x.unit ? ` ${x.unit}` : ""}`, [SEMI, 11], p.text, "RIGHT", { props: { "Text variables.Text variable": real(x.value) } }));
      y += 28;
    }
    if (f.setpoint) {
      const sp = f.setpoint;
      const step = sp.step ?? 1;
      d.push(text(18, y + 4, 200, 24, sp.label ?? "Setpoint", [FONT, 10], p.muted));
      y += 30;
      const b = (x: number, label: string, op: string): NativeElement => ({ kind: "round", x, y, w: 40, h: 40, text: label, font: [SEMI, 14], color: p.text, fill: p.track, frame: p.border, radius: 10, click: `${sp.variable} := LIMIT(${sp.min}, ${sp.variable} ${op} ${step}, ${sp.max});` });
      d.push(b(18, "-", "-"));
      d.push(text(64, y, W - 128, 40, `%.1f${sp.unit ? ` ${sp.unit}` : ""}`, [SEMI, 16], p.text, "HCENTER", { props: { "Text variables.Text variable": real(sp.variable) } }));
      d.push(b(W - 58, "+", "+"));
      y += 52;
    }
    dialogs.push({ name, size: [W, y + 10], background: p.tile, elements: d });
    return name;
  }

  const vars = screenVariables(screen);
  return {
    size: [cv.w, cv.h],
    dialogs,
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

/** Pictures per gauge: one every 2.5 % of the range. */
export const GAUGE_STEPS = 40;

/** The tone of a value by its bands (the last band it reaches), accent without bands. */
function toneAt(bands: { from: number; tone: Tone }[] | undefined, v: number): Tone {
  let t: Tone = "accent";
  for (const b of [...(bands ?? [])].sort((a, b2) => a.from - b2.from)) if (v >= b.from) t = b.tone;
  return t;
}

/** A short key for a band set, so gauges with different bands get their own pictures. */
function bandKey(bands: { from: number; tone: Tone }[]): string {
  let h = 0;
  for (const ch of JSON.stringify(bands)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(36).slice(0, 5);
}

/** The arc gauge of the browser HMI at fraction f of its range (200 x 172 box, drawn at w x h). */
function gaugeSvg(p: Palette, f: number, tone: Tone, w: number, h: number): string {
  const R = 80;
  const pt = (a: number) => [100 + R * Math.sin((a * Math.PI) / 180), 100 - R * Math.cos((a * Math.PI) / 180)].map((v) => Math.round(v * 10) / 10);
  const arc = (a0: number, a1: number) => {
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    return `M${x0} ${y0} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const col = hex(p.tones[tone]);
  const ticks = Array.from({ length: 11 }, (_, i) => {
    const a = ((-120 + i * 24) * Math.PI) / 180;
    const r0 = i % 5 === 0 ? 62 : 66;
    return `<line x1="${(100 + r0 * Math.sin(a)).toFixed(1)}" y1="${(100 - r0 * Math.cos(a)).toFixed(1)}" x2="${(100 + 70 * Math.sin(a)).toFixed(1)}" y2="${(100 - 70 * Math.cos(a)).toFixed(1)}"/>`;
  }).join("");
  const value = f > 0.001 ? `<path d="${arc(-120, -120 + 240 * f)}" fill="none" stroke="${col}" stroke-opacity=".35" stroke-width="22" stroke-linecap="round"/><path d="${arc(-120, -120 + 240 * f)}" fill="none" stroke="${col}" stroke-width="14" stroke-linecap="round"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 200 172"><path d="${arc(-120, 120)}" fill="none" stroke="${hex(p.track)}" stroke-width="14" stroke-linecap="round"/>${value}<g stroke="${hex(p.muted)}" stroke-width="1.5" opacity=".6">${ticks}</g></svg>`;
}

function num(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

function darken(c: Argb, f: number): Argb {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >>> s) & 255) * (1 - f))));
  return ((0xff << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}
