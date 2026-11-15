/**
 * An HMI screen as a native CODESYS visualization: the same layout and design
 * system (theme.ts, icons.ts) as the browser screen, built from CODESYS's own
 * elements, with SVG icons and symbols in an embedded image pool and a small
 * helper program that scales values for bars and tank levels and picks states.
 * The watcher builds it (watcher/mcp_visu.py).
 */
import { darkTextOn } from "./color.js";
import { iconPicture, type IconName } from "./icons.js";
import { ALARM_COUNTERS, buttonIcon, buttonKind, buttonLayout, canvasOf, isTag, lineLayout, machineStates, modeIcon, modeValues, pageIcon, stateButtonFit, stateTextSize, tileBox, type ButtonKind } from "./render.js";
import { routed, itemKey, instrumentTap, labelSpots, lineEnds, nearestOnLine, PUMP_CASING, type LabelSpot } from "./route.js";
import type { Faceplate, ProcessItem, Screen, Tone, Widget } from "./spec.js";
import { hasDock, screenVariables, USER_GROUPS } from "./spec.js";
import { BUILTIN_SYMBOLS, findPictogram, findSymbol, INSTRUMENT_SYMBOLS, pictogramSize, symbolPicture, symbolSize, type SymbolColors, type SymbolLib } from "./symbols.js";
import { PT, softOf, SPACE, textOn, themeFor, TYPE, type ThemeName } from "./theme.js";
import { nameParts, textKey, placeTexts, READING, readingSpot, SIGN, tapY, type PlacedLabel } from "./labels.js";

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
  /** Vertical text alignment (default centred). */
  valign?: "TOP" | "VCENTER" | "BOTTOM";
  /** Wrap the text onto more lines. */
  linebreak?: boolean;
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
  /** Titles and labels. */
  text2: Argb;
  muted: Argb;
  track: Argb;
  /** Borders of controls (outlined buttons). */
  ctl: Argb;
  pipe: Argb;
  /** Equipment's fill: off (grey) and on (bright), and its outline. */
  shell: Argb;
  shellOn: Argb;
  equipLine: Argb;
  equipLineOn: Argb;
  liquid: [Argb, Argb];
  tones: Record<Tone, Argb>;
  soft: Record<Tone, Argb>;
  /** Text on a tone's colour. */
  onTone: Record<Tone, Argb>;
  series: Argb[];
  /** Dark surfaces (symbol bodies and shading follow it). */
  dark: boolean;
}

/** 0xAARRGGBB from '#rrggbb'. */
const argbOf = (h: string): Argb => (0xff000000 | parseInt(h.slice(1), 16)) >>> 0;

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
  return darkTextOn(c & 0xffffff) ? 0xff111820 : 0xffffffff;
}

/** The screen's palette: the design system's theme (theme.ts), with the brand colour as the accent. */
export function paletteFor(screen: { theme?: ThemeName; accent?: string }): Palette {
  const t = themeFor(screen);
  const per = (f: (c: string) => string) => Object.fromEntries(Object.entries(t.tones).map(([k, col]) => [k, argbOf(f(col))])) as Record<Tone, Argb>;
  return {
    dark: t.dark,
    bg: argbOf(t.bg),
    header: [argbOf(t.surface), argbOf(t.surface)],
    headerText: argbOf(t.text),
    tile: argbOf(t.surface),
    tile2: argbOf(t.surface2),
    border: argbOf(t.line),
    text: argbOf(t.text),
    text2: argbOf(t.text2),
    muted: argbOf(t.text3),
    track: argbOf(t.track),
    ctl: argbOf(t.ctl),
    pipe: argbOf(t.pipe),
    shell: argbOf(t.equip),
    shellOn: argbOf(t.equipOn),
    equipLine: argbOf(t.equipLine),
    equipLineOn: argbOf(t.equipLineOn),
    liquid: [argbOf(t.liquid), argbOf(t.liquid)],
    tones: per((x) => x),
    soft: per((x) => softOf(t, x)),
    onTone: per(textOn),
    series: t.series.map(argbOf),
  };
}

const FONT = "Segoe UI";
const SEMI = "Segoe UI Semibold";
const hex = (c: Argb) => `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
const c = (argb: Argb) => ({ argb });
const r = Math.round;

/** Severity order of tones; the visualization shows two colours per element, so the most important band wins. */
function band(bands: { from: number; tone: Tone }[] | undefined): { from: number; tone: Tone } | undefined {
  const rank: Record<Tone, number> = { alarm: 3, warn: 2, ok: 1, accent: 0, neutral: 0 };
  const hot = (bands ?? []).filter((b) => rank[b.tone] >= 2).sort((a, b) => a.from - b.from);
  return hot[0];
}

/**
 * Pictures for the image pool (a 100x100 box drawn at px pixels), drawn from ISO 10628-2: the
 * centrifugal pump (2322), the fan (X8164) and the valve (2101), lines in the text colour,
 * hollow when off and a soft green when on. Outlines are 2 px whatever the size, as in the browser.
 */
export function symbols(p: Palette, px = 100): { id: string; svg: string }[] {
  const u = 100 / px;
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${body}</svg>`;
  const lnOf = (on: boolean) => `stroke="${hex(on ? p.equipLineOn : p.equipLine)}" stroke-width="${2 * u}"`;
  const fill = (on: boolean) => hex(on ? p.shellOn : p.shell);
  const R = 50 * PUMP_CASING - u;
  const k = R * Math.SQRT1_2;
  const pump = (on: boolean) =>
    wrap(`<circle cx="50" cy="50" r="${R}" fill="${fill(on)}" ${lnOf(on)}/>
<path d="M50 ${50 - R}L${50 + R} 50L50 ${50 + R}M${50 - R} 50H${50 + R}" fill="none" ${lnOf(on)} stroke-linejoin="round"/>`);
  const fan = (on: boolean) =>
    wrap(`<circle cx="50" cy="50" r="${50 - u}" fill="${fill(on)}" ${lnOf(on)}/>
<path d="M${50 - k} ${50 - k}L50 50L${50 - k} ${50 + k}M50 50H${100 - u}" fill="none" ${lnOf(on)} stroke-linejoin="round"/>`);
  const valve = (open: boolean) =>
    wrap(`<path d="M${u} 25L50 50L${u} 75ZM${100 - u} 25L50 50L${100 - u} 75Z" fill="${open ? fill(true) : hex(p.equipLine)}" ${lnOf(open)} stroke-linejoin="round"/>`);
  const turn = (svg: string) => svg.replace(/(<svg[^>]*>)([\s\S]*)(<\/svg>)/, '$1<g transform="rotate(90 50 50)">$2</g>$3');
  return [
    { id: "pump_on", svg: pump(true) },
    { id: "pump_off", svg: pump(false) },
    { id: "fan_on", svg: fan(true) },
    { id: "fan_off", svg: fan(false) },
    { id: "valve_open", svg: valve(true) },
    { id: "valve_closed", svg: valve(false) },
    { id: "valve_open_v", svg: turn(valve(true)) },
    { id: "valve_closed_v", svg: turn(valve(false)) },
  ];
}

/**
 * alarmIndex: each HMI alarm's position in the CODESYS alarm group AG_HMI (when the export put
 * them there); those rows then follow CODESYS's alarm states and can be acknowledged.
 */
export function nativePlan(screen: Screen, pages: { name: string; title: string }[] = [], custom: SymbolLib = {}, alarmIndex?: Record<string, number>, languages: string[] = [], alarmTexts: string[] = [], severities: Record<string, string> = {}): NativePlan {
  const p = paletteFor(screen);
  const lib: SymbolLib = { ...BUILTIN_SYMBOLS, ...custom };
  const dark = p.dark;
  // A symbol's colours per state: the body grey off, bright on (a fault shows as a marker beside it).
  const symColors = (state: "off" | "on"): SymbolColors => ({
    state: hex(state === "on" ? p.shellOn : p.shell),
    body: hex(p.tile),
    body2: hex(p.shell),
    line: hex(state === "on" ? p.equipLineOn : p.equipLine),
    accent: hex(p.tones.accent),
  });
  const visu = `Visu_${screen.name}`;
  const pool = `IP_${screen.name}`;
  const helperName = `PRG_HMI_${screen.name}`;
  const els: NativeElement[] = [];
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

  // The design system at this panel size (the same numbers as the browser screen).
  const rail = pages.length > 1;
  const cv = canvasOf(screen, rail);
  const k = cv.k;
  /** CODESYS points for a size in canvas pixels. */
  const ptPx = (px: number) => Math.round(px * PT * 2) / 2;
  type Font = NativeElement["font"];
  const F: Record<"title" | "card" | "body" | "bodyB" | "small" | "smallB" | "tiny" | "tinyB" | "unit", Font> = {
    title: [SEMI, ptPx(TYPE.title * k)],
    card: [SEMI, ptPx(TYPE.card * k)],
    body: [FONT, ptPx(TYPE.body * k)],
    bodyB: [SEMI, ptPx(TYPE.body * k)],
    small: [FONT, ptPx(TYPE.small * k)],
    smallB: [SEMI, ptPx(TYPE.small * k)],
    tiny: [FONT, ptPx(TYPE.tiny * k)],
    tinyB: [SEMI, ptPx(TYPE.tiny * k)],
    unit: [FONT, ptPx(TYPE.unit * k)],
  };
  const R = r(SPACE.radius * k), RS = r(SPACE.radiusS * k);
  /** A line icon as a picture in one colour (the image pool keeps one per icon, size and colour). */
  const icon = (name: IconName, x: number, y: number, px: number, color: Argb, invisible?: string): NativeElement => {
    const s = Math.max(8, r(px));
    const id = `ic_${name}_${s}_${hex(color).slice(1)}`;
    if (!needed.has(id)) needed.set(id, iconPicture(name, s, hex(color)));
    return { kind: "image", x: r(x), y: r(y), w: s, h: s, props: { "Static ID": `${pool}.${id}` }, ...(invisible ? { invisible } : {}) };
  };
  type Input = { tap?: string; toggle?: string; click?: string; goto?: string; dialog?: NativeElement["dialog"]; close_dialog?: string; login?: boolean };
  /**
   * A button as in the browser (render.ts ButtonKind): primary in the accent, secondary
   * outlined, or a state colour; its icon and label centred. A clear shape on top
   * takes the input, so the icon picture never does. Tones name kinds too (neutral: secondary, accent: primary).
   */
  const button = (out: NativeElement[], x: number, y: number, w: number, h: number, label: string, look: ButtonKind | Tone, ic: IconName | undefined, input: Input, iconOnly = false, invisible?: string, font: Font = F.bodyB) => {
    const kind: ButtonKind = look === "neutral" ? "secondary" : look === "accent" ? "primary" : look;
    const secondary = kind === "secondary";
    const fill = secondary ? p.tile : kind === "primary" ? p.tones.accent : p.tones[kind];
    const fg = secondary ? p.text : kind === "primary" ? p.onTone.accent : p.onTone[kind];
    const pressed = secondary ? p.track : darken(fill, 0.14);
    const hold = input.tap ?? input.toggle;
    const hide = invisible ? { invisible } : {};
    out.push({ kind: "round", x: r(x), y: r(y), w: r(w), h: r(h), fill, frame: secondary ? p.ctl : fill, radius: RS, ...hide, ...(hold ? { props: { "Color variables.Toggle color": hold, "Colors.Alarm state.Fill color": c(pressed), "Colors.Alarm state.Frame color": c(secondary ? p.ctl : pressed) } } : {}) });
    const only = iconOnly && !!ic;
    const iw = ic ? 18 * k : 0;
    const tw = only ? 0 : label.length * 7.6 * k;
    const gap = ic && !only ? 8 * k : 0;
    const gx = x + (w - iw - gap - tw) / 2;
    if (ic) out.push(icon(ic, gx, y + (h - iw) / 2, iw, fg, invisible));
    if (!only) out.push(ic ? text(gx + iw + gap - 2, y, tw + 16 * k, h, label, font, fg, "LEFT", hide) : text(x, y, w, h, label, font, fg, "HCENTER", hide));
    const props: NativeElement["props"] = {};
    if (input.tap) props["Input configuration.Tap.Variable"] = input.tap;
    if (input.toggle) props["Input configuration.Toggle.Variable"] = input.toggle;
    out.push({
      kind: "rect", x: r(x), y: r(y), w: r(w), h: r(h), fill: null, frame: null, ...hide,
      ...(Object.keys(props).length ? { props } : {}),
      ...(input.click ? { click: input.click } : {}),
      ...(input.goto ? { goto: input.goto } : {}),
      ...(input.dialog ? { dialog: input.dialog } : {}),
      ...(input.close_dialog ? { close_dialog: input.close_dialog } : {}),
      ...(input.login ? { login: true } : {}),
    });
  };
  /** TRUE while a variable holds a mode option's value. */
  const eqExpr = (v: string, val: string) => (/^true$/i.test(val) ? v : /^false$/i.test(val) ? `NOT ${v}` : `${v} = ${val}`);
  /** A segmented switch (a pill): the option the variable holds is outlined in the accent, its text in the accent. */
  const segmented = (out: NativeElement[], x: number, y: number, w: number, variable: string, options: string[], vals: string[], h = 48 * k) => {
    out.push({ kind: "round", x: r(x), y: r(y), w: r(w), h: r(h), fill: p.tile2, frame: p.border, radius: r(h / 2) });
    const icons = options.every((o) => modeIcon(o));
    const n = options.length;
    const sw = (w - 6 * k - 3 * k * (n - 1)) / n;
    options.forEach((o, i) => {
      const sx = x + 3 * k + i * (sw + 3 * k), sy = y + 3 * k, sh = h - 6 * k;
      const on = eqExpr(variable, vals[i]!);
      out.push({ kind: "round", x: r(sx), y: r(sy), w: r(sw), h: r(sh), fill: p.tile2, frame: p.tile2, lineWidth: Math.max(1, r(1.5 * k)), radius: r(sh / 2), props: { "Color variables.Toggle color": on, "Colors.Alarm state.Fill color": c(p.tile), "Colors.Alarm state.Frame color": c(p.tones.accent) } });
      const ic = icons ? modeIcon(o) : undefined;
      const iw = ic ? 18 * k : 0, gap = ic ? 7 * k : 0, tw = o.length * 7.6 * k;
      const gx = sx + (sw - iw - gap - tw) / 2;
      if (ic) {
        out.push(icon(ic, gx, sy + (sh - iw) / 2, iw, p.text2, on));
        out.push(icon(ic, gx, sy + (sh - iw) / 2, iw, p.tones.accent, `NOT (${on})`));
      }
      out.push(text(ic ? gx + iw + gap - 2 : sx, sy, ic ? tw + 16 * k : sw, sh, o, F.bodyB, p.text2, ic ? "LEFT" : "HCENTER", { props: { "Color variables.Toggle color": on, "Text properties.Font alarm color": c(p.tones.accent) } }));
      out.push({ kind: "rect", x: r(sx), y: r(sy), w: r(sw), h: r(sh), fill: null, frame: null, click: `${variable} := ${vals[i]};` });
    });
    return h;
  };
  /** A sign as a picture (the image pool keeps one per kind and size): the run sign's triangle and square, the condition badges. */
  const sign = (kind: "run" | "stop" | "alarm" | "warning", px: number) => {
    const s0 = Math.max(6, r(px));
    const id = `sign_${kind}_${s0}`;
    if (!needed.has(id)) {
      const body =
        kind === "run" ? `<path d="M10 5L90 50L10 95Z" fill="${hex(p.tones.accent)}"/>`
        : kind === "stop" ? `<rect x="8" y="8" width="84" height="84" rx="8" fill="${hex(p.muted)}"/>`
        : kind === "alarm" ? `<circle cx="50" cy="50" r="48" fill="${hex(p.tones.alarm)}"/><path d="M50 24V56M50 74V75" stroke="${hex(p.onTone.alarm)}" stroke-width="12" stroke-linecap="round"/>`
        : `<path d="M50 6L95 88H5Z" fill="${hex(p.tones.warn)}" stroke="${hex(p.tones.warn)}" stroke-width="8" stroke-linejoin="round"/><path d="M50 38V62M50 76V77" stroke="#1a232d" stroke-width="10" stroke-linecap="round"/>`;
      needed.set(id, `<svg xmlns="http://www.w3.org/2000/svg" width="${s0}" height="${s0}" viewBox="0 0 100 100">${body}</svg>`);
    }
    return { id: `${pool}.${id}`, s: s0 };
  };
  const signAt = (kind: "run" | "stop" | "alarm" | "warning", cx: number, cy: number, px: number, invisible: string): NativeElement => {
    const g = sign(kind, px);
    return { kind: "image", x: r(cx - g.s / 2), y: r(cy - g.s / 2), w: g.s, h: g.s, props: { "Static ID": g.id }, invisible };
  };
  /** The condition badge centred at (x, y), d pixels across: the alarm while `fault`, else the warning while `warning`. */
  const condBadge = (x: number, y: number, d: number, fault?: string, warning?: string) => {
    if (warning) els.push(signAt("warning", x, y, d * 1.1, fault ? `NOT ((${warning}) AND NOT (${fault}))` : `NOT (${warning})`));
    if (fault) els.push(signAt("alarm", x, y, d, `NOT (${fault})`));
  };
  /** The run sign (▶ running, ■ stopped) centred at (x, y). */
  const runSign = (x: number, y: number, px: number, v: string) => {
    els.push(signAt("run", x, y, px, `NOT (${v})`));
    els.push(signAt("stop", x, y, px * 0.85, v));
  };
  /** An ISA-5.1 instrument bubble (radius rr px) with its tag: function letters over the loop number. */
  const bubble = (cx: number, cy: number, rr: number, tag: string) => {
    const [, letters = tag, num0 = ""] = /^([A-Z]+)-?(.*)$/.exec(tag) ?? [];
    els.push({ kind: "circle", x: r(cx - rr), y: r(cy - rr), w: r(2 * rr), h: r(2 * rr), fill: p.tile, frame: p.equipLine, lineWidth: 2 });
    els.push(text(cx - rr, cy - rr * 0.62, 2 * rr, rr * 0.7, letters, [SEMI, ptPx(Math.max(8, rr * 0.55))], p.text, "HCENTER"));
    els.push(text(cx - rr, cy + rr * 0.08, 2 * rr, rr * 0.6, num0, [FONT, ptPx(Math.max(7, rr * 0.45))], p.muted, "HCENTER"));
  };
  /** A reading box beside a bubble (or alone): the value with its unit. */
  const reading = (x: number, cy: number, v: string, decimals: number | undefined, unit: string | undefined, u: number) =>
    els.push({ kind: "round", x: r(x), y: r(cy - (READING.h / 2) * u), w: r(READING.w * u), h: r(READING.h * u), text: `%.${decimals ?? 1}f${unit ? ` ${unit}` : ""}`, font: [SEMI, ptPx(READING.text * u)], color: p.text, align: "HCENTER", fill: p.tile, frame: p.border, radius: r((READING.h / 2) * u), props: { "Text variables.Text variable": real(v) } });
  /** A thin line between two points with one bend (process connection of an instrument). */
  const leader = (ax: number, ay: number, bx: number, by: number, vertFirst: boolean) => {
    const seg = (x1: number, y1: number, x2: number, y2: number) => {
      if (Math.abs(x2 - x1) < 1 && Math.abs(y2 - y1) < 1) return;
      els.push({ kind: "rect", x: r(Math.min(x1, x2) - 1), y: r(Math.min(y1, y2) - 1), w: Math.max(2, r(Math.abs(x2 - x1) + 2)), h: Math.max(2, r(Math.abs(y2 - y1) + 2)), fill: p.equipLine, frame: null });
    };
    if (vertFirst) (seg(ax, ay, ax, by), seg(ax, by, bx, by));
    else (seg(ax, ay, bx, ay), seg(bx, ay, bx, by));
    els.push({ kind: "circle", x: r(ax - 4), y: r(ay - 4), w: 8, h: 8, fill: p.equipLine, frame: null });
  };
  /** A status lamp: a ring that fills in its tone while the expression is TRUE, and its label. */
  const lamp = (out: NativeElement[], x: number, y: number, w: number, label: string, on: string, tone: Tone) => {
    const d = 12 * k;
    out.push({ kind: "circle", x: r(x), y: r(y + 9.5 * k - d / 2), w: r(d), h: r(d), fill: p.tile, frame: p.tones.neutral, lineWidth: Math.max(1, r(2 * k)), props: { "Color variables.Toggle color": on, "Colors.Alarm state.Fill color": c(p.tones[tone]), "Colors.Alarm state.Frame color": c(p.tones[tone]) } });
    out.push(text(x + 22 * k, y, w - 22 * k, 19 * k, label, F.body, p.text2, "LEFT", { props: { "Color variables.Toggle color": on, "Text properties.Font alarm color": c(p.text) } }));
  };
  /** A number right-aligned in room for its range, and its unit after it; returns the number's width. */
  const number = (x: number, y: number, fs: number, v: string, decimals: number | undefined, unit: string | undefined, bands?: { from: number; tone: Tone }[], min?: number, max?: number, color: Argb = p.text): number => {
    const d = decimals ?? 1;
    const widest = [min, max].filter((n): n is number => n !== undefined).map((n) => n.toFixed(d).length).sort((a, b) => b - a)[0] ?? 5 + d;
    const nw = Math.max(3, widest) * fs * 0.56;
    const hot = band(bands);
    // Values in the text colour and the regular weight (as the browser); past a band's limit a dot in its colour after the number (iX: no status colours on text).
    els.push(text(x, y - fs * 0.15, nw, fs * 1.3, `%.${d}f`, [FONT, ptPx(fs)], color, "RIGHT", { props: { "Text variables.Text variable": real(v) } }));
    if (hot) {
      const dd = Math.max(4, r(fs * 0.28));
      els.push({ kind: "circle", x: r(x + nw + 3 * k), y: r(y + fs * 0.05), w: dd, h: dd, fill: p.tones[hot.tone], frame: null, invisible: `NOT ${above(v, hot.from)}` });
    }
    if (unit) els.push(text(x + nw + 6 * k, y + fs * 0.32, 90 * k, fs * 0.72, unit, F.unit, p.muted));
    return nw;
  };
  /** A thin scale: the track, the value's fill (in its band's tone), and the set-point's marker. */
  const scale = (x: number, y: number, w: number, h: number, v: string, min: number, max: number, bands?: { from: number; tone: Tone }[], set?: string) => {
    const len = r(w);
    els.push({ kind: "round", x: r(x), y: r(y), w: len, h: r(h), fill: p.track, frame: null, radius: Math.max(1, r(h / 2)) });
    const hot = band(bands);
    els.push({ kind: "round", x: r(x), y: r(y), w: 1, h: r(h), fill: p.tones.accent, frame: null, radius: Math.max(1, r(h / 2)), props: { "Relative movement.Movement bottom-right.X": pixels(v, min, max, len - 1), ...(hot ? { "Color variables.Toggle color": above(v, hot.from), "Colors.Alarm state.Fill color": c(p.tones[hot.tone]), "Colors.Alarm state.Frame color": c(p.tones[hot.tone]) } : {}) } });
    if (set) {
      const m = pixels(set, min, max, len);
      els.push({ kind: "rect", x: r(x - 1), y: r(y - 4 * k), w: 2, h: r(h + 8 * k), fill: p.text, frame: null, props: { "Relative movement.Movement top-left.X": m, "Relative movement.Movement bottom-right.X": m } });
    }
  };
  const limits = (x: number, y: number, w: number, min: number, max: number) => {
    els.push(text(x, y, w / 2, 14 * k, String(min), F.tiny, p.muted));
    els.push(text(x + w / 2, y, w / 2, 14 * k, String(max), F.tiny, p.muted, "RIGHT"));
  };

  // The top bar: the machine's state in the corner, title, info fields, the alarm counters and Login.
  els.push({ kind: "rect", name: "TopBar", x: 0, y: 0, w: cv.w, h: cv.bar, fill: p.tile, frame: null });
  els.push({ kind: "rect", x: 0, y: cv.bar - 1, w: cv.w, h: 1, fill: p.border, frame: null });
  const m = screen.machine;
  let left = cv.pad;
  if (m) {
    // One state shows at a time (the first whose BOOL is TRUE, else idle): its icon in a ring and a line under the bar in its colour.
    decl.push("    iMachine : INT; // the machine's state: 0 idle, 1.. the states in order");
    impl.push(`${m.states.map((s, j) => `${j ? "ELSIF" : "IF"} ${s.on} THEN iMachine := ${j + 1};`).join(" ")} ELSE iMachine := 0; END_IF`);
    const cw = r(SPACE.corner * k);
    els.push({ kind: "rect", name: "MachineState", x: 0, y: 0, w: cw, h: cv.bar - 1, fill: p.tile2, frame: null });
    els.push({ kind: "rect", x: cw, y: 0, w: 1, h: cv.bar - 1, fill: p.border, frame: null });
    const d = 36 * k, cx = cv.pad, cy = cv.bar / 2 - d / 2, lw = Math.max(1, r(SPACE.stateLine * k));
    machineStates(m).forEach((s, j) => {
      const hide = `${helperName}.iMachine <> ${j}`;
      const col = p.tones[s.tone];
      els.push({ kind: "rect", x: 0, y: cv.bar - lw, w: cv.w, h: lw, fill: col, frame: null, invisible: hide });
      els.push({ kind: "circle", x: r(cx), y: r(cy), w: r(d), h: r(d), fill: p.tile2, frame: col, lineWidth: 2, invisible: hide });
      els.push(icon(s.icon, cx + d / 2 - 10 * k, cy + d / 2 - 10 * k, 20 * k, col, hide));
      els.push(text(cx + d + 12 * k, m.detail ? cv.bar / 2 - 19 * k : cv.bar / 2 - 11 * k, cw - d - 26 * k - cx, 20 * k, s.text, F.bodyB, p.text, "LEFT", { invisible: hide }));
    });
    if (m.detail) els.push(text(cx + d + 12 * k, cv.bar / 2 + 1 * k, cw - d - 26 * k - cx, 16 * k, "%s", F.tiny, p.muted, "LEFT", { props: { "Text variables.Text variable": m.detail } }));
    left = cw + 20 * k;
  }
  const titleW = Math.min(cv.w * 0.4, Math.max(screen.title.length * TYPE.title * 0.56, (screen.subtitle?.length ?? 0) * TYPE.small * 0.52) * k + 8 * k);
  const ty = screen.subtitle ? cv.bar / 2 - 21 * k : cv.bar / 2 - 13 * k;
  els.push(text(left, ty, titleW, 26 * k, screen.title, F.title, p.text));
  if (screen.subtitle) els.push(text(left, ty + 24 * k, titleW, 18 * k, screen.subtitle, F.small, p.muted));
  let fx = left + titleW + 20 * k;
  // Info fields that don't fit before the alarm counters and Login are left out (the browser wraps them away).
  const infoEnd = cv.w - cv.pad - 96 * k - 8 * k - 3 * 50 * k - 16 * k;
  for (const f of screen.info ?? []) {
    const shown = f.value ? `%.${f.decimals ?? 0}f${f.unit ? ` ${f.unit}` : ""}` : (f.text ?? "");
    const fw = Math.max(f.label.length * TYPE.tiny * 0.56, (f.value ? 6 + (f.unit?.length ?? 0) : shown.length) * TYPE.body * 0.6) * k + 32 * k;
    if (fx + fw > infoEnd) break;
    els.push({ kind: "rect", x: r(fx), y: r(cv.bar / 2 - 17 * k), w: 1, h: r(34 * k), fill: p.border, frame: null });
    els.push(text(fx + 16 * k, cv.bar / 2 - 18 * k, fw - 16 * k, 16 * k, f.label, F.tiny, p.muted));
    els.push(text(fx + 16 * k, cv.bar / 2 - 2 * k, fw - 16 * k, 20 * k, shown, F.bodyB, p.text, "LEFT", f.value ? { props: { "Text variables.Text variable": real(f.value) } } : {}));
    fx += fw;
  }
  // No language buttons yet: checked on SP21, VisuElems.VisuFctChangeLanguage runs, but
  // CODESYS doesn't look up texts set by script in the GlobalTextList, so nothing changed.
  void languages;
  const bh = 34 * k, by = cv.bar / 2 - bh / 2;
  let rx = cv.w - cv.pad - 96 * k;
  button(els, rx, by, 96 * k, bh, "Login", "neutral", "login", { login: true });
  const sevOf = new Map<string, string>(Object.entries(severities));
  for (const w of screen.widgets) if (w.type === "alarms") for (const a of w.items) sevOf.set(a.active, a.severity);
  const alarmVars = [...new Set([...Object.keys(alarmIndex ?? {}), ...sevOf.keys()])];
  if (alarmVars.length) {
    // Alarm counters per severity (faults, warnings, messages): grey at zero, the icon in its colour while any is active.
    rx -= 8 * k;
    for (const [sev, ic, label] of [...ALARM_COUNTERS].reverse()) {
      const vars = alarmVars.filter((v) => (sevOf.get(v) ?? "alarm") === sev);
      const name = `iAlarms_${sev}`;
      decl.push(`    ${name} : INT; // active ${label.toLowerCase()}`);
      impl.push(`${name} := ${vars.length ? vars.map((v) => `BOOL_TO_INT(${v})`).join(" + ") : "0"};`);
      const on = `${helperName}.${name} > 0`;
      const cw = 50 * k;
      rx -= cw;
      const col = sev === "alarm" ? p.tones.alarm : sev === "warning" ? p.tones.warn : p.tones.accent;
      els.push(icon(ic, rx, cv.bar / 2 - 9 * k, 18 * k, p.muted, on));
      els.push(icon(ic, rx, cv.bar / 2 - 9 * k, 18 * k, col, `NOT (${on})`));
      els.push(text(rx + 23 * k, by, 26 * k, bh, "%d", F.bodyB, p.muted, "LEFT", { name: `Alarms_${sev}`, props: { "Text variables.Text variable": `${helperName}.${name}`, "Color variables.Toggle color": on, "Text properties.Font alarm color": c(p.text) } }));
    }
  }

  // The bottom bar: the mode at the left, Reset, Start and Stop at the right (Start in the accent, Stop dark).
  if (m && hasDock(screen)) {
    const dy = cv.h - cv.dock;
    els.push({ kind: "rect", name: "Dock", x: cv.rail, y: dy, w: cv.w - cv.rail, h: cv.dock, fill: p.tile, frame: null });
    els.push({ kind: "rect", x: cv.rail, y: dy, w: cv.w - cv.rail, h: 1, fill: p.border, frame: null });
    if (m.mode) segmented(els, cv.rail + cv.pad, dy + cv.dock / 2 - 23 * k, 260 * k, m.mode.variable, m.mode.options, modeValues(m.mode.options, m.mode.values), 46 * k);
    const list = ([["Reset", m.reset, "secondary", "reset"], ["Start", m.start, "primary", "play"], ["Stop", m.stop, "secondary", "stop"]] as [string, string | undefined, ButtonKind, IconName][]).filter((b2) => b2[1]);
    const bw = 132 * k, gap = 10 * k;
    let x = cv.w - cv.pad - list.length * bw - (list.length - 1) * gap;
    for (const [label, v, kind, ic] of list) {
      button(els, x, dy + cv.dock / 2 - 22 * k, bw, 44 * k, label, kind, ic, { tap: v! });
      x += bw + gap;
    }
  }

  // The navigation rail: each page's icon and title, the current one in the accent.
  if (rail) {
    els.push({ kind: "rect", name: "Rail", x: 0, y: cv.bar, w: cv.rail, h: cv.h - cv.bar, fill: p.tile, frame: null });
    els.push({ kind: "rect", x: cv.rail - 1, y: cv.bar, w: 1, h: cv.h - cv.bar, fill: p.border, frame: null });
    const itemH = 58 * k;
    pages.forEach((pg, i) => {
      const cur = pg.name === screen.name;
      const x = 8 * k, y = cv.bar + 10 * k + i * (itemH + 4 * k), w = cv.rail - 16 * k;
      if (cur) {
        els.push({ kind: "round", x: r(x), y: r(y), w: r(w), h: r(itemH), fill: p.soft.accent, frame: null, radius: RS });
        els.push({ kind: "round", x: 0, y: r(y + itemH * 0.22), w: 3, h: r(itemH * 0.56), fill: p.tones.accent, frame: null, radius: 2 });
      }
      const col = cur ? p.tones.accent : p.text2;
      els.push(icon(pageIcon(pg, i), x + w / 2 - 11 * k, y + 10 * k, 22 * k, col));
      // The title on up to two lines that fit the rail (CODESYS centres a wrapped text and cuts what's wider), smaller if a word is too long.
      for (const [j, line, size] of railLines(pg.title, w - 4 * k, TYPE.tiny * k)) els.push(text(x + 2 * k, y + 34 * k + j * size * 1.15, w - 4 * k, size * 1.2, line, [cur ? SEMI : FONT, ptPx(size)], col, "HCENTER"));
      if (!cur) els.push({ kind: "rect", name: `Nav_${pg.name}`, x: r(x), y: r(y), w: r(w), h: r(itemH), fill: null, frame: null, goto: `Visu_${pg.name}` });
    });
  }

  screen.widgets.forEach((wg, i) => {
    const first = els.length;
    const b = tileBox(screen, wg.at, rail);
    els.push({ kind: "round", name: `Tile${i + 1}`, x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h), fill: p.tile, frame: p.border, lineWidth: 1, radius: R });
    const head = !!(wg.title || wg.icon);
    if (head) {
      const hx = b.x + 16 * k, hy = b.y + 14 * k;
      if (wg.icon) els.push(icon(wg.icon, hx, hy + 2 * k, 16 * k, p.muted));
      const tx = hx + (wg.icon ? 24 * k : 0);
      // Small capitals, as in the browser (CSS text-transform).
      if (wg.title) els.push(text(tx, hy, b.x + b.w - 16 * k - tx, 20 * k, wg.title.toUpperCase(), F.tinyB, p.text2));
    }
    // The card's body, as in the browser: 14/16 px padding, 30 px for the title row.
    const box = { x: b.x + 16 * k, y: b.y + 14 * k + (head ? 30 * k : 0), w: b.w - 32 * k, h: b.h - 28 * k - (head ? 30 * k : 0) };
    widget(wg, box);
    // Access rights go on every element of the tile: operating ones turn inoperative, or all hide.
    if (wg.access) {
      const rights = accessRights(wg.access.min, wg.access.below);
      for (let n2 = first; n2 < els.length; n2++) els[n2] = { ...els[n2]!, access: rights };
    }
  });

  function widget(w: Widget, box: { x: number; y: number; w: number; h: number }) {
    switch (w.type) {
      case "value": {
        const sc = w.min !== undefined && w.max !== undefined;
        const fs = Math.max(16 * k, Math.min(TYPE.value * k, box.h * (sc || w.set ? 0.5 : 0.75), box.w / 4.2));
        const lab = w.set ? 20 * k : 0;
        const total = lab + fs + (sc ? 8 * k + 24 * k : 0);
        let y = box.y + Math.max(0, (box.h - total) / 2);
        if (w.set) {
          // Actual and Set side by side, the set value in the text colour and a bit smaller.
          const colW = (box.w - 24 * k) / 2, sx = box.x + colW + 24 * k, sf = fs * 0.72;
          els.push(text(box.x, y, colW, 16 * k, "Actual", F.small, p.text2));
          els.push(text(sx, y, colW, 16 * k, "Set", F.small, p.text2));
          y += lab;
          number(box.x, y, fs, w.value, w.decimals, w.unit, w.bands, w.min, w.max);
          number(sx, y + fs - sf, sf, w.set, w.decimals, w.unit, undefined, w.min, w.max, p.text);
        } else number(box.x, y, fs, w.value, w.decimals, w.unit, w.bands, w.min, w.max);
        y += fs + 8 * k;
        if (sc) {
          scale(box.x, y, box.w, 6 * k, w.value, w.min!, w.max!, w.bands, w.set);
          limits(box.x, y + 10 * k, box.w, w.min!, w.max!);
        }
        break;
      }
      case "gauge": {
        // The browser's half-circle gauge as pictures: one per GAUGE_STEPS of the range, in the
        // band's colour, chosen by the helper program; the value and limits are text on top.
        const s = Math.max(80, Math.min(box.w, box.h * 1.56, 300 * k));
        const gw = r(s), gh = r(s * 0.64);
        const gx = box.x + (box.w - gw) / 2, gy = box.y + Math.max(0, (box.h - gh) / 2);
        const idx = `iG${++n}`;
        decl.push(`    ${idx} : INT; // gauge ${w.value}`);
        impl.push(`${idx} := REAL_TO_INT(LIMIT(0.0, (ANY_TO_REAL(${w.value}) - (${num(w.min)})) / (${num(w.max - w.min || 1)}), 1.0) * ${GAUGE_STEPS}.0);`);
        const suffix = w.bands?.length ? `_${bandKey(w.bands)}` : "";
        const prefix = `gauge_${gw}_`;
        for (let st = 0; st <= GAUGE_STEPS; st++) {
          const id = `${prefix}${st}${suffix}`;
          if (!needed.has(id)) needed.set(id, gaugeSvg(p, st / GAUGE_STEPS, toneAt(w.bands, w.min + (st / GAUGE_STEPS) * (w.max - w.min)), gw, gh));
        }
        els.push({ kind: "image", x: r(gx), y: r(gy), w: gw, h: gh, props: { "Static ID": `${pool}.${prefix}0${suffix}`, "Bitmap ID variable.Bitmap ID": `CONCAT('${pool}.${prefix}', CONCAT(INT_TO_STRING(${helperName}.${idx}), '${suffix}'))` } });
        const u = gw / 200;
        const hot = band(w.bands);
        els.push(text(gx, gy + 84 * u - 22 * u, gw, 44 * u, fmt(w.decimals ?? 0), [FONT, ptPx(30 * u)], p.text, "HCENTER", {
          props: { "Text variables.Text variable": real(w.value) },
        }));
        if (w.unit) els.push(text(gx, gy + 104 * u, gw, 20 * u, w.unit, [FONT, ptPx(14 * u)], p.muted, "HCENTER"));
        els.push(text(gx - 24 * u, gy + 110 * u, 80 * u, 18 * u, String(w.min), [FONT, ptPx(12 * u)], p.muted, "HCENTER"));
        els.push(text(gx + 144 * u, gy + 110 * u, 80 * u, 18 * u, String(w.max), [FONT, ptPx(12 * u)], p.muted, "HCENTER"));
        break;
      }
      case "bar": {
        if (w.vertical) {
          // A vertical bar: the fill rises from the bottom; the reading beside it, at the bottom.
          const bw = 14 * k, len = r(box.h);
          els.push({ kind: "round", x: r(box.x), y: r(box.y), w: r(bw), h: len, fill: p.track, frame: null, radius: r(bw / 2) });
          const hot = band(w.bands);
          els.push({ kind: "rect", x: r(box.x), y: r(box.y + box.h), w: r(bw), h: 1, fill: p.tones.accent, frame: null, props: { "Relative movement.Movement top-left.Y": pixels(w.value, w.min, w.max, len - 1, true), ...(hot ? { "Color variables.Toggle color": above(w.value, hot.from), "Colors.Alarm state.Fill color": c(p.tones[hot.tone]), "Colors.Alarm state.Frame color": c(p.tones[hot.tone]) } : {}) } });
          if (w.set) {
            const m = pixels(w.set, w.min, w.max, len, true);
            els.push({ kind: "rect", x: r(box.x - 4 * k), y: r(box.y + box.h - 1), w: r(bw + 8 * k), h: 2, fill: p.text, frame: null, props: { "Relative movement.Movement top-left.Y": m, "Relative movement.Movement bottom-right.Y": m } });
          }
          const fs = TYPE.valueS * k, x = box.x + bw + 14 * k;
          els.push(text(x, box.y + box.h - 14 * k, box.w - bw - 14 * k, 14 * k, `${w.min} – ${w.max}`, F.tiny, p.muted));
          els.push(text(x, box.y + box.h - 38 * k, box.w - bw - 14 * k, 20 * k, w.unit ?? "", F.unit, p.muted));
          number(x, box.y + box.h - 42 * k - fs, fs, w.value, 1, undefined, w.bands, w.min, w.max);
          break;
        }
        const fs = TYPE.valueS * k;
        const total = fs + 8 * k + 10 * k + 8 * k + 14 * k;
        const y = box.y + Math.max(0, (box.h - total) / 2);
        number(box.x, y, fs, w.value, 1, w.unit, w.bands, w.min, w.max);
        scale(box.x, y + fs + 8 * k, box.w, 10 * k, w.value, w.min, w.max, w.bands, w.set);
        limits(box.x, y + fs + 26 * k, box.w, w.min, w.max);
        break;
      }
      case "status":
        w.items.forEach((it, i) => lamp(els, box.x, box.y + i * 29 * k, box.w, it.label, it.invert ? `NOT ${it.on}` : it.on, it.tone ?? "ok"));
        break;
      case "buttons": {
        const items = w.items.map((i) => ({ ...i, ic: i.icon ?? buttonIcon(i.label) }));
        const layout = buttonLayout(items.map((i) => ({ label: i.label, icon: !!i.ic })), box.w, k);
        const gap = 10 * k;
        const cols = layout === "row" ? items.length : layout === "grid" ? 2 : 1;
        const rows = Math.ceil(items.length / cols);
        const bh = Math.min(44 * k, (box.h - gap * (rows - 1)) / rows);
        const bw = (box.w - gap * (cols - 1)) / cols;
        const y0 = box.y + (box.h - rows * bh - (rows - 1) * gap) / 2;
        items.forEach((it, i) => {
          const x = box.x + (i % cols) * (bw + gap), y = y0 + Math.floor(i / cols) * (bh + gap);
          const input: Input = it.action === "tap" ? { tap: it.variable } : it.action === "toggle" ? { toggle: it.variable } : { click: `${it.variable} := ${it.action === "set" ? "TRUE" : "FALSE"};` };
          button(els, x, y, bw, bh, it.label, buttonKind(it.label, it.tone), it.ic, input);
        });
        break;
      }
      case "switch": {
        const th = 28 * k, tw = 48 * k, y = box.y + box.h / 2 - th / 2;
        els.push({ kind: "round", x: r(box.x), y: r(y), w: r(tw), h: r(th), fill: p.track, frame: null, radius: r(th / 2), props: { "Input configuration.Toggle.Variable": w.variable, "Color variables.Toggle color": w.variable, "Colors.Alarm state.Fill color": c(p.tones.accent), "Colors.Alarm state.Frame color": c(p.tones.accent) } });
        const d = 22 * k;
        els.push({ kind: "circle", x: r(box.x + 3 * k), y: r(y + 3 * k), w: r(d), h: r(d), fill: 0xffffffff, frame: null, invisible: w.variable });
        els.push({ kind: "circle", x: r(box.x + 23 * k), y: r(y + 3 * k), w: r(d), h: r(d), fill: 0xffffffff, frame: null, invisible: `NOT ${w.variable}` });
        els.push(text(box.x + tw + 12 * k, y, box.w - tw - 60 * k, th, w.label ?? "", F.body, p.text));
        els.push(text(box.x + box.w - 48 * k, y, 48 * k, th, "On", F.smallB, p.tones.accent, "RIGHT", { invisible: `NOT ${w.variable}` }));
        els.push(text(box.x + box.w - 48 * k, y, 48 * k, th, "Off", F.smallB, p.muted, "RIGHT", { invisible: w.variable }));
        break;
      }
      case "mode":
        segmented(els, box.x, box.y + box.h / 2 - 24 * k, box.w, w.variable, w.options, modeValues(w.options, w.values));
        break;
      case "state": {
        // The first state whose BOOL is TRUE (else the idle one) shows as a panel in its tone.
        const m = ++n;
        decl.push(`    iSt${m} : INT; // state panel`);
        impl.push(`${w.states.map((s, j) => `${j ? "ELSIF" : "IF"} ${s.on} THEN iSt${m} := ${j + 1};`).join(" ")} ELSE iSt${m} := 0; END_IF`);
        // A calm card: a thin line in the state's colour along the card's top, the icon in a ring, the text in the text colour.
        const fs = stateTextSize([...w.states.map((s) => s.text), w.idle.text], box.w, k);
        const fit = stateButtonFit(box.w, k, w);
        const hasBtns = !!(w.start || w.stop || w.reset);
        const d = 36 * k, rowH = Math.max(d, fs * 2.4), gapB = 14 * k;
        const y0 = box.y + Math.max(0, (box.h - rowH - (hasBtns ? gapB + 44 * k : 0)) / 2);
        const top = box.y - 14 * k - (w.title || w.icon ? 30 * k : 0);
        machineStates(w).forEach((s, j) => {
          const hide = `${helperName}.iSt${m} <> ${j}`;
          const col = p.tones[s.tone];
          els.push({ kind: "rect", x: r(box.x - 16 * k + 2), y: r(top + 1), w: r(box.w + 32 * k - 4), h: Math.max(2, r(3 * k)), fill: col, frame: null, invisible: hide });
          els.push({ kind: "circle", x: r(box.x), y: r(y0 + rowH / 2 - d / 2), w: r(d), h: r(d), fill: p.tile, frame: col, lineWidth: 2, invisible: hide });
          els.push(icon(s.icon, box.x + d / 2 - 10 * k, y0 + rowH / 2 - 10 * k, 20 * k, col, hide));
          els.push(text(box.x + d + 12 * k, y0, box.w - d - 12 * k, rowH, s.text, [SEMI, ptPx(fs)], p.text, "LEFT", { invisible: hide, linebreak: true }));
        });
        if (hasBtns) {
          const y = y0 + rowH + gapB, h = 44 * k, gap = 10 * k;
          const list = [w.start && { label: "Start", v: w.start, kind: "primary" as ButtonKind, ic: "play" as IconName, only: fit.allIcons }, w.stop && { label: "Stop", v: w.stop, kind: "secondary" as ButtonKind, ic: "stop" as IconName, only: fit.allIcons }, w.reset && { label: "Reset", v: w.reset, kind: "secondary" as ButtonKind, ic: "reset" as IconName, only: fit.resetIcon }].filter(Boolean) as { label: string; v: string; kind: ButtonKind; ic: IconName; only: boolean }[];
          // Icon-only Reset keeps a touch-sized square; the others share the rest.
          const fixed = list.filter((b2) => b2.only && b2.kind === "secondary").length;
          const flexW = (box.w - fixed * 44 * k - gap * (list.length - 1)) / (list.length - fixed);
          let x = box.x;
          for (const b2 of list) {
            const bw = b2.only && b2.kind === "secondary" ? 44 * k : flexW;
            button(els, x, y, bw, h, b2.label, b2.kind, b2.ic, { tap: b2.v }, b2.only);
            x += bw + gap;
          }
        }
        break;
      }
      case "setpoint": {
        const step = w.step ?? 1;
        const dec = w.decimals ?? (Number.isInteger(step) ? 0 : String(step).split(".")[1]!.length);
        // With the actual value: it stands large in the accent at the left, the set value with − and + at the right (Koch).
        const total = 16 * k + 6 * k + 44 * k + 6 * k + 14 * k;
        const y0 = box.y + Math.max(0, (box.h - total) / 2);
        // As the browser: the set group (- value +) takes the room it needs, the actual value the rest.
        const colW = w.actual ? Math.min(box.w - 80 * k, 2 * 44 * k + 16 * k + 96 * k) : box.w;
        const actW = box.w - colW - 12 * k;
        const sx0 = box.x + (w.actual ? actW + 12 * k : 0);
        if (w.actual) {
          els.push(text(box.x, y0, actW, 16 * k, "Actual", F.small, p.text2));
          const af = Math.min(TYPE.value * k, actW / 2.8);
          number(box.x, y0 + total - 14 * k - af * 1.1, af, w.actual, w.decimals ?? Math.max(dec, 1), w.unit, undefined, w.min, w.max);
        }
        els.push(text(sx0, y0, colW, 16 * k, "Set", F.small, p.text2));
        const y = y0 + 22 * k, bw = 44 * k;
        const write = (op: string) => `${w.variable} := LIMIT(${w.min}, ${w.variable} ${op} ${step}, ${w.max});`;
        button(els, sx0, y, bw, 44 * k, "−", "secondary", undefined, { click: write("-") }, false, undefined, [FONT, ptPx(20 * k)]);
        const fx2 = sx0 + bw + 8 * k, fw = colW - 2 * bw - 16 * k;
        els.push({ kind: "round", x: r(fx2), y: r(y), w: r(fw), h: r(44 * k), fill: p.tile2, frame: p.border, radius: RS });
        // The value at the design's size, smaller in a narrow field, and without its unit when even that is too tight.
        const digits = Math.max(String(w.min).length, String(w.max).length) + (dec ? dec + 1 : 0);
        let unitW = w.unit ? w.unit.length * 7 * k + 6 * k : 0;
        let fs = Math.min(TYPE.valueS * k, (fw - 8 * k - unitW) / (digits * 0.56));
        if (fs < 14 * k) (unitW = 0), (fs = Math.min(TYPE.valueS * k, (fw - 8 * k) / (digits * 0.56)));
        const nw = digits * fs * 0.56;
        const nx = fx2 + Math.max(4 * k, (fw - nw - unitW) / 2);
        els.push(text(nx, y, nw, 44 * k, `%.${dec}f`, [FONT, ptPx(fs)], p.text, "RIGHT", { props: { "Text variables.Text variable": real(w.variable) } }));
        if (w.unit && unitW) els.push(text(nx + nw + 6 * k, y + 14 * k, unitW + 20 * k, 22 * k, w.unit, F.small, p.muted));
        button(els, sx0 + colW - bw, y, bw, 44 * k, "+", "secondary", undefined, { click: write("+") }, false, undefined, [FONT, ptPx(20 * k)]);
        els.push(text(sx0, y + 50 * k, colW, 14 * k, `${w.min} – ${w.max}${w.unit ? ` ${w.unit}` : ""}`, F.tiny, p.muted, "HCENTER"));
        break;
      }
      case "trend": {
        // No trend element by script: the series' current values, one per row.
        const rowH = 30 * k;
        w.series.forEach((s, i) => {
          const y = box.y + i * rowH;
          els.push({ kind: "round", x: r(box.x), y: r(y + rowH / 2 - 2), w: r(12 * k), h: 3, fill: p.series[i % p.series.length]!, frame: null, radius: 1 });
          els.push(text(box.x + 20 * k, y, box.w * 0.55, rowH, s.label ?? s.value.split(".").pop()!, F.body, p.text2));
          els.push(text(box.x + box.w * 0.55, y, box.w * 0.45, rowH, "%.1f", F.bodyB, p.text, "RIGHT", { props: { "Text variables.Text variable": real(s.value) } }));
          els.push({ kind: "rect", x: r(box.x), y: r(y + rowH - 1), w: r(box.w), h: 1, fill: p.border, frame: null });
        });
        els.push(text(box.x, box.y + box.h - 16 * k, box.w, 16 * k, "The trend chart is in the browser HMI (open_hmi)", F.tiny, p.muted));
        break;
      }
      case "alarms": {
        // Active rows (CODESYS alarms with their time, state and acknowledge), then the last
        // events from the PLC's alarm history (GVL_AlarmHistory, which the export adds).
        // A narrow card (no room for the message beside the time, state and acknowledge) puts the time and state on a second line.
        const narrow = box.w < 366 * k;
        const ROW = (narrow ? 54 : 38) * k, GAP = 0, HROW = 25 * k;
        const histTop = box.y + w.items.length * (ROW + GAP) + 2 * k;
        const room = Math.floor((box.y + box.h - histTop - 34 * k) / HROW);
        const histN = w.history && alarmIndex ? Math.max(0, Math.min(w.history, room)) : 0;
        const open: string[] = [];
        const rows: (() => void)[] = [];
        w.items.forEach((a, i) => {
          const tone: Tone = a.severity === "info" ? "accent" : a.severity === "warning" ? "warn" : "alarm";
          const ic: IconName = a.severity === "info" ? "info" : a.severity === "warning" ? "warning" : "fault";
          const y = box.y + i * (ROW + GAP);
          const idx = alarmIndex?.[a.active];
          const row = (hide: string, timeVar?: string, stateVar?: string, ack?: { show: string; code: string }) => {
            // A plain row: only the icon has the severity's colour, a hairline under it.
            els.push({ kind: "rect", x: r(box.x), y: r(y + ROW - 1), w: r(box.w), h: 1, fill: p.border, frame: null, invisible: hide });
            els.push(icon(ic, box.x + 12 * k, y + (narrow ? 17 * k : ROW / 2) - 9 * k, 18 * k, p.tones[tone], hide));
            let tx = box.x + 40 * k;
            if (narrow) {
              // Two lines: the message, then the time and state small under it.
              const mw = box.x + box.w - (ack ? 46 * k : 8 * k) - tx;
              els.push(text(tx, y + 5 * k, mw, 24 * k, a.text, F.body, p.text, "LEFT", { invisible: hide }));
              if (timeVar) els.push(text(tx, y + 29 * k, 64 * k, 18 * k, "%s", F.tiny, p.text2, "LEFT", { invisible: hide, props: { "Text variables.Text variable": timeVar } }));
              if (stateVar) els.push(text(tx + (timeVar ? 66 * k : 0), y + 29 * k, mw - (timeVar ? 66 * k : 0), 18 * k, "%s", F.tiny, p.text2, "LEFT", { invisible: hide, props: { "Text variables.Text variable": stateVar } }));
              if (ack) button(els, box.x + box.w - 42 * k, y + (ROW - 36 * k) / 2, 36 * k, 36 * k, "Acknowledge", "neutral", "check", { click: ack.code }, true, ack.show);
              return;
            }
            if (timeVar) {
              els.push(text(tx, y, 64 * k, ROW, "%s", F.small, p.text2, "LEFT", { invisible: hide, props: { "Text variables.Text variable": timeVar } }));
              tx += 68 * k;
            }
            const right = (ack ? 46 * k : 8 * k) + (stateVar ? 92 * k : 0);
            els.push(text(tx, y, box.x + box.w - right - tx, ROW, a.text, F.body, p.text, "LEFT", { invisible: hide, linebreak: true }));
            if (stateVar) els.push(text(box.x + box.w - right, y, 84 * k, ROW, "%s", F.tiny, p.text2, "RIGHT", { invisible: hide, props: { "Text variables.Text variable": stateVar } }));
            if (ack) button(els, box.x + box.w - 42 * k, y + 4 * k, 36 * k, ROW - 8 * k, "Acknowledge", "neutral", "check", { click: ack.code }, true, ack.show);
          };
          if (idx === undefined) {
            // Not a CODESYS alarm (yet): the row shows while the variable is TRUE.
            open.push(a.active);
            rows.push(() => row(`NOT ${a.active}`));
            return;
          }
          // A CODESYS alarm: the row stays until it is acknowledged, with its state, time and acknowledge.
          const al = `__Alm__GVL.g_inst.gen_Inst_AG_HMI_AlarmGroup.gen_ArrAllAlarms[${idx}]`;
          const m = ++n;
          decl.push(`    iAs${m} : INT; // alarm ${a.active}`, `    xAo${m} : BOOL;`, `    xAk${m} : BOOL;`, `    sAs${m} : STRING(24);`, `    sAt${m} : STRING(12);`);
          impl.push(
            `iAs${m} := TO_INT(${al}.m_eState);`,
            `xAo${m} := iAs${m} <> 0;`,
            `xAk${m} := iAs${m} = 2 OR iAs${m} = 3 OR iAs${m} = 5;`,
            `CASE iAs${m} OF 1: sAs${m} := 'pending'; 2: sAs${m} := 'active'; 3: sAs${m} := 'cleared'; 4: sAs${m} := 'acknowledged'; 5: sAs${m} := 'cleared'; ELSE sAs${m} := ''; END_CASE`,
            // m_liTimestampActive is a FILETIME (100 ns since 1601, UTC); m_iOffsetActive the local offset in minutes.
            `IF xAo${m} THEN sAt${m} := RIGHT(DT_TO_STRING(LINT_TO_DT(${al}.m_liTimestampActive / 10000000 - 11644473600 + INT_TO_LINT(${al}.m_iOffsetActive) * 60)), 8); END_IF`,
          );
          open.push(`${helperName}.xAo${m}`);
          rows.push(() => row(`NOT ${helperName}.xAo${m}`, `${helperName}.sAt${m}`, `${helperName}.sAs${m}`, { show: `NOT ${helperName}.xAk${m}`, code: `${al}.m_xToAcknowledge := TRUE;` }));
        });
        const none = open.join(" OR ");
        els.push(icon("check", box.x, box.y + 10 * k, 18 * k, p.tones.ok, none));
        els.push(text(box.x + 26 * k, box.y, box.w - 26 * k, ROW, "No active alarms", F.body, p.text2, "LEFT", { invisible: none }));
        rows.forEach((f) => f());
        if (histN) {
          els.push({ kind: "rect", x: r(box.x), y: r(histTop + 8 * k), w: r(box.w), h: 1, fill: p.border, frame: null });
          els.push(text(box.x, histTop + 12 * k, box.w, 18 * k, "History", F.smallB, p.text2));
          // The message of an event: the HMI's alarms are AG_HMI's alarms 1..n, in this order.
          const msgs = alarmTexts.map((t, j) => `IF GVL_AlarmHistory.aEvents[iHi].sGroup = 'AG_HMI' AND GVL_AlarmHistory.aEvents[iHi].sAlarm = '${j + 1}' THEN sHx := '${t.replace(/'/g, "$$'").slice(0, 78)}'; END_IF`);
          for (let rr = 0; rr < histN; rr++) {
            const m = ++n;
            decl.push(`    xHv${m} : BOOL; // history row ${rr + 1}`, `    sHt${m} : STRING(12);`, `    sHx${m} : STRING(80);`, `    sHs${m} : STRING(16);`);
            if (rr === 0) decl.push("    iHi : INT;", "    sHx : STRING(80);");
            impl.push(
              `iHi := GVL_AlarmHistory.iNext - 1 - ${rr};`,
              "IF iHi < 0 THEN iHi := iHi + GVL_AlarmHistory.iSize; END_IF",
              `xHv${m} := ${rr} < GVL_AlarmHistory.iCount;`,
              `IF xHv${m} THEN`,
              `    sHt${m} := RIGHT(DT_TO_STRING(GVL_AlarmHistory.aEvents[iHi].dtTime), 8);`,
              "    sHx := CONCAT(CONCAT(GVL_AlarmHistory.aEvents[iHi].sGroup, '/'), GVL_AlarmHistory.aEvents[iHi].sAlarm);",
              ...msgs.map((x) => `    ${x}`),
              `    sHx${m} := sHx;`,
              `    CASE GVL_AlarmHistory.aEvents[iHi].iState OF 0: sHs${m} := 'normal'; 1: sHs${m} := 'pending'; 2: sHs${m} := 'active'; 3, 5: sHs${m} := 'cleared'; 4: sHs${m} := 'acknowledged'; ELSE sHs${m} := ''; END_CASE`,
              "END_IF",
            );
            const y = histTop + 34 * k + rr * HROW;
            const hide = `NOT ${helperName}.xHv${m}`;
            els.push(text(box.x, y, 64 * k, HROW, "%s", F.small, p.muted, "LEFT", { invisible: hide, props: { "Text variables.Text variable": `${helperName}.sHt${m}` } }));
            els.push(text(box.x + 68 * k, y, box.w - 190 * k, HROW, "%s", F.small, p.text, "LEFT", { invisible: hide, props: { "Text variables.Text variable": `${helperName}.sHx${m}` } }));
            els.push(text(box.x + box.w - 120 * k, y, 120 * k, HROW, "%s", F.small, p.muted, "RIGHT", { invisible: hide, props: { "Text variables.Text variable": `${helperName}.sHs${m}` } }));
            if (rr < histN - 1) els.push({ kind: "rect", x: r(box.x), y: r(y + HROW - 1), w: r(box.w), h: 1, fill: p.border, frame: null, invisible: hide });
          }
        }
        break;
      }
      case "text":
        els.push(text(box.x, box.y, box.w, box.h, w.text, F.body, p.text2, "LEFT", { valign: "TOP", linebreak: true }));
        break;
      case "recipe": {
        const prg = `PRG_Recipe_${w.recipe}`;
        els.push(text(box.x, box.y, 52 * k, 20 * k, "Active", F.small, p.text2));
        els.push(text(box.x + 52 * k, box.y, box.w - 52 * k, 20 * k, "%s", F.bodyB, p.tones.accent, "LEFT", { props: { "Text variables.Text variable": `${prg}.sActive` } }));
        const rowH = 44 * k;
        w.recipes.forEach((name, j) => {
          const y = box.y + 24 * k + j * rowH;
          const bh2 = 32 * k, by2 = y + (rowH - bh2) / 2;
          const bw2 = 64 * k;
          els.push(text(box.x, y, box.w - (w.save ? 2 * bw2 + 16 * k : bw2 + 8 * k), rowH, name, F.bodyB, p.text));
          button(els, box.x + box.w - (w.save ? 2 * bw2 + 8 * k : bw2), by2, bw2, bh2, "Apply", "accent", undefined, { click: `${prg}.iApply := ${j};` }, false, undefined, F.smallB);
          if (w.save) button(els, box.x + box.w - bw2, by2, bw2, bh2, "Save", "neutral", undefined, { click: `${prg}.iSave := ${j};` }, false, undefined, F.smallB);
          if (j < w.recipes.length - 1) els.push({ kind: "rect", x: r(box.x), y: r(y + rowH - 1), w: r(box.w), h: 1, fill: p.border, frame: null });
        });
        break;
      }
      case "line": {
        // As in the browser (render.ts lineHtml and its CSS): the product path, the feeds, then the tiles over them.
        const L = lineLayout(w, box.w, box.h, k);
        const lw = Math.max(2, r(3 * k));
        const py = box.y + L.pathY, end = box.x + box.w - 2 * k;
        els.push({ kind: "rect", x: r(box.x), y: r(py - lw / 2), w: r(end - box.x - 8 * k), h: lw, fill: p.pipe, frame: null });
        els.push(arrow(end, py, 1, 0, 9 * k, 5 * k, p.pipe));
        w.stations.forEach((s, j) => {
          if (s.feed) els.push({ kind: "rect", x: r(box.x + L.xs[j]! + L.tw / 2 - lw / 2), y: r(box.y + L.fy + L.fh), w: lw, h: r(L.conn), fill: p.pipe, frame: null });
        });
        type St = (typeof w.stations)[number];
        const tile = (s: St, x: number, y: number, h: number, small: boolean) => {
          const tw = L.tw, cx = x + tw / 2, edge = Math.max(2, r(3 * k));
          els.push({ kind: "round", x: r(x), y: r(y), w: r(tw), h: r(h), fill: p.tile2, frame: p.border, lineWidth: 1, radius: Math.max(1, r(3 * k)) });
          // The top edge shows the condition: neutral, amber on a warning, red on an alarm (the alarm wins).
          els.push({ kind: "rect", x: r(x), y: r(y), w: r(tw), h: edge, fill: p.ctl, frame: null });
          if (s.warning) els.push({ kind: "rect", x: r(x), y: r(y), w: r(tw), h: edge, fill: p.tones.warn, frame: null, invisible: `NOT (${s.warning})` });
          if (s.fault) els.push({ kind: "rect", x: r(x), y: r(y), w: r(tw), h: edge, fill: p.tones.alarm, frame: null, invisible: `NOT (${s.fault})` });
          const pad = (small ? 5 : 8) * k;
          // The contents centred in the tile, as the browser's flex column (name, tag, pictogram, value).
          const content = small ? 45 * k : (s.tag ? 98 : 86) * k;
          let ty = y + edge + pad + Math.max(0, (h - edge - pad - (small ? 5 : 7) * k - 1 - content) / 2);
          // The name line: the run sign (driven equipment), the name, the mode hand, centred together.
          const valveS = /valve/i.test(s.symbol ?? "");
          const runV = s.on && !valveS ? s.on : undefined;
          const nameW = s.name.length * TYPE.small * k * 0.68;
          const lead = runV ? 14 * k : 0, tail = s.manual ? 19 * k : 0;
          const nx0 = cx - (lead + nameW + tail) / 2, ncy = ty + 8 * k;
          if (runV) runSign(nx0 + 5 * k, ncy, 10 * k, runV);
          els.push(text(nx0 + lead - 2 * k, ty, nameW + 8 * k, 16 * k, s.name.toUpperCase(), F.smallB, p.text, "LEFT"));
          if (s.manual) els.push(icon("manual", nx0 + lead + nameW + 4 * k, ncy - 7.5 * k, 15 * k, p.tones.accent, `NOT (${s.manual})`));
          ty += 17 * k;
          if (s.tag && !small) {
            els.push(text(x + 4 * k, ty - 2 * k, tw - 8 * k, 14 * k, s.tag, F.tiny, p.muted, "HCENTER"));
            ty += 12 * k;
          }
          const ph = (small ? 24 : 38) * k;
          ty += (small ? 2 : 4) * k;
          const f = findPictogram(lib, s.symbol);
          if (f) {
            const [name, d] = f;
            const sz = pictogramSize(d, ph);
            const wpx = Math.max(4, r(sz.w)), hpx = Math.max(4, r(sz.h));
            const pic = (state: "off" | "on") => {
              const id = `stn_${name}_${s.on ? state : "nostat"}_${wpx}x${hpx}`;
              const closed = /valve/i.test(name) && state === "off" && !!s.on;
              if (!needed.has(id)) needed.set(id, symbolPicture(d, name, closed ? { ...symColors("off"), state: hex(p.equipLine) } : { ...symColors(state), state: hex(p.tile) }, 0, wpx, hpx));
              return `${pool}.${id}`;
            };
            els.push({ kind: "image", x: r(cx - wpx / 2), y: r(ty + ph / 2 - hpx / 2), w: wpx, h: hpx, props: { "Static ID": pic("off"), ...(s.on ? { "Bitmap ID variable.Bitmap ID": `SEL(${s.on}, '${pic("off")}', '${pic("on")}')` } : {}) } });
          }
          ty += ph + 3 * k;
          if (s.value && !small) {
            // The number and its smaller unit, centred together (the number's width estimated from its decimals).
            const fs = 18 * k, d = s.decimals ?? 1;
            const nw = (4 + (d ? d + 1 : 0)) * fs * 0.55, uw = s.unit ? s.unit.length * TYPE.tiny * k * 0.6 + 3 * k : 0;
            const nx = cx - (nw + uw) / 2;
            els.push(text(nx - 20 * k, ty, nw + 20 * k, 24 * k, `%.${d}f`, [FONT, ptPx(fs)], p.text, "RIGHT", { props: { "Text variables.Text variable": real(s.value) } }));
            if (s.unit) els.push(text(nx + nw + 3 * k, ty + 6 * k, uw + 20 * k, 16 * k, s.unit, F.tiny, p.muted));
          }
          condBadge(x + tw - 14 * k, y + 15 * k, 18 * k, s.fault, s.warning);
          if (s.screen) els.push({ kind: "rect", name: `Station_${s.screen}_${j2++}`, x: r(x), y: r(y), w: r(tw), h: r(h), fill: null, frame: null, goto: `Visu_${s.screen}` });
        };
        let j2 = 1;
        w.stations.forEach((s, j) => {
          tile(s, box.x + L.xs[j]!, box.y + L.y, L.th, false);
          if (s.feed) tile(s.feed, box.x + L.xs[j]!, box.y + L.fy, L.fh, true);
        });
        break;
      }
      case "process": {
        const sx = box.w / 100;
        const sy = box.h / 100;
        const X = (x: number) => box.x + x * sx;
        const Y = (y: number) => box.y + y * sy;
        const aspect = box.h / box.w;
        const ends = lineEnds(w.items);
        const all = routed(w.items, aspect, lib);
        // Every text's place, clear of the rest (labels.ts, as in the browser); in x-units, a hundredth of the width.
        const placed = placeTexts(all, aspect, lib, ends);
        const items = [...all].sort((a, b2) => (a.type === "pipe" ? -1 : 0) - (b2.type === "pipe" ? -1 : 0));
        for (const it of items) processItem(it, X, Y, sx, placed.labels, all, aspect);
        // Line names at the diagram's edge (1.9 units, as the browser), each with a flow arrow on the line near its free end.
        const lf: Font = [SEMI, ptPx(1.9 * sx)], lh = 2.6 * sx, lw2 = 24 * sx;
        all.forEach((it, k) => {
          const e = ends[k];
          if (it.type !== "pipe" || !e || !it.points?.length) return;
          const [x, y] = e.at === "start" ? it.points[0]! : it.points[it.points.length - 1]!;
          const px = X(x), py = Y(y);
          {
            const pts = it.points;
            const [a, b2] = e.at === "start" ? [pts[0]!, pts[1] ?? pts[0]!] : [pts[pts.length - 2] ?? pts[0]!, pts[pts.length - 1]!];
            const ux = X(b2[0]) - X(a[0]), uy = Y(b2[1]) - Y(a[1]);
            // Pipes run at right angles: the arrow takes the segment's main direction.
            const [dx, dy] = Math.abs(ux) >= Math.abs(uy) ? [Math.sign(ux) || 1, 0] : [0, Math.sign(uy) || 1];
            const [tx, ty] = e.at === "start" ? [X(a[0]) + dx * 3.2 * sx, Y(a[1]) + dy * 3.2 * sx] : [X(b2[0]) - dx * 0.4 * sx, Y(b2[1]) - dy * 0.4 * sx];
            els.push(arrow(tx, ty, dx, dy, 1.8 * sx, 0.95 * sx, p.muted));
          }
          // Top and bottom first (a corner point on the top line is a top end), then left and right.
          const top = y <= 1 || (y <= 5 && x > 5 && x < 95), bottom = y >= 99 || (y >= 95 && x > 5 && x < 95);
          // Where placeTexts put it (as in the browser): its anchor point and centre line.
          void top, void bottom;
          const pl = placed.lines.get(k)!;
          const lx = box.x + pl.x * sx, ly = box.y + pl.y * sx - lh / 2;
          els.push(pl.anchor === "start" ? text(lx, ly, lw2, lh, e.label, lf, p.muted, "LEFT") : text(lx - lw2, ly, lw2, lh, e.label, lf, p.muted, "RIGHT"));
        });
        break;
      }
    }
  }

  function processItem(it: ProcessItem, X: (x: number) => number, Y: (y: number) => number, sx: number, placed: Map<string, PlacedLabel> = new Map(), all: ProcessItem[] = [], aspect = 0.5) {
    // The label's place (labels.ts placeTexts, as in the browser), in x-units from the diagram's corner.
    const pl = placed.get(textKey(it));
    const spot = undefined as { side: string; x: number } | undefined;
    const ox = X(0), oy = Y(0);
    // Sizes in diagram units, as the browser's SVG (1 unit = sx pixels).
    const LF: Font = [SEMI, ptPx(1.75 * sx)], LH = 2.4 * sx, LW = Math.max(120, 22 * sx), HW = LW / 2;
    const label = (cx: number, y: number, t?: string, bx?: { x0: number; x1: number; y0: number; cy: number }) => {
      if (pl) {
        // The name line, as the browser: the run sign, the name, the mode hand.
        const parts = nameParts(it);
        const ly = oy + pl.y * sx;
        if (parts.run) runSign(ox + (pl.x0 + SIGN.run / 2) * sx, ly, SIGN.run * 1.15 * sx, parts.run);
        if (t) els.push(text(ox + pl.textX * sx, ly - LH / 2, LW, LH, t, LF, p.muted, "LEFT"));
        if (parts.manual) els.push(icon("manual", ox + (pl.textEnd + 0.5) * sx, ly - (SIGN.hand / 2) * sx, SIGN.hand * sx, p.tones.accent, `NOT (${parts.manual})`));
        // The equipment's own value under the name, as plain text.
        if (parts.value) {
          const d = "decimals" in it ? (it.decimals ?? 1) : 1, u = "unit" in it ? it.unit : undefined;
          els.push(text(ox + pl.x0 * sx, oy + pl.valueY * sx - 1.2 * sx, LW, 2.4 * sx, `%.${d}f${u ? ` ${u}` : ""}`, [SEMI, ptPx(1.8 * sx)], p.text, "LEFT", { props: { "Text variables.Text variable": real(parts.value) } }));
        }
        return;
      }
      if (!t) return;
      if (spot?.side === "below-left") els.push(text(X(spot.x) - 1.4 * sx - LW, y, LW, LH, t, LF, p.muted, "RIGHT"));
      else if (spot?.side === "below-right") els.push(text(X(spot.x) + 1.4 * sx, y, LW, LH, t, LF, p.muted, "LEFT"));
      else if (spot?.side === "beside" && bx) els.push(bx.x1 > X(85) ? text(cx - HW, bx.y0 - 0.6 * sx - LH, LW, LH, t, LF, p.muted, "HCENTER") : text(bx.x1 + 1 * sx, bx.cy - LH / 2, LW, LH, t, LF, p.muted, "LEFT"));
      else if (spot?.side === "above" && bx) els.push(text(cx - HW, bx.y0 - 0.6 * sx - LH, LW, LH, t, LF, p.muted, "HCENTER"));
      else els.push(text(cx - HW, y, LW, LH, t, LF, p.muted, "HCENTER"));
    };
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
        const pic = (state: "off" | "on") => {
          const id = `sym_${name}_${state}${rot ? `_r${rot}` : ""}_${wpx}x${hpx}`;
          // A valve is filled in the line colour while closed (as on a P&ID).
          const closed = /valve/i.test(name) && state === "off" && !!it.on;
          if (!needed.has(id)) needed.set(id, symbolPicture(d, name, closed ? { ...symColors("off"), state: hex(p.equipLine) } : symColors(state), rot, wpx, hpx));
          return `${pool}.${id}`;
        };
        let expr = `'${pic("off")}'`;
        if (it.on) expr = `SEL(${it.on}, ${expr}, '${pic("on")}')`;
        els.push({ kind: "image", x: r(cx - wpx / 2), y: r(cy - hpx / 2), w: wpx, h: hpx, props: { "Static ID": pic("off"), ...(it.on ? { "Bitmap ID variable.Bitmap ID": expr } : {}) } });
        condBadge(cx + wpx / 2 + 0.3 * sx, cy - hpx / 2 - 0.3 * sx, 2.4 * sx, it.fault, it.warning);
        const inst = INSTRUMENT_SYMBOLS[name];
        if (inst) {
          bubble(cx, cy, Math.min(wpx, hpx) * 0.4, isTag(it.label) ? it.label! : inst);
          break;
        }
        if (it.faceplate) els.push({ kind: "rect", x: r(cx - wpx / 2), y: r(cy - hpx / 2), w: wpx, h: hpx, fill: null, frame: null, dialog: { name: dialogFor(it.label ?? name, it.faceplate, it), x: r(cx + wpx / 2 + 10), y: r(cy - 60) } });
        label(cx, cy + hpx / 2 + 0.8 * sx, it.label, { x0: cx - wpx / 2, x1: cx + wpx / 2, y0: cy - hpx / 2, cy });
        break;
      }
      case "pipe": {
        const pts = it.points ?? [];
        if (it.signal) {
          // An instrument signal: thin dashes.
          for (let k = 1; k < pts.length; k++) {
            const [x1, y1] = [X(pts[k - 1]![0]), Y(pts[k - 1]![1])];
            const [x2, y2] = [X(pts[k]![0]), Y(pts[k]![1])];
            const len = Math.hypot(x2 - x1, y2 - y1);
            for (let d = 0; d < len; d += 9) {
              const t0 = d / len, t1 = Math.min(1, (d + 5) / len);
              const [ax, ay, bx, by] = [x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0, x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1];
              els.push({ kind: "rect", x: r(Math.min(ax, bx) - 1), y: r(Math.min(ay, by) - 1), w: r(Math.abs(bx - ax) + 2), h: r(Math.abs(by - ay) + 2), fill: p.muted, frame: null });
            }
          }
          break;
        }
        const th = 4;
        for (let k = 1; k < pts.length; k++) {
          const [x1, y1] = pts[k - 1]!;
          const [x2, y2] = pts[k]!;
          const segs: [number, number, number, number][] = x1 === x2 || y1 === y2 ? [[x1, y1, x2, y2]] : [[x1, y1, x2, y1], [x2, y1, x2, y2]];
          for (const [a1, b1, a2, b2] of segs) {
            const x = Math.min(X(a1), X(a2)) - th / 2, y = Math.min(Y(b1), Y(b2)) - th / 2;
            els.push({ kind: "round", x: r(x), y: r(y), w: r(Math.abs(X(a2) - X(a1)) + th), h: r(Math.abs(Y(b2) - Y(b1)) + th), fill: p.pipe, frame: null, ...(it.flow ? { props: { "Color variables.Toggle color": it.flow, "Colors.Alarm state.Fill color": c(p.equipLine), "Colors.Alarm state.Frame color": c(p.equipLine) } } : {}) });
          }
        }
        break;
      }
      case "tank": {
        const x = X(it.x), y = Y(it.y), w = it.w * sx, h = Y(it.y + it.h) - y;
        // A vessel with rounded ends (CODESYS has no dished end: a radius stands in), the level a flat fill.
        const rad = r(Math.min(w * 0.3, h * 0.15));
        els.push({ kind: "round", x: r(x), y: r(y), w: r(w), h: r(h), fill: p.tile, frame: null, radius: rad });
        els.push({ kind: "rect", x: r(x + 2), y: r(y + h - rad / 2), w: r(w - 4), h: 1, fill: p.liquid[0], frame: null, props: { "Relative movement.Movement top-left.Y": pixels(it.level, 0, it.max, r(h - rad), true) } });
        els.push({ kind: "round", x: r(x), y: r(y), w: r(w), h: r(h), fill: null, frame: p.equipLine, lineWidth: 2, radius: rad });
        els.push(text(x, y + h / 2 - 2.2 * sx, w, 4.4 * sx, `%.0f${it.unit ? ` ${it.unit}` : ""}`, [SEMI, ptPx(3.2 * sx)], p.text, "HCENTER", { props: { "Text variables.Text variable": real(it.level) } }));
        label(x + w / 2, y + h + 1 * sx, it.label);
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
          // The run state is the sign by the name (no fill, no turning impeller).
          const offId = `${pool}.${image(off, px)}`;
          els.push({ kind: "image", x: r(cx - px / 2), y: r(cy - px / 2), w: px, h: px, props: { "Static ID": offId, "Bitmap ID variable.Bitmap ID": `SEL(${v}, '${offId}', '${pool}.${image(on, px)}')` }, ...face });
        }
        // The condition badge at the item's corner, as the browser.
        const rc = it.type === "pump" ? (px / 2) * PUMP_CASING : px / 2;
        if (it.type === "valve") condBadge(cx + (it.vertical ? px / 4 : px / 2), cy - (it.vertical ? px / 2 : px / 4) - 0.4 * sx, 2.4 * sx, it.fault, it.warning);
        else condBadge(cx + rc * 0.85, cy - rc * 0.85, 2.4 * sx, it.fault, it.warning);
        if (faceDialog) els.push({ kind: "rect", x: r(cx - px / 2), y: r(cy - px / 2), w: px, h: px, fill: null, frame: null, dialog: faceDialog });
        label(cx, cy + size / 2 + 0.8 * sx, it.label);
        break;
      }
      case "instrument":
      case "sensor": {
        // ISA-5.1, as in the browser: the bubble with its tag, the process connection, the reading beside it.
        const cx = X(it.x), cy = Y(it.y), rr = 3.3 * sx;
        const tag = it.type === "instrument" ? it.tag : it.label;
        const v = it.value;
        if (it.type === "sensor" && !isTag(tag)) {
          // Not an instrument: a plain reading with its label above.
          const at = nearestOnLine(all, it.x, it.y, aspect, 9);
          if (at) leader(X(at[0]), Y(at[1]), cx, cy + (Y(at[1]) < cy ? -15 : 15), true);
          reading(cx - (READING.w / 2) * sx, cy, it.value, it.decimals, it.unit, sx);
          if (it.label) els.push(text(cx - HW, cy - 2.8 * sx - LH * 0.8, LW, LH, it.label, LF, p.muted, "HCENTER"));
          break;
        }
        const tap = it.type === "instrument" ? instrumentTap(it, all, aspect, lib) : (() => { const at = nearestOnLine(all, it.x, it.y, aspect, 9); return at ? { at, dir: "u" as const } : undefined; })();
        if (tap) {
          const [tx, ty] = [X(tap.at[0]), Y(tap.at[1])];
          const vertical = tap.dir === "u" || tap.dir === "d" || Math.abs(ty - cy) > rr;
          if (vertical) leader(tx, ty, Math.abs(tx - cx) < 2 ? tx : cx + (tx < cx ? -rr : rr), Math.abs(tx - cx) < 2 ? cy + (ty < cy ? -rr : rr) : cy, true);
          else leader(tx, ty, cx + (tx < cx ? -rr : rr), ty, false);
        }
        bubble(cx, cy, rr, tag ?? "XI");
        // A tripped switch: the equipment's condition badge at the bubble's corner (as the browser).
        if (it.type === "instrument" && it.on) {
          const [bx, by] = [cx + rr + 0.3 * sx, cy - rr - 0.3 * sx];
          if (it.tone === "alarm") condBadge(bx, by, 2.4 * sx, it.on);
          else condBadge(bx, by, 2.4 * sx, undefined, it.on);
        }
        if (v) {
          // As in the browser (labels.ts readingSpot): right of the bubble, else left, else above or below (away from the connection).
          const rs = readingSpot(it, all, aspect, lib, tapY(it, all, aspect, lib));
          reading(X(0) + (rs.x - READING.w / 2) * sx, Y(0) + rs.y * sx, v, it.decimals, it.unit, sx);
        }
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

  /** A filled arrow head with its tip at (x, y), pointing along (dx, dy) (one of the four directions): a picture. */
  function arrow(x: number, y: number, dx: number, dy: number, len: number, half: number, color: Argb): NativeElement {
    const s = Math.max(4, r(Math.max(len, 2 * half)));
    const dir = dx > 0 ? "r" : dx < 0 ? "l" : dy > 0 ? "d" : "u";
    const id = `arrow_${dir}_${s}_${hex(color).slice(1)}`;
    const L2 = (len / s) * 100, H = (half / s) * 100;
    // In a 100 box with the tip at the right-middle, turned to the direction.
    const rot = { r: 0, d: 90, l: 180, u: 270 }[dir];
    if (!needed.has(id)) needed.set(id, `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100"><path d="M100 50L${100 - L2} ${50 - H}V${50 + H}Z" fill="${hex(color)}" transform="rotate(${rot} 50 50)"/></svg>`);
    // The box sits so the tip lands on (x, y).
    const [bx, by] = dir === "r" ? [x - s, y - s / 2] : dir === "l" ? [x, y - s / 2] : dir === "d" ? [x - s / 2, y - s] : [x - s / 2, y];
    return { kind: "image", x: r(bx), y: r(by), w: s, h: s, props: { "Static ID": `${pool}.${id}` } };
  }

  function image(base: string, px: number): string {
    const id = `${base}_${px}`;
    if (!needed.has(id)) {
      const svg = symbols(p, px).find((t) => t.id === base)!.svg.replace('width="100" height="100"', `width="${px}" height="${px}"`);
      needed.set(id, svg);
    }
    return id;
  }

  /** A faceplate as a dialog visualization, laid out like the browser's; returns its name. */
  function dialogFor(title: string, f: Faceplate, sym: ProcessItem): string {
    const name = `Dlg_${screen.name}_${title.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 60);
    const W = r(380 * k), P = 18 * k, IW = W - 2 * P;
    const d: NativeElement[] = [];
    d.push(text(P, 14 * k, IW - 40 * k, 32 * k, f.title ?? title, F.title, p.text));
    button(d, W - P - 32 * k, 14 * k, 32 * k, 32 * k, "×", "neutral", undefined, { close_dialog: name });
    d.push({ kind: "rect", x: r(P), y: r(56 * k), w: r(IW), h: 1, fill: p.border, frame: null });
    let y = 70 * k;
    const running = sym.type === "pump" || sym.type === "fan" ? sym.running : sym.type === "symbol" ? sym.on : undefined;
    const open = sym.type === "valve" ? sym.open : undefined;
    const fault = sym.type === "pump" || sym.type === "symbol" ? sym.fault : undefined;
    let lx = P;
    for (const [label, v, tone] of [["Running", running, "ok"], ["Open", open, "ok"], ["Fault", fault, "alarm"]] as [string, string | undefined, Tone][]) {
      if (!v) continue;
      lamp(d, lx, y, 130 * k, label, v, tone);
      lx += 130 * k;
    }
    if (running || open || fault) y += 33 * k;
    if (f.auto) y += segmented(d, P, y, IW, f.auto, ["Manual", "Auto"], ["FALSE", "TRUE"]) + 14 * k;
    const btns = [["Start", f.start], ["Stop", f.stop], ["Open", f.open], ["Close", f.close], ["Reset", f.reset]].filter((b) => b[1]) as [string, string][];
    if (btns.length) {
      const gap = 10 * k;
      const bw = (IW - (btns.length - 1) * gap) / btns.length;
      btns.forEach(([label, v], j) => button(d, P + j * (bw + gap), y, bw, 44 * k, label, buttonKind(label), buttonIcon(label), { tap: v }));
      y += 58 * k;
    }
    (f.values ?? []).forEach((x, j, all) => {
      d.push(text(P, y, IW * 0.6, 28 * k, x.label, F.body, p.text2));
      d.push(text(P + IW * 0.4, y, IW * 0.6, 28 * k, `%.${x.decimals ?? 1}f${x.unit ? ` ${x.unit}` : ""}`, F.bodyB, p.text, "RIGHT", { props: { "Text variables.Text variable": real(x.value) } }));
      if (j < all.length - 1) d.push({ kind: "rect", x: r(P), y: r(y + 28 * k), w: r(IW), h: 1, fill: p.border, frame: null });
      y += 29 * k;
    });
    if (f.values?.length) y += 8 * k;
    if (f.setpoint) {
      const sp = f.setpoint;
      const step = sp.step ?? 1;
      d.push(text(P, y, IW, 16 * k, sp.label ?? "Set-point", F.small, p.text2));
      y += 24 * k;
      const write = (op: string) => `${sp.variable} := LIMIT(${sp.min}, ${sp.variable} ${op} ${step}, ${sp.max});`;
      button(d, P, y, 44 * k, 44 * k, "−", "neutral", undefined, { click: write("-") }, false, undefined, [FONT, ptPx(20 * k)]);
      d.push({ kind: "round", x: r(P + 52 * k), y: r(y), w: r(IW - 104 * k), h: r(44 * k), fill: p.tile2, frame: p.border, radius: RS });
      d.push(text(P + 52 * k, y, IW - 104 * k, 44 * k, `%.1f${sp.unit ? ` ${sp.unit}` : ""}`, [SEMI, ptPx(TYPE.valueS * k * 0.8)], p.text, "HCENTER", { props: { "Text variables.Text variable": real(sp.variable) } }));
      button(d, P + IW - 44 * k, y, 44 * k, 44 * k, "+", "neutral", undefined, { click: write("+") }, false, undefined, [FONT, ptPx(20 * k)]);
      y += 58 * k;
    }
    dialogs.push({ name, size: [W, r(y + 8 * k)], background: p.tile, elements: d });
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

/** A rail title on up to two lines of about `width` pixels: [line number, text, font size]; the font shrinks to fit. */
export function railLines(title: string, width: number, size: number): [number, string, number][] {
  const fits = (t: string, fs: number) => t.length * fs * 0.56 <= width;
  const words = title.split(/\s+/).filter(Boolean);
  // The split into one or two lines whose longer line is shortest.
  let lines = [title];
  for (let i = 1; i < words.length; i++) {
    const two = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
    if (Math.max(...two.map((l) => l.length)) < Math.max(...lines.map((l) => l.length))) lines = two;
  }
  if (lines.length === 2 && fits(title, size)) lines = [title];
  const longest = Math.max(...lines.map((l) => l.length));
  const fs = fits("x".repeat(longest), size) ? size : Math.max(size * 0.7, width / (longest * 0.56));
  return lines.map((l, i) => [i, l, fs]);
}

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

/** The browser's half-circle gauge at fraction f of its range (200 x 128 box, drawn at w x h). */
function gaugeSvg(p: Palette, f: number, tone: Tone, w: number, h: number): string {
  const R = 84;
  const pt = (a: number) => [100 + R * Math.sin((a * Math.PI) / 180), 104 - R * Math.cos((a * Math.PI) / 180)].map((v) => Math.round(v * 10) / 10);
  const arc = (a0: number, a1: number) => {
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    return `M${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1}`;
  };
  const value = f > 0.001 ? `<path d="${arc(-90, -90 + 180 * Math.min(1, f))}" fill="none" stroke="${hex(p.tones[tone])}" stroke-width="10"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 200 128"><path d="${arc(-90, 90)}" fill="none" stroke="${hex(p.track)}" stroke-width="10"/>${value}</svg>`;
}

function num(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

function darken(c: Argb, f: number): Argb {
  const ch = (s: number) => Math.max(0, Math.min(255, Math.round(((c >>> s) & 255) * (1 - f))));
  return ((0xff << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
}
