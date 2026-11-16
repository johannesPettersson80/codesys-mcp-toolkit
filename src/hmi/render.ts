/**
 * Renders an HMI screen to HTML + SVG on a fixed canvas (1280x720 unless the
 * screen sets its size; scaled to the window by the page). Pure: no DOM, so the
 * server can build screenshot pages and the browser can mount live ones. Values
 * are not rendered here: elements carry `data-b` (an index into `bindings`), and
 * the live client (live.ts) applies values through CSS variables and classes.
 * Colours, sizes and icons come from the design system (theme.ts, icons.ts),
 * which the native CODESYS export shares.
 */
import { ICONS, iconSvg, type IconName } from "./icons.js";
import { routed, itemKey, labelSpots, nearestOnLine, type LabelSpot, lineEnds, instrumentTap, PUMP_CASING } from "./route.js";
import { hasDock, type Faceplate, type Machine, type ProcessItem, type Screen, type Tone, type Widget } from "./spec.js";
import { BUILTIN_SYMBOLS, findPictogram, findSymbol, INSTRUMENT_SYMBOLS, pictogramSize, scopeIds, symbolBox, symbolSize, upright, type SymbolDef, type SymbolLib } from "./symbols.js";
import { scaleOf, SPACE, themeCss, themeFor, TYPE } from "./theme.js";
import { nameParts, textKey, placeTexts, READING, readingSpot, SIGN, tapY, type PlacedLabel } from "./labels.js";

export interface Canvas {
  w: number;
  h: number;
  /** Scale of the design system's sizes (1 at 1280x720). */
  k: number;
  /** Height of the top bar. */
  bar: number;
  /** Where the cards start (below the top bar). */
  header: number;
  pad: number;
  gap: number;
  /** Width of the navigation rail (0 without one). */
  rail: number;
  /** Where the cards start across (after the rail). */
  left: number;
  /** Height of the bottom bar with Start/Stop and the mode (0 without one). */
  dock: number;
}

/** The canvas of a screen's panel size; `rail` when the HMI has more than one page. */
export function canvasOf(screen: { size?: string; machine?: Machine }, rail = false): Canvas {
  const [w, h] = (screen.size ?? "1280x720").split("x").map(Number) as [number, number];
  const k = scaleOf({ w, h });
  const bar = Math.round(SPACE.bar * k), pad = Math.round(SPACE.pad * k), gap = Math.round(SPACE.gap * k);
  const railW = rail ? Math.round(SPACE.rail * k) : 0;
  const dock = hasDock(screen) ? Math.round(SPACE.dock * k) : 0;
  return { w, h, k, bar, header: bar + pad, pad, gap, rail: railW, left: railW + pad, dock };
}

/** What a page shows besides its own tiles: the other pages, and the alarms of the whole HMI. */
export interface PageContext {
  pages?: { name: string; title: string; icon?: string }[];
  alarms?: { active: string; severity?: string }[];
  /** The project's own symbols (hmi_save_symbol), besides the standard ones. */
  symbols?: SymbolLib;
  /** Languages with translations (the screens' own texts are the base language). */
  languages?: string[];
  /** The language shown (undefined: the base language). */
  lang?: string;
}

export type Binding =
  | { kind: "text"; v: string; decimals?: number; unit?: string; bands?: { from: number; tone: Tone }[] }
  | { kind: "on"; v: string; invert?: boolean }
  | { kind: "fault"; v: string }
  | { kind: "level"; v: string; min: number; max: number; decimals?: number; unit?: string; bands?: { from: number; tone: Tone }[] }
  | { kind: "trend"; series: string[]; min?: number; max?: number; seconds: number }
  | { kind: "spark"; v: string }
  | { kind: "setpoint"; v: string; decimals: number }
  | { kind: "alarm"; v: string }
  | { kind: "count"; vars: string[] }
  | { kind: "state"; states: { v: string; text: string; tone: Tone }[]; idle: { text: string; tone: Tone } }
  | { kind: "eq"; v: string; val: string };

export interface Rendered {
  html: string;
  bindings: Binding[];
  css: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** The pixel box of a tile on the canvas (`rail`: the HMI has more than one page). */
export function tileBox(screen: Screen, at: [number, number, number, number], rail = false) {
  const [cols, rows] = screen.grid;
  const { w, h, header, pad, gap, left, dock } = canvasOf(screen, rail);
  const cw = (w - left - pad - (cols - 1) * gap) / cols;
  const ch = (h - header - pad - dock - (rows - 1) * gap) / rows;
  const [c, r, wd, ht] = at;
  return { x: left + (c - 1) * (cw + gap), y: header + (r - 1) * (ch + gap), w: wd * cw + (wd - 1) * gap, h: ht * ch + (ht - 1) * gap };
}

/** A page's icon in the rail: its own, else one that fits its title. */
export function pageIcon(p: { title: string; icon?: string }, index: number): IconName {
  if (p.icon) return p.icon as IconName;
  const t = p.title.toLowerCase();
  if (/alarm|message|meldung/.test(t)) return "alarm";
  if (/trend|history|chart/.test(t)) return "trend";
  if (/recipe|rezept/.test(t)) return "recipe";
  if (/setting|parameter|config|service|einstell/.test(t)) return "settings";
  if (/energy|power/.test(t)) return "energy";
  return index === 0 ? "home" : "process";
}

/** The icon a button gets from its label when it names none. */
export function buttonIcon(label: string): IconName | undefined {
  if (/^start|run$|^on$/i.test(label)) return "play";
  if (/^stop|^off$/i.test(label)) return "stop";
  if (/^pause|^hold/i.test(label)) return "pause";
  if (/^reset|^quit/i.test(label)) return "reset";
  if (/^ack/i.test(label)) return "check";
  return undefined;
}

/**
 * How a button looks (Siemens iX): primary, filled in the primary colour, for the one most
 * likely next action (Start, Run, On, Open); secondary, grey and outlined, for the rest (Stop,
 * Reset, ...); or filled in a state colour when the screen asks for one (ok, warn, alarm).
 * No traffic-light Start/Stop and no black buttons.
 */
export type ButtonKind = "primary" | "secondary" | "ok" | "warn" | "alarm";

/** A button's look from its label, or from the tone the screen gives it. */
export function buttonKind(label: string, tone?: Tone): ButtonKind {
  if (tone) return tone === "accent" ? "primary" : tone === "neutral" ? "secondary" : tone;
  if (/^start|^run|^on$|^open/i.test(label)) return "primary";
  return "secondary";
}

/** The icon of a state per tone. */
export const STATE_ICON: Record<Tone, IconName> = { ok: "play", alarm: "fault", warn: "warning", accent: "manual", neutral: "stop" };

/** A state card's text size: as large as the card allows for its longest word, up to 20 px. */
export function stateTextSize(texts: string[], bodyW: number, k: number): number {
  const longest = Math.max(...texts.flatMap((t) => t.split(/\s+/)).map((t) => t.length));
  return Math.max(14 * k, Math.min(20 * k, (bodyW - 60 * k) / (longest * 0.6)));
}

/** The machine's states with their icons, the idle one first (index 0, as the live client numbers them). */
export function machineStates(m: { states: { text: string; tone: Tone; icon?: IconName }[]; idle: { text: string; tone: Tone; icon?: IconName } }): { text: string; tone: Tone; icon: IconName }[] {
  return [m.idle, ...m.states].map((s) => ({ text: s.text, tone: s.tone, icon: s.icon ?? STATE_ICON[s.tone] }));
}

/** Which state panel buttons lose their labels: none, Reset, or all three on a very narrow card. */
export function stateButtonFit(bodyW: number, k: number, has: { start?: unknown; stop?: unknown; reset?: unknown }): { resetIcon: boolean; allIcons: boolean } {
  const fits = (labels: string[], icons: number) => labels.reduce((s, l) => s + buttonWidth(l, true, k), 0) + icons * 44 * k + 10 * k * (labels.length + icons - 1) <= bodyW;
  const named = [has.start && "Start", has.stop && "Stop"].filter(Boolean) as string[];
  const resetIcon = !!has.reset && !fits([...named, "Reset"], 0);
  return { resetIcon, allIcons: resetIcon && !fits(named, 1) };
}

export function renderScreen(screen: Screen, page: PageContext = {}): Rendered {
  const bindings: Binding[] = [];
  const bind = (b: Binding) => `data-b="${bindings.push(b) - 1}"`;
  let uid = 0;
  const id = (p: string) => `${p}${++uid}`;
  const faces: string[] = [];
  const face: Face = (title, f, extra) => {
    const k = `fp-${faces.length + 1}`;
    faces.push(faceplateHtml(k, title, f, extra, bind));
    return `data-open="${k}"`;
  };
  const pages = page.pages ?? [];
  const rail = pages.length > 1;
  const cv = canvasOf(screen, rail);
  const k = cv.k;
  const lib: SymbolLib = { ...BUILTIN_SYMBOLS, ...page.symbols };
  const theme = themeFor(screen);

  const tiles = screen.widgets.map((wg) => {
    const box = tileBox(screen, wg.at, rail);
    const inner = widget(wg, box, k, bind, id, face, lib);
    // Access rights apply in CODESYS's visualization after Login; the browser marks them.
    const lock = wg.access ? `<span class="t-lock" title="${esc(`In CODESYS: operated by ${wg.access.min} and up${wg.access.below === "hide" ? ", hidden from lower groups" : ""}`)}">${iconSvg("login", r1(12 * k))}${esc(wg.access.min)}</span>` : "";
    const head = wg.title || wg.icon ? `<div class="t-head">${wg.icon ? iconSvg(wg.icon, r1(16 * k), "ic t-ic") : ""}<span class="t-title">${esc(wg.title ?? "")}</span>${lock}</div>` : lock;
    return `<section class="tile t-${wg.type}${wg.title || wg.icon ? "" : " untitled"}" style="left:${r1(box.x)}px;top:${r1(box.y)}px;width:${r1(box.w)}px;height:${r1(box.h)}px">${head}<div class="t-body">${inner}</div></section>`;
  });

  const navRail = rail
    ? `<nav class="h-rail">${pages.map((p, i) => `<button class="r-page${p.name === screen.name ? " cur" : ""}" data-nav="${esc(p.name)}">${iconSvg(pageIcon(p, i), r1(22 * k))}<span>${esc(p.title)}</span></button>`).join("")}</nav>`
    : "";
  const info = (screen.info ?? [])
    .map((f) => `<div class="h-field"><span class="hf-l">${esc(f.label)}</span><span class="hf-v"${f.value ? ` ${bind({ kind: "text", v: f.value, decimals: f.decimals, unit: f.unit })}` : ""}>${f.value ? "–" : esc(f.text ?? "")}</span></div>`)
    .join("");
  // Alarm counters per severity, grey at zero (fault, warning, info).
  const alarms = page.alarms ?? [];
  const badge = alarms.length
    ? `<div class="h-alarms">${ALARM_COUNTERS.map(([sev, ic, label]) => `<div class="h-cnt sev-${sev}" title="${label}" ${bind({ kind: "count", vars: alarms.filter((a) => (a.severity ?? "alarm") === sev).map((a) => a.active) })}>${iconSvg(ic, r1(18 * k))}<span class="n">0</span></div>`).join("")}</div>`
    : "";
  // The machine: its state in the top bar's corner (with a line in its colour under the bar), its commands at the bottom.
  const m = screen.machine;
  const corner = m
    ? `<div class="h-state" ${bind({ kind: "state", states: m.states.map((s) => ({ v: s.on, text: s.text, tone: s.tone })), idle: m.idle })} data-tone="${m.idle.tone}" data-i="0"><span class="hs-ring">${stateIcons(m, r1(20 * k))}</span><span class="hs-t"><span class="st-text">${esc(m.idle.text)}</span>${m.detail ? `<span class="hs-d" ${bind({ kind: "text", v: m.detail })}></span>` : ""}</span></div>`
    : "";
  const dockBtn = (label: string, v: string | undefined, kind: ButtonKind, ic: IconName) => (v ? button(label, v, "tap", kind, ic, bind) : "");
  const dock =
    m && hasDock(screen)
      ? `<footer class="h-dock">${m.mode ? `<div class="d-mode">${segmented(m.mode.variable, m.mode.options, m.mode.values, k, bind)}</div>` : ""}<div class="d-btns">${dockBtn("Reset", m.reset, "secondary", "reset")}${dockBtn("Start", m.start, "primary", "play")}${dockBtn("Stop", m.stop, "secondary", "stop")}</div></footer>`
      : "";
  const langs = page.languages?.length ? `<div class="h-langs">${iconSvg("language", r1(16 * k))}<button class="h-lang${page.lang ? "" : " cur"}" data-lang="">EN</button>${page.languages.map((l) => `<button class="h-lang${page.lang === l ? " cur" : ""}" data-lang="${esc(l)}">${esc(l.toUpperCase())}</button>`).join("")}</div>` : "";
  const size = cv.h <= 480 ? " small" : cv.h >= 1080 ? " large" : "";
  const html = `<div class="hmi theme-${screen.theme}${size}${rail ? " has-rail" : ""}${dock ? " has-dock" : ""}" style="width:${cv.w}px;height:${cv.h}px;--k:${k};--bar:${cv.bar}px;--rail:${cv.rail}px;--pad:${cv.pad}px;--dock:${cv.dock}px;${themeCss(theme)};${theme.series.map((c, i) => `--s${i}:${c}`).join(";")}">
<svg width="0" height="0" style="position:absolute" aria-hidden="true">${DEFS}</svg>
<header class="h-bar${m ? " has-state" : ""}">${corner}<div class="h-titles"><div class="h-title">${esc(screen.title)}</div>${screen.subtitle ? `<div class="h-sub">${esc(screen.subtitle)}</div>` : ""}</div>${info ? `<div class="h-info">${info}</div>` : ""}
<div class="h-right">${langs}${badge}<div class="h-sim" data-sim><span class="dot"></span><span class="lbl">Offline</span></div><div class="h-clock" data-clock>--:--:--</div></div></header>
${navRail}
${tiles.join("\n")}
${dock}
${faces.join("\n")}
</div>`;
  return { html, bindings, css: HMI_CSS };
}

type Bind = (b: Binding) => string;
type Face = (title: string, f: Faceplate, extra: { running?: string; fault?: string; open?: string }) => string;

/** The alarm counters in the top bar: severity, icon, tooltip. */
export const ALARM_COUNTERS: [string, IconName, string][] = [["alarm", "fault", "Faults"], ["warning", "warning", "Warnings"], ["info", "info", "Messages"]];

/** One icon per state (idle first), shown by the live client's data-i. */
function stateIcons(m: Machine | Extract<Widget, { type: "state" }>, px: number): string {
  return machineStates(m).map((s, i) => iconSvg(s.icon, px, `ic st-ic g${i} tone-${s.tone}`)).join("");
}

/** A button in its kind's look (see ButtonKind), with an icon; `iconOnly` keeps the label as its tooltip. */
function button(label: string, variable: string, act: string, kind: ButtonKind, icon: IconName | undefined, bind: Bind | undefined, iconOnly = false): string {
  const only = iconOnly && icon;
  return `<button class="btn b-${kind}${only ? " icon-only" : ""}" data-act="${act}" data-var="${esc(variable)}"${only ? ` title="${esc(label)}"` : ""} ${bind && (act === "tap" || act === "toggle") ? bind({ kind: "on", v: variable }) : ""}>${icon ? iconSvg(icon, 18, "ic b-ic") : ""}${only ? "" : `<span>${esc(label)}</span>`}</button>`;
}

/** A segmented switch for a mode: the option the variable holds is outlined in the accent. */
function segmented(variable: string, options: string[], values: string[] | undefined, k: number, bind: Bind): string {
  const vals = modeValues(options, values);
  // Icons only when every option has one, so the options stay alike.
  const icons = options.every((o) => modeIcon(o));
  return `<div class="seg">${options.map((o, i) => { const ic = icons ? modeIcon(o) : undefined; return `<button class="seg-b" data-act="value" data-var="${esc(variable)}" data-val="${esc(vals[i]!)}" ${bind({ kind: "eq", v: variable, val: vals[i]! })}>${ic ? iconSvg(ic, r1(18 * k)) : ""}<span>${esc(o)}</span></button>`; }).join("")}</div>`;
}

/** About how wide a button is, in canvas pixels at scale k (Segoe UI semibold 14 px: ~7.6 px a character). */
export function buttonWidth(label: string, icon: boolean, k: number): number {
  return (label.length * 7.6 + (icon ? 26 : 0) + 28) * k;
}

/** How a row of buttons fits a width: in one row, two columns, or one column. */
export function buttonLayout(items: { label: string; icon: boolean }[], width: number, k: number): "row" | "grid" | "col" {
  const gap = 10 * k;
  const row = items.reduce((s, i) => s + buttonWidth(i.label, i.icon, k), 0) + gap * (items.length - 1);
  if (row <= width) return "row";
  const widest = Math.max(...items.map((i) => buttonWidth(i.label, i.icon, k)));
  return items.length > 2 && widest * 2 + gap <= width ? "grid" : "col";
}

function faceplateHtml(k: string, title: string, f: Faceplate, extra: { running?: string; fault?: string; open?: string }, bind: Bind): string {
  const status = [
    extra.running ? `<span class="led tone-ok" ${bind({ kind: "on", v: extra.running })}><span class="led-dot"></span>Running</span>` : "",
    extra.open ? `<span class="led tone-ok" ${bind({ kind: "on", v: extra.open })}><span class="led-dot"></span>Open</span>` : "",
    extra.fault ? `<span class="led tone-alarm" ${bind({ kind: "on", v: extra.fault })}><span class="led-dot"></span>Fault</span>` : "",
  ].join("");
  const mode = f.auto ? segmented(f.auto, ["Manual", "Auto"], ["FALSE", "TRUE"], 1, bind) : "";
  const btn = (label: string, v: string | undefined) => (v ? button(label, v, "tap", buttonKind(label), buttonIcon(label), bind) : "");
  const buttons = [btn("Start", f.start), btn("Stop", f.stop), btn("Open", f.open), btn("Close", f.close), btn("Reset", f.reset)].join("");
  const values = (f.values ?? []).map((x) => `<div class="fp-row"><span>${esc(x.label)}</span><b ${bind({ kind: "text", v: x.value, decimals: x.decimals, unit: x.unit })}>–</b></div>`).join("");
  const sp = f.setpoint;
  const setpoint = sp ? `<div class="fp-sp">${setpointHtml(sp.variable, sp.min, sp.max, sp.step, sp.unit, undefined, 1, bind, sp.label ?? "Set-point")}</div>` : "";
  return `<div class="fp" id="${k}" hidden><div class="fp-card"><div class="fp-head"><div class="fp-title">${esc(f.title ?? title)}</div><button class="fp-x" data-close>×</button></div>${status ? `<div class="fp-status">${status}</div>` : ""}${mode}${buttons ? `<div class="btns fp-btns">${buttons}</div>` : ""}${values ? `<div class="fp-values">${values}</div>` : ""}${setpoint}</div></div>`;
}

/** A set value with − and + (Koch, Kiefel); with `actual`, the measured value large in the accent beside it. */
function setpointHtml(variable: string, min: number, max: number, step: number | undefined, unit: string | undefined, actual: string | undefined, dec: number, bind: Bind, label = "Set", actualDec?: number): string {
  const act = actual ? `<div class="sp-act"><span class="sp-l">Actual</span><div class="v-main"><span class="v-num sp-anum" ${bind({ kind: "text", v: actual, decimals: actualDec ?? dec })}>–</span>${unit ? `<span class="v-unit">${esc(unit)}</span>` : ""}</div></div>` : "";
  return `<div class="sp${actual ? " with-act" : ""}" data-var="${esc(variable)}" data-min="${min}" data-max="${max}" data-step="${step ?? 1}" ${bind({ kind: "setpoint", v: variable, decimals: dec })}>${act}
<div class="sp-set"><span class="sp-l">${esc(label)}</span><div class="sp-row"><button class="sp-btn" data-step="-1">−</button><div class="sp-val"><span class="sp-num" ${bind({ kind: "text", v: variable, decimals: dec })}>–</span><span class="sp-unit">${esc(unit ?? "")}</span></div><button class="sp-btn" data-step="1">+</button></div><div class="sp-lim">${min} – ${max}${unit ? ` ${esc(unit)}` : ""}</div></div></div>`;
}

function toneOf(t: Tone | undefined): string {
  return t ?? "accent";
}

/** The values two to four mode options write: FALSE/TRUE for two, else 0..n-1. */
export function modeValues(options: string[], values?: string[]): string[] {
  return values?.length === options.length ? values : options.length === 2 ? ["FALSE", "TRUE"] : options.map((_, i) => String(i));
}

/** The icon of a mode option from its label. */
export function modeIcon(label: string): IconName | undefined {
  if (/manu|hand/i.test(label)) return "manual";
  if (/auto/i.test(label)) return "auto";
  if (/off|stop/i.test(label)) return "stop";
  if (/service|maint|setup/i.test(label)) return "settings";
  return undefined;
}

function widget(w: Widget, box: { w: number; h: number }, k: number, bind: Bind, id: (p: string) => string, face: Face, lib: SymbolLib): string {
  const head = w.title || w.icon ? 30 * k : 0;
  const bodyH = box.h - head - 28 * k;
  const bodyW = box.w - 32 * k;
  switch (w.type) {
    case "value": {
      const scale = w.min !== undefined && w.max !== undefined;
      const size = Math.max(16 * k, Math.min(TYPE.value * k, bodyH * (scale || w.set ? 0.5 : 0.75), bodyW / 4.2));
      const spark = w.trend ? `<svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none" ${bind({ kind: "spark", v: w.value })}><path class="spark-fill"/><path class="spark-line"/></svg>` : "";
      const bar = scale
        ? `<div class="v-scale"><div class="v-track" ${bind({ kind: "level", v: w.value, min: w.min!, max: w.max!, bands: w.bands })}><div class="v-fill"></div>${w.set ? `<div class="v-set" ${bind({ kind: "level", v: w.set, min: w.min!, max: w.max! })}></div>` : ""}</div><div class="v-lims"><span>${w.min}</span><span>${w.max}</span></div></div>`
        : "";
      const main = `<div class="v-main"><span class="v-num" style="font-size:${r1(size)}px" ${bind({ kind: "text", v: w.value, decimals: w.decimals, bands: w.bands })}>–</span>${w.unit ? `<span class="v-unit">${esc(w.unit)}</span>` : ""}</div>`;
      // With a set-point: Actual and Set side by side (Coperion), the set value in the text colour.
      if (w.set)
        return `<div class="v-pair"><div class="v-col"><span class="v-lab">Actual</span>${main}</div><div class="v-col"><span class="v-lab">Set</span><div class="v-main"><span class="v-num v-setn" style="font-size:${r1(size * 0.72)}px" ${bind({ kind: "text", v: w.set, decimals: w.decimals })}>–</span>${w.unit ? `<span class="v-unit">${esc(w.unit)}</span>` : ""}</div></div></div>${bar}${spark}`;
      return `${main}${bar}${spark}`;
    }
    case "gauge": {
      // A muted half circle: the track, the value in the accent (or its band's tone), the number in the middle.
      const s = Math.min(bodyW, bodyH * 1.56, 300 * k);
      const R = 84;
      const arc = describeArc(100, 104, R, -90, 90);
      const len = r1(Math.PI * R);
      return `<svg class="gauge" style="width:${r1(s)}px;height:${r1(s * 0.64)}px;--len:${len}" viewBox="0 0 200 128" ${bind({ kind: "level", v: w.value, min: w.min, max: w.max, bands: w.bands })}>
<path class="g-track" d="${arc}"/><path class="g-val" d="${arc}" style="stroke-dasharray:${len}"/>
<text x="100" y="94" class="g-num" ${bind({ kind: "text", v: w.value, decimals: w.decimals, bands: w.bands })}>–</text>
<text x="100" y="120" class="g-unit">${esc(w.unit ?? "")}</text>
<text x="16" y="124" class="g-lim">${w.min}</text><text x="184" y="124" class="g-lim">${w.max}</text></svg>`;
    }
    case "bar": {
      const lvl = bind({ kind: "level", v: w.value, min: w.min, max: w.max, bands: w.bands });
      const set = w.set ? `<div class="v-set" ${bind({ kind: "level", v: w.set, min: w.min, max: w.max })}></div>` : "";
      if (w.vertical)
        return `<div class="bar-wrap vert"><div class="bar" ${lvl}><div class="bar-fill"></div>${set}</div><div class="bar-read"><span class="bar-num" ${bind({ kind: "text", v: w.value, decimals: 1, bands: w.bands })}>–</span><span class="bar-unit">${esc(w.unit ?? "")}</span><span class="bar-lim">${w.min} – ${w.max}</span></div></div>`;
      return `<div class="bar-wrap"><div class="v-main"><span class="bar-num" ${bind({ kind: "text", v: w.value, decimals: 1, bands: w.bands })}>–</span><span class="v-unit">${esc(w.unit ?? "")}</span></div><div class="bar" ${lvl}><div class="bar-fill"></div>${set}</div><div class="v-lims"><span>${w.min}</span><span>${w.max}</span></div></div>`;
    }
    case "status":
      return `<ul class="status">${w.items.map((i) => `<li class="led tone-${toneOf(i.tone ?? "ok")}" ${bind({ kind: "on", v: i.on, invert: i.invert })}><span class="led-dot"></span><span>${esc(i.label)}</span></li>`).join("")}</ul>`;
    case "buttons": {
      const items = w.items.map((i) => ({ ...i, ic: i.icon ?? buttonIcon(i.label) }));
      const layout = buttonLayout(items.map((i) => ({ label: i.label, icon: !!i.ic })), bodyW, k);
      return `<div class="btns${layout === "row" ? "" : ` ${layout}`}">${items.map((i) => button(i.label, i.variable, i.action, buttonKind(i.label, i.tone), i.ic, bind)).join("")}</div>`;
    }
    case "switch":
      return `<label class="sw" data-act="toggle" data-var="${esc(w.variable)}" ${bind({ kind: "on", v: w.variable })}><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-lbl">${esc(w.label ?? "")}</span><span class="sw-state"><span class="s-on">On</span><span class="s-off">Off</span></span></label>`;
    case "mode":
      return segmented(w.variable, w.options, w.values, k, bind);
    case "state": {
      // A calm card: the state's icon in a ring in its colour, the text in the text colour, a thin line in the colour on top.
      const fs = stateTextSize([...w.states.map((s) => s.text), w.idle.text], bodyW, k);
      // Labels where they fit: else Reset becomes an icon, and on a very narrow card all three do.
      const { resetIcon, allIcons } = stateButtonFit(bodyW, k, w);
      const btns = [w.start ? button("Start", w.start, "tap", "primary", "play", bind, allIcons) : "", w.stop ? button("Stop", w.stop, "tap", "secondary", "stop", bind, allIcons) : "", w.reset ? button("Reset", w.reset, "tap", "secondary", "reset", bind, resetIcon) : ""].join("");
      return `<div class="st" ${bind({ kind: "state", states: w.states.map((s) => ({ v: s.on, text: s.text, tone: s.tone })), idle: w.idle })} data-tone="${w.idle.tone}" data-i="0"><div class="st-row"><span class="hs-ring">${stateIcons(w, r1(20 * k))}</span><span class="st-text" style="font-size:${r1(fs)}px">${esc(w.idle.text)}</span></div>${btns ? `<div class="btns st-btns">${btns}</div>` : ""}</div>`;
    }
    case "setpoint": {
      const dec = w.decimals ?? (w.step !== undefined && !Number.isInteger(w.step) ? String(w.step).split(".")[1]!.length : 0);
      return setpointHtml(w.variable, w.min, w.max, w.step, w.unit, w.actual, dec, bind, "Set", w.decimals ?? Math.max(dec, 1));
    }
    case "trend": {
      const lines = w.series.map((_, i) => `<path class="tr-line" style="stroke:var(--s${i % 6})"/>`).join("");
      const legend = w.series.map((s, i) => `<span><i style="background:var(--s${i % 6})"></i>${esc(s.label ?? s.value.split(".").pop()!)}</span>`).join("");
      const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="600" y1="${200 * f}" y2="${200 * f}"/>`).join("");
      return `<div class="tr-legend">${legend}</div><div class="tr-plot"><svg class="trend" viewBox="0 0 600 200" preserveAspectRatio="none" ${bind({ kind: "trend", series: w.series.map((s) => s.value), min: w.min, max: w.max, seconds: w.seconds })}><g class="tr-grid">${grid}</g>${lines}</svg><span class="tr-max"></span><span class="tr-min"></span></div><div class="tr-axis"><span>−${w.seconds} s</span><span>now</span></div>`;
    }
    case "alarms": {
      const ic = (s: string) => iconSvg(s === "info" ? "info" : s === "warning" ? "warning" : "fault", r1(18 * k), "ic al-ic");
      const rows = w.items.map((i) => `<li class="al sev-${i.severity}" ${bind({ kind: "alarm", v: i.active })}>${ic(i.severity)}<span class="al-text">${esc(i.text)}</span><span class="al-st"></span><button class="al-ack" data-ack="${esc(i.active)}" title="Acknowledge">${iconSvg("check", r1(16 * k))}</button></li>`).join("");
      return `<ul class="alarms">${rows}<li class="al-none">${iconSvg("check", r1(18 * k))}No active alarms</li></ul>${w.history ? `<div class="al-hist-h">History</div><ul class="al-hist" data-hist="${w.history}"></ul>` : ""}`;
    }
    case "text":
      return `<div class="txt">${esc(w.text).replace(/\n/g, "<br>")}</div>`;
    case "recipe": {
      const prg = `PRG_Recipe_${w.recipe}`;
      const rows = w.recipes
        .map((name, n) => `<li><span class="rcp-name">${esc(name)}</span><button class="btn b-primary rcp-btn" data-act="value" data-var="${prg}.iApply" data-val="${n}">Apply</button>${w.save ? `<button class="btn b-secondary rcp-btn" data-act="value" data-var="${prg}.iSave" data-val="${n}">Save</button>` : ""}</li>`)
        .join("");
      return `<div class="rcp"><div class="rcp-active">Active <b ${bind({ kind: "text", v: `${prg}.sActive` })}>–</b></div><ul class="rcp-list">${rows}</ul></div>`;
    }
    case "line":
      return lineHtml(w, bodyW, bodyH, k, bind, lib);
    case "process": {
      const vw = 100;
      const vh = r1((100 * Math.max(60, bodyH)) / Math.max(60, box.w - 24));
      const sy = vh / 100;
      const ends = lineEnds(w.items);
      const all = routed(w.items, sy, lib);
      const placed = placeTexts(all, sy, lib, ends);
      // Line names at the diagram's edge, after everything else so nothing covers them.
      const names = all.flatMap((p, n) => {
        const e = ends[n];
        if (p.type !== "pipe" || !e || !p.points?.length) return [];
        const pt = e.at === "start" ? p.points[0]! : p.points[p.points.length - 1]!;
        void pt;
        // The name's place (labels.ts): beside a top or bottom end, above or below a side end, clear of the rest.
        const pl = placed.lines.get(n)!;
        // A flow arrow on the line near its free end: into the diagram where a line enters, out where it leaves.
        const pts = p.points;
        const [a, b] = e.at === "start" ? [pts[0]!, pts[1] ?? pts[0]!] : [pts[pts.length - 2] ?? pts[0]!, pts[pts.length - 1]!];
        const ux = b[0] - a[0], uy = (b[1] - a[1]) * sy, len = Math.hypot(ux, uy) || 1;
        const [dx, dy] = [ux / len, uy / len];
        const tip: [number, number] = e.at === "start" ? [a[0] + dx * 3.2, a[1] * sy + dy * 3.2] : [b[0] - dx * 0.4, b[1] * sy - dy * 0.4];
        const base: [number, number] = [tip[0] - dx * 1.8, tip[1] - dy * 1.8];
        const arrow = `<path class="line-arrow" d="M${r1(tip[0])} ${r1(tip[1])}L${r1(base[0] - dy * 0.95)} ${r1(base[1] + dx * 0.95)}L${r1(base[0] + dy * 0.95)} ${r1(base[1] - dx * 0.95)}Z"/>`;
        return [`${arrow}<text class="p-text p-line" x="${r1(pl.x)}" y="${r1(pl.y + 0.65)}" style="text-anchor:${pl.anchor}">${esc(e.label)}</text>`];
      });
      const items = [...all].sort((a, b) => (a.type === "pipe" ? -1 : 0) - (b.type === "pipe" ? -1 : 0));
      return `<svg class="proc" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${items.map((p) => processSvg(p, sy, bind, id, face, lib, placed.labels, all)).join("")}${names.join("")}</svg>`;
    }
  }
}

/** A process diagram's SVG alone, without live bindings or faceplates (for the P&ID sheet), for a body of width x height pixels. */
export function processDrawing(w: Extract<Widget, { type: "process" }>, width: number, height: number, lib: SymbolLib): string {
  let uid = 0;
  // The body as the card would give it (widget() takes the card's padding off again).
  return widget({ ...w, title: undefined, icon: undefined }, { w: width + 32, h: height + 28 }, 1, () => "", (p) => `pid${p}${++uid}`, () => "", lib);
}

type Station = Extract<Widget, { type: "line" }>["stations"][number];

/** Where a line widget's tiles go, in pixels of the card body (shared with the CODESYS export). */
export function lineLayout(w: { stations: { feed?: unknown }[] }, bodyW: number, bodyH: number, k: number) {
  const n = w.stations.length;
  const feeds = w.stations.some((s) => s.feed);
  const minGap = 14 * k;
  const tw = Math.min(124 * k, (bodyW - 2 * minGap - (n - 1) * minGap) / n);
  // Spread the tiles over the width, with the path showing between them (not too far apart).
  const gap = Math.min(64 * k, (bodyW - 2 * minGap - n * tw) / Math.max(1, n - 1));
  const x0 = (bodyW - n * tw - (n - 1) * gap) / 2;
  const conn = 16 * k;
  const room = feeds ? (bodyH - conn) / 1.52 : bodyH;
  const th = Math.min(156 * k, room);
  const fh = feeds ? th * 0.52 : 0;
  const top = (bodyH - th - (feeds ? fh + conn : 0)) / 2;
  const y = top + (feeds ? fh + conn : 0);
  return { tw, th, fh, gap, x0, y, fy: top, conn, pathY: y + th * 0.5, xs: w.stations.map((_, i) => x0 + i * (tw + gap)) };
}

/** A station's pictogram in a 100x100 box: tank, pump, valve or fan, or a symbol from the library. */
function pictogram(name: string | undefined, lib: SymbolLib): string {
  const f = findPictogram(lib, name);
  if (!f) return "";
  const [key, d] = f;
  return `<g transform="translate(50 50)">${symbolMarkup(key, d, pictogramSize(d, 100).w)}</g>`;
}

/** The process as station tiles on a product path (Coperion, Kiefel): name, pictogram (filled while running) and key value. */
function lineHtml(w: Extract<Widget, { type: "line" }>, bodyW: number, bodyH: number, k: number, bind: Bind, lib: SymbolLib): string {
  const L = lineLayout(w, bodyW, bodyH, k);
  const tile = (s: Station, x: number, y: number, h: number, small: boolean) => {
    const pic = pictogram(s.symbol, lib);
    const valve = /valve/i.test(s.symbol ?? "");
    // The name line as on the diagram: the run sign (driven equipment), the name, the mode hand.
    const runS = s.on && !valve ? `<svg class="rs" viewBox="0 0 10 10" ${bind({ kind: "on", v: s.on })}><path class="rs-on" d="M1 .5L10 5L1 9.5Z"/><rect class="rs-off" x="1" y="1" width="8" height="8" rx=".8"/></svg>` : "";
    const handS = s.manual ? `<span class="md-h" ${bind({ kind: "on", v: s.manual })}>${iconSvg("manual", r1(15 * k))}</span>` : "";
    const badge = s.fault || s.warning ? `<span class="stn-cb">${s.warning ? `<svg class="cbw" viewBox="-12 -11 24 22"><path class="cb-wt" d="M0 -9.5L10.5 8.5H-10.5Z"/><path class="cb-wx" d="M0 -3.4V2M0 5V5.1"/></svg>` : ""}${s.fault ? `<svg class="cba" viewBox="-10 -10 20 20"><circle r="9.5"/><path d="M0 -5V1M0 4.6V4.7"/></svg>` : ""}</span>` : "";
    const value = small ? "" : `<span class="stn-v">${s.value ? `<b ${bind({ kind: "text", v: s.value, decimals: s.decimals ?? 1 })}>–</b>${s.unit ? `<span class="stn-u">${esc(s.unit)}</span>` : ""}` : ""}</span>`;
    const inner = `<span class="stn-name">${runS}<span class="stn-nt">${esc(s.name)}</span>${handS}</span>${s.tag && !small ? `<span class="stn-tag">${esc(s.tag)}</span>` : ""}${pic ? `<svg class="stn-pic${valve ? " vlv" : ""}" viewBox="0 0 100 100">${pic}</svg>` : ""}${value}${badge}`;
    const run = s.on ? ` ${bind({ kind: "on", v: s.on })}` : "";
    const nav = s.screen ? ` data-nav="${esc(s.screen)}"` : "";
    const st = `<div class="stn${small ? " small" : ""}${s.screen ? " link" : ""}"${run}${nav} style="left:${r1(x)}px;top:${r1(y)}px;width:${r1(L.tw)}px;height:${r1(h)}px"${s.screen ? ` title="Open ${esc(s.screen)}"` : ""}>${inner}</div>`;
    // The condition: the warning and the alarm each bound on a wrapper (the top edge and the badge follow them; the alarm wins).
    const warned = s.warning ? `<div class="stn-wn" ${bind({ kind: "on", v: s.warning })}>${st}</div>` : st;
    return s.fault ? `<div class="stn-al" ${bind({ kind: "fault", v: s.fault })}>${warned}</div>` : warned;
  };
  // The product path: in at the left edge, through every tile, out with an arrow at the right.
  const py = r1(L.pathY), end = r1(bodyW - 2 * k);
  const path = `<path class="ln-path" d="M0 ${py}H${end}"/><path class="ln-arrow" d="M${end} ${py}l${r1(-9 * k)} ${r1(-5 * k)}v${r1(10 * k)}z"/>`;
  const feeds = w.stations.map((s, i) => (s.feed ? `<path class="ln-path" d="M${r1(L.xs[i]! + L.tw / 2)} ${r1(L.fy + L.fh)}V${r1(L.y)}"/>` : "")).join("");
  const tiles = w.stations.map((s, i) => tile(s, L.xs[i]!, L.y, L.th, false) + (s.feed ? tile(s.feed, L.xs[i]!, L.fy, L.fh, true) : "")).join("");
  return `<div class="ln"><svg class="ln-svg" width="${r1(bodyW)}" height="${r1(bodyH)}">${path}${feeds}</svg>${tiles}</div>`;
}

/** An ISA-5.1 tag: function letters and a loop number, e.g. 'TT-201', 'LSH201'. */
export function isTag(s: string | undefined): boolean {
  return /^[A-Z]{1,5}-?\d{1,5}[A-Z]?$/.test(s ?? "");
}

/** An ISA-5.1 bubble's text: function letters over the loop number. */
function bubbleText(tag: string, cx: number, cy: number, r: number): string {
  // ISA-5.1: the function letters on top, the loop number below, sized to the bubble.
  const [, letters = tag, num = ""] = /^([A-Z]+)-?(.*)$/.exec(tag) ?? [];
  const f = r / 3.3;
  return `<text class="inst-fn" x="${r1(cx)}" y="${r1(cy - 0.2 * f)}" style="font-size:${r1(1.75 * f)}px">${esc(letters)}</text><text class="inst-no" x="${r1(cx)}" y="${r1(cy + 1.9 * f)}" style="font-size:${r1(1.45 * f)}px">${esc(num)}</text>`;
}

/**
 * Equipment state, three things each in its own place (the same signs as the machine corner and
 * the alarm counters): the run state before the name (▶ running, ■ stopped), the mode after it
 * (a hand in Manual, nothing in Auto), the condition at the symbol's corner (a warning triangle or
 * an alarm circle, nothing when OK). A valve's position is its fill (closed filled, as on a P&ID).
 */
function runSign(x: number, cy: number, v: string, bind: Bind): string {
  const s = SIGN.run;
  return `<g class="rs" ${bind({ kind: "on", v })}><path class="rs-on" d="M${r1(x)} ${r1(cy - s * 0.58)}L${r1(x + s)} ${r1(cy)}L${r1(x)} ${r1(cy + s * 0.58)}Z"/><rect class="rs-off" x="${r1(x + 0.08)}" y="${r1(cy - s * 0.44)}" width="${r1(s * 0.88)}" height="${r1(s * 0.88)}" rx=".1"/></g>`;
}
function handSign(x: number, cy: number, v: string, bind: Bind): string {
  const s = SIGN.hand / 24;
  return `<g class="md" ${bind({ kind: "on", v })}><path d="${ICONS.manual}" transform="translate(${r1(x)} ${r1(cy - SIGN.hand / 2)}) scale(${s})"/></g>`;
}
/** The condition badge centred at (x, y): the alarm while `fault`, else the warning while `warning`. */
function condBadge(x: number, y: number, fault: string | undefined, warning: string | undefined, bind: Bind): string {
  if (!fault && !warning) return "";
  const warn = warning ? `<g class="cb-w" ${bind({ kind: "on", v: warning })}><path class="cb-wt" d="M0 -1.15L1.3 1.05H-1.3Z"/><path class="cb-wx" d="M0 -.42V.32M0 .66V.67"/></g>` : "";
  const alarm = fault ? `<g class="cb-a"><circle r="1.2"/><path d="M0 -.62V.12M0 .55V.56"/></g>` : "";
  return `<g class="cb" transform="translate(${r1(x)} ${r1(y)})" ${fault ? bind({ kind: "fault", v: fault }) : ""}>${warn}${alarm}</g>`;
}

function describeArc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin((a * Math.PI) / 180), cy - r * Math.cos((a * Math.PI) / 180)].map(r1);
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
}

const DEFS = `<defs>
<linearGradient id="gShell" x1="0" x2="1"><stop offset="0" stop-color="var(--shell-a)"/><stop offset=".5" stop-color="var(--shell-b)"/><stop offset="1" stop-color="var(--shell-a)"/></linearGradient>
<linearGradient id="gLiquid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--liq-a)"/><stop offset="1" stop-color="var(--liq-b)"/></linearGradient>
<radialGradient id="gHub" cx=".35" cy=".35" r=".8"><stop offset="0" stop-color="var(--hub-a)"/><stop offset="1" stop-color="var(--hub-b)"/></radialGradient>
<filter id="fGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
</defs>`;

/** A library symbol drawn at the origin, in diagram units (shared with the symbol preview). */
export function symbolMarkup(name: string, d: SymbolDef, size: number, rotate = 0): string {
  const { w, h } = symbolSize(d, size);
  return `<g${rotate ? ` transform="rotate(${rotate})"` : ""}><svg x="${r1(-w / 2)}" y="${r1(-h / 2)}" width="${r1(w)}" height="${r1(h)}" viewBox="0 0 ${d.viewBox[0]} ${d.viewBox[1]}" overflow="visible">${upright(scopeIds(d.svg, `sym-${name}`), rotate)}</svg></g>`;
}


function processSvg(p: ProcessItem, sy: number, bind: Bind, id: (p: string) => string, face: Face, lib: SymbolLib, placed: Map<string, PlacedLabel> = new Map(), all: ProcessItem[] = []): string {
  const Y = (y: number) => r1(y * sy);
  // The label's place, clear of the rest of the drawing (labels.ts placeTexts).
  const pl = placed.get(textKey(p));
  const spot = undefined as { side: string; x: number } | undefined;
  // The anchor is a class: .p-label's CSS text-anchor would override an attribute.
  const text = (x: number, y: number, t: string, anchor = "middle") => `<text class="p-label${anchor === "start" ? " left" : anchor === "end" ? " right" : ""}" x="${r1(x)}" y="${Y(y)}">${esc(t)}</text>`;
  const label = (x: number, y: number, t?: string, box?: { x0: number; x1: number; y0: number; ymid: number }) => {
    if (pl) {
      // The name line: the run sign, the name, the mode hand.
      const parts = nameParts(p);
      // A name inside a vessel sits on the liquid: the text colour reads there (muted grey doesn't).
      const inside = p.type === "tank" && pl.y > p.y * sy && pl.y < (p.y + p.h) * sy;
      return `${parts.run ? runSign(pl.x0, pl.y, parts.run, bind) : ""}${t ? `<text class="p-label left${inside ? " in-vessel" : ""}" x="${r1(pl.textX)}" y="${r1(pl.y + 0.6)}">${esc(t)}</text>` : ""}${parts.manual ? handSign(pl.textEnd + 0.5, pl.y, parts.manual, bind) : ""}${parts.value ? `<text class="p-val" x="${r1(pl.x0)}" y="${r1(pl.valueY + 0.62)}" ${bind({ kind: "text", v: parts.value, decimals: "decimals" in p ? (p.decimals ?? 1) : 1, unit: "unit" in p ? p.unit : undefined })}>–</text>` : ""}`;
    }
    if (!t) return "";
    if (spot?.side === "below-left") return text(spot.x - 1.4, y, t, "end");
    if (spot?.side === "below-right") return text(spot.x + 1.4, y, t, "start");
    // Beside, on the right; near the right edge above it instead (to its left it would read as its neighbour's).
    if (spot?.side === "beside" && box) return box.x1 > 85 ? text(x, box.y0 - 0.8 / sy, t) : text(box.x1 + 1, box.ymid + 0.6 / sy, t, "start");
    if (spot?.side === "above" && box) return text(x, box.y0 - 0.8 / sy, t);
    return text(x, y, t);
  };
  return processSvgItem();
  function processSvgItem(): string {
  switch (p.type) {
    case "symbol": {
      const f = findSymbol(lib, p.symbol);
      if (!f) return "";
      const [name, d] = f;
      const box = symbolBox(d, p, sy);
      const click = p.faceplate ? `class="clickable" ${face(p.label ?? name, p.faceplate, { running: p.on, fault: p.fault })}` : "";
      // An instrument symbol is an ISA-5.1 bubble: its tag inside, no label under it.
      const inst = INSTRUMENT_SYMBOLS[name];
      const tagText = inst ? bubbleText(isTag(p.label) ? p.label! : inst, p.x, Y(p.y), (p.size / 2) * 0.8) : "";
      const valve = /valve/i.test(name) && !!p.on;
      return `<g ${click}><g class="sym sym-${esc(name)}${valve ? " vlv" : ""}" ${valve ? bind({ kind: "on", v: p.on! }) : ""}><g transform="translate(${r1(p.x)} ${Y(p.y)})">${symbolMarkup(name, d, p.size, p.rotate ?? 0)}</g>${tagText}</g>${condBadge(box.x1 + 0.3, box.y0 * sy - 0.3, p.fault, p.warning, bind)}${inst ? "" : label(p.x, box.y1 + 2.6 / sy, p.label, { x0: box.x0, x1: box.x1, y0: box.y0, ymid: p.y })}</g>`;
    }
    case "pipe": {
      const d = (p.points ?? []).map(([x, y], i) => `${i ? "L" : "M"}${r1(x)} ${Y(y)}`).join(" ");
      if (p.signal) return `<path class="signal" d="${d}"/>`;
      return `<g class="pipe" ${p.flow ? bind({ kind: "on", v: p.flow }) : ""}><path class="pipe-outer" d="${d}"/><path class="pipe-inner" d="${d}"/><path class="pipe-flow" d="${d}"/></g>`;
    }
    case "tank": {
      const x = r1(p.x), y = Y(p.y), w = r1(p.w), h = Y(p.h);
      const clip = id("tk");
      // Scale marks at a quarter and three quarters: the level number marks the middle, so no tick runs into it.
      const ticks = [0.25, 0.75].map((f) => `<line x1="${r1(x + w - 2.2)}" x2="${r1(x + w - 0.8)}" y1="${r1(y + h * (1 - f))}" y2="${r1(y + h * (1 - f))}"/>`).join("");
      // ISO 10628-2 1.5: a vessel with dished ends; the level as a flat fill and its value in the text colour.
      const dish = r1(Math.min(w * 0.18, h * 0.12));
      const shell = `M${x} ${r1(y + dish)}Q${x} ${y} ${r1(x + w / 2)} ${y}Q${r1(x + w)} ${y} ${r1(x + w)} ${r1(y + dish)}V${r1(y + h - dish)}Q${r1(x + w)} ${r1(y + h)} ${r1(x + w / 2)} ${r1(y + h)}Q${x} ${r1(y + h)} ${x} ${r1(y + h - dish)}Z`;
      return `<g class="tank" ${bind({ kind: "level", v: p.level, min: 0, max: p.max, bands: p.bands })}>
<clipPath id="${clip}"><path d="${shell}"/></clipPath>
<path class="tank-shell" d="${shell}"/>
<g clip-path="url(#${clip})"><g class="tank-liq" style="transform-origin:${x}px ${r1(y + h)}px"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></g></g>
<path class="tank-out" d="${shell}"/>
<g class="tank-ticks">${ticks}</g>
<text class="tank-num" x="${r1(x + w / 2)}" y="${r1(y + h / 2 + 1.5)}" ${bind({ kind: "text", v: p.level, decimals: 0, unit: p.unit })}>–</text>
${label(x + w / 2, p.y + p.h + 2.8 / sy, p.label)}</g>`;
    }
    case "pump": {
      // The casing with the discharge nozzle tangential at its top, out to the right (ports: in on the axis, out at the nozzle).
      // ISO 10628-2 2322 (centrifugal pump): a circle, lines from its top and bottom to the outlet, the axis through it.
      const s = p.size, cx = r1(p.x), cy = Y(p.y), r = r1((s / 2) * PUMP_CASING);
      return `<g ${p.faceplate ? `class="clickable" ${face(p.label ?? "Pump", p.faceplate, { running: p.running, fault: p.fault })}` : ""}><g class="pump">
<circle class="pump-body" cx="${cx}" cy="${cy}" r="${r}"/>
<path class="pump-tri" d="M${cx} ${r1(cy - r)}L${r1(cx + r)} ${cy}L${cx} ${r1(cy + r)}M${r1(cx - r)} ${cy}H${r1(cx + r)}"/>
</g>${condBadge(cx + r * 0.85, cy - r * 0.85, p.fault, p.warning, bind)}
${label(p.x, p.y + (s / 2 + 2.6) / sy, p.label)}</g>`;
    }
    case "fan": {
      // A fan (ISO 10628-2 17): the casing and three blades, still (no animation, as ISA-101 asks).
      const s = p.size, cx = r1(p.x), cy = Y(p.y), r = r1(s / 2);
      const blades = [0, 120, 240].map((a) => `<path d="M0 0C${r1(r * 0.45)} ${r1(-r * 0.15)} ${r1(r * 0.45)} ${r1(-r * 0.6)} 0 ${r1(-r * 0.72)}C${r1(-r * 0.2)} ${r1(-r * 0.5)} ${r1(-r * 0.12)} ${r1(-r * 0.2)} 0 0Z" transform="rotate(${a})"/>`).join("");
      void blades;
      // ISO 10628-2 X8164 (blower, fan): a circle with the blades as a wedge from the inlet side to the centre.
      const k = r * Math.SQRT1_2;
      return `<g class="pump fan${p.faceplate ? " clickable" : ""}" ${p.faceplate ? face(p.label ?? "Fan", p.faceplate, { running: p.running, fault: p.fault }) : ""}><circle class="pump-body" cx="${cx}" cy="${cy}" r="${r}"/><path class="pump-tri" d="M${r1(cx - k)} ${r1(cy - k)}L${cx} ${cy}L${r1(cx - k)} ${r1(cy + k)}M${cx} ${cy}H${r1(cx + r)}"/>${condBadge(cx + r * 0.85, cy - r * 0.85, p.fault, p.warning, bind)}${label(p.x, p.y + (s / 2 + 2.6) / sy, p.label)}</g>`;
    }
    case "valve": {
      const s = p.size, cx = r1(p.x), cy = Y(p.y), h = r1(s / 2);
      // ISO 10628-2 21.1: two triangles meeting in the middle; filled while closed, hollow open (as on a P&ID).
      const body = `<path class="valve-body" d="M${r1(-h)} ${r1(-h * 0.5)}L0 0L${r1(-h)} ${r1(h * 0.5)}ZM${h} ${r1(-h * 0.5)}L0 0L${h} ${r1(h * 0.5)}Z"/>`;
      return `<g class="valve${p.faceplate ? " clickable" : ""}" ${bind({ kind: "on", v: p.open })} ${p.faceplate ? face(p.label ?? "Valve", p.faceplate, { open: p.open }) : ""}><g transform="translate(${cx} ${cy})${p.vertical ? " rotate(90)" : ""}">${body}</g>${condBadge(cx + (p.vertical ? h * 0.5 : h), cy - (p.vertical ? h : h * 0.5) - 0.4, p.fault, p.warning, bind)}${label(p.x, p.y + (s / 2 + 2.6) / sy, p.label)}</g>`;
    }
    case "instrument": {
      // ISA-5.1: a bubble with the function letters over the loop number, joined by a
      // process connection to what it measures. A tripped switch (its BOOL TRUE) keeps a white bubble and gets
      // the equipment's condition badge at its corner: the red alarm with tone 'alarm', else the amber warning.
      const cx = r1(p.x), cy = Y(p.y), R = 3.3;
      const tap = instrumentTap(p, all, sy, lib);
      let conn = "";
      if (tap) {
        const [tx, ty] = [r1(tap.at[0]), Y(tap.at[1])];
        const vertical = tap.dir === "u" || tap.dir === "d";
        const d = vertical
          ? Math.abs(tx - cx) < 0.3 ? `M${tx} ${ty}V${r1(ty < cy ? cy - R : cy + R)}` : `M${tx} ${ty}V${cy}H${r1(tx < cx ? cx - R : cx + R)}`
          : Math.abs(ty - cy) < 0.3 ? `M${tx} ${ty}H${r1(tx < cx ? cx - R : cx + R)}` : `M${tx} ${ty}H${cx}V${r1(ty < cy ? cy - R : cy + R)}`;
        conn = `<path class="inst-conn" d="${d}"/><circle class="inst-tap" cx="${tx}" cy="${ty}" r="0.5"/>`;
      }
      const [, letters = p.tag, num = ""] = /^([A-Z]+)-?(.*)$/.exec(p.tag) ?? [];
      const rs = p.value ? readingSpot(p, all, sy, lib, tapY(p, all, sy, lib)) : undefined;
      const reading = p.value && rs ? `<rect class="sen-box" x="${r1(rs.x - READING.w / 2)}" y="${r1(rs.y - READING.h / 2)}" width="${READING.w}" height="${READING.h}" rx="${READING.h / 2}"/><text class="sen-num" x="${r1(rs.x)}" y="${r1(rs.y + 0.62)}" ${bind({ kind: "text", v: p.value, decimals: p.decimals ?? 1, unit: p.unit })}>–</text>` : "";
      const trip = p.on ? (p.tone === "alarm" ? condBadge(cx + R + 0.3, cy - R - 0.3, p.on, undefined, bind) : condBadge(cx + R + 0.3, cy - R - 0.3, undefined, p.on, bind)) : "";
      return `${conn}<g class="inst"><circle class="inst-bubble" cx="${cx}" cy="${cy}" r="${R}"/><text class="inst-fn" x="${cx}" y="${r1(cy - 0.2)}">${esc(letters)}</text><text class="inst-no" x="${cx}" y="${r1(cy + 1.9)}">${esc(num)}</text></g>${trip}${reading}`;
    }
    case "sensor": {
      // An ISA-5.1 instrument bubble (its label as the tag, e.g. 'TT-201'), the reading beside it,
      // and the process connection to the point on the line it measures.
      const cx = r1(p.x), cy = Y(p.y), R = 3.3;
      const tagged = isTag(p.label);
      const at = nearestOnLine(all, p.x, p.y, sy, 9);
      let path = "";
      if (at) {
        const [ax, ay] = [r1(at[0]), Y(at[1])];
        path = Math.abs(ay - cy) <= R ? `M${ax} ${ay}H${r1(ax < cx ? cx - R : cx + R)}` : Math.abs(ax - cx) <= R ? `M${ax} ${ay}V${r1(ay < cy ? cy - R : cy + R)}` : `M${ax} ${ay}V${cy}H${r1(ax < cx ? cx - R : cx + R)}`;
      }
      const lead = at ? `<path class="inst-conn" d="${path}"/><circle class="inst-tap" cx="${r1(at[0])}" cy="${Y(at[1])}" r="0.5"/>` : "";
      // A value that isn't an instrument (no ISA tag as its label) is a plain reading with its label above.
      const num = (x: number, y = cy) => `<rect class="sen-box" x="${r1(x - READING.w / 2)}" y="${r1(y - READING.h / 2)}" width="${READING.w}" height="${READING.h}" rx="${READING.h / 2}"/><text class="sen-num" x="${r1(x)}" y="${r1(y + 0.62)}" ${bind({ kind: "text", v: p.value, decimals: p.decimals ?? 1, unit: p.unit })}>–</text>`;
      if (!tagged) return `${lead.replace(/H([-\d.]+)"/, (m, hx: string) => `H${r1(Number(hx) < cx ? cx - 6 : cx + 6)}"`)}${num(cx)}${p.label ? `<text class="sen-tag" x="${cx}" y="${r1(cy - 2.8)}">${esc(p.label)}</text>` : ""}`;
      // The reading beside the bubble, on the side where no vessel or symbol is in the way (else above or below it).
      const rs = readingSpot(p, all, sy, lib, tapY(p, all, sy, lib));
      const reading = num(rs.x, rs.y);
      return `${lead}<g class="inst"><circle class="inst-bubble" cx="${cx}" cy="${cy}" r="${R}"/>${bubbleText(p.label!, p.x, cy, R)}</g>${reading}`;
    }
    case "lamp": {
      const cx = r1(p.x), cy = Y(p.y);
      return `<g class="plamp tone-${toneOf(p.tone ?? "ok")}" ${bind({ kind: "on", v: p.on })}><circle class="pl-halo" cx="${cx}" cy="${cy}" r="2.2"/><circle class="pl-dot" cx="${cx}" cy="${cy}" r="1.3"/>${p.label ? `<text class="p-label left" x="${r1(cx + 3)}" y="${r1(cy + 0.65)}">${esc(p.label)}</text>` : ""}</g>`;
    }
    case "junction":
      return `<circle class="junction" cx="${r1(p.x)}" cy="${Y(p.y)}" r="1.1"/>`;
    case "label":
      return `<text class="p-text" x="${r1(p.x)}" y="${Y(p.y)}">${esc(p.text)}</text>`;
  }
  }
}

export const HMI_CSS = String.raw`
.hmi{position:relative;overflow:hidden;font-family:"Segoe UI Variable Text","Segoe UI",Inter,system-ui,sans-serif;color:var(--fg);background:var(--bg);box-sizing:border-box;-webkit-font-smoothing:antialiased;
--r:calc(8px*var(--k));--rs:calc(6px*var(--k));
--f-title:calc(18px*var(--k));--f-card:calc(13px*var(--k));--f-body:calc(14px*var(--k));--f-small:calc(12px*var(--k));--f-tiny:calc(11px*var(--k));--f-value:calc(34px*var(--k));--f-valueS:calc(24px*var(--k));--f-unit:calc(14px*var(--k));
--tile:var(--surface);--tile-bd:var(--line);--btn:var(--surface2);--pipe-in:var(--surface2);--shell-a:var(--equip);--shell-b:var(--surface);--liq-a:var(--liquid);--liq-b:var(--liquid);--hub-a:var(--surface);--hub-b:var(--equip)}
.hmi *{box-sizing:border-box}
.hmi button{font-family:inherit}
.ic{flex:none;display:block}
.tone-accent,[data-tone=accent]{--c:var(--accent);--on-c:var(--on-accent);--c-soft:var(--accent-soft)}
.tone-ok,[data-tone=ok]{--c:var(--ok);--on-c:var(--on-ok);--c-soft:var(--ok-soft)}
.tone-warn,[data-tone=warn]{--c:var(--warn);--on-c:var(--on-warn);--c-soft:var(--warn-soft)}
.tone-alarm,[data-tone=alarm]{--c:var(--alarm);--on-c:var(--on-alarm);--c-soft:var(--alarm-soft)}
.tone-neutral,[data-tone=neutral]{--c:var(--neutral);--on-c:var(--on-neutral);--c-soft:var(--neutral-soft)}
.h-bar{position:absolute;left:0;right:0;top:0;height:var(--bar);display:flex;align-items:center;gap:calc(20px*var(--k));padding:0 var(--pad);background:var(--surface);border-bottom:1px solid var(--line)}
.h-titles{min-width:0;flex:none;max-width:40%}
.h-title{font-size:var(--f-title);font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-sub{font-size:var(--f-small);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-info{flex:1 1 0;min-width:0;display:flex;flex-wrap:wrap;align-items:center;height:var(--bar);overflow:hidden}
.h-field{display:flex;flex-direction:column;justify-content:center;gap:1px;height:var(--bar);padding:0 calc(16px*var(--k));border-left:1px solid var(--line);white-space:nowrap}
.hf-l{font-size:var(--f-tiny);color:var(--muted)}.hf-v{font-size:var(--f-body);font-weight:600;font-variant-numeric:tabular-nums}
.h-right{margin-left:auto;display:flex;align-items:center;gap:calc(14px*var(--k));flex:none}
.h-bar.has-state{padding-left:0}
.h-state{flex:none;align-self:stretch;width:calc(210px*var(--k));display:flex;align-items:center;gap:calc(12px*var(--k));padding:0 calc(14px*var(--k)) 0 var(--pad);background:var(--surface2);border-right:1px solid var(--line)}
.h-state::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:calc(3px*var(--k));background:var(--c);transition:background .3s}
.hs-ring{flex:none;position:relative;width:calc(36px*var(--k));height:calc(36px*var(--k));border-radius:50%;border:2px solid var(--c);display:flex;align-items:center;justify-content:center;color:var(--c);transition:border-color .3s,color .3s}
.st-ic{display:none}
[data-i="0"] .g0,[data-i="1"] .g1,[data-i="2"] .g2,[data-i="3"] .g3,[data-i="4"] .g4,[data-i="5"] .g5,[data-i="6"] .g6{display:block}
.hs-t{min-width:0;display:flex;flex-direction:column;gap:1px}
.h-state .st-text{font-size:var(--f-body);font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hs-d{font-size:var(--f-tiny);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h-alarms{display:flex;align-items:center;gap:calc(12px*var(--k))}
.h-cnt{display:flex;align-items:center;gap:calc(5px*var(--k));color:var(--muted);font-weight:600;font-size:var(--f-body);font-variant-numeric:tabular-nums}
.h-cnt .ic{opacity:.55}.h-cnt.on{color:var(--fg)}.h-cnt.on .ic{opacity:1;color:var(--c)}
.h-cnt.sev-alarm{--c:var(--alarm)}.h-cnt.sev-warning{--c:var(--warn)}.h-cnt.sev-info{--c:var(--accent)}
.h-dock{position:absolute;left:var(--rail);right:0;bottom:0;height:var(--dock);display:flex;align-items:center;gap:calc(16px*var(--k));padding:0 var(--pad);background:var(--surface);border-top:1px solid var(--line)}
.d-mode{flex:none;width:calc(260px*var(--k))}.d-mode .seg-b{min-height:calc(40px*var(--k))}
.d-btns{margin-left:auto;display:flex;gap:calc(10px*var(--k))}.d-btns .btn{flex:none;width:calc(132px*var(--k))}
.h-sim{display:flex;align-items:center;gap:calc(7px*var(--k));font-size:var(--f-small);color:var(--muted)}
.h-sim .dot{width:calc(8px*var(--k));height:calc(8px*var(--k));border-radius:50%;background:var(--neutral)}
.h-sim.run .dot{background:var(--ok)}.h-sim.stop .dot{background:var(--warn)}
.h-clock{font-size:var(--f-body);font-variant-numeric:tabular-nums;color:var(--text2);min-width:calc(64px*var(--k));text-align:right}
.h-langs{display:flex;align-items:center;gap:2px;color:var(--muted)}.h-langs .ic{margin-right:4px}
.h-lang{border:0;background:transparent;color:var(--text2);font-weight:600;font-size:var(--f-tiny);padding:calc(5px*var(--k)) calc(7px*var(--k));border-radius:4px;cursor:pointer}.h-lang.cur{background:var(--accent-soft);color:var(--accent)}
.h-rail{position:absolute;left:0;top:var(--bar);bottom:0;width:var(--rail);background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:calc(4px*var(--k));padding:calc(10px*var(--k)) calc(8px*var(--k))}
.r-page{position:relative;border:0;background:transparent;border-radius:var(--rs);padding:calc(10px*var(--k)) 2px calc(8px*var(--k));display:flex;flex-direction:column;align-items:center;gap:calc(5px*var(--k));color:var(--text2);font-size:var(--f-tiny);font-weight:500;line-height:1.15;text-align:center;cursor:pointer}
.r-page .ic{width:calc(22px*var(--k));height:calc(22px*var(--k))}
.r-page:hover{background:var(--surface2)}
.r-page.cur{background:var(--accent-soft);color:var(--accent);font-weight:600}
.r-page.cur::before{content:"";position:absolute;left:calc(-8px*var(--k));top:22%;bottom:22%;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.tile{position:absolute;border-radius:var(--r);background:var(--surface);border:1px solid var(--line);display:flex;flex-direction:column;padding:calc(14px*var(--k)) calc(16px*var(--k))}
.theme-light .tile{box-shadow:0 1px 2px rgba(16,24,32,.05)}
.t-head{display:flex;align-items:center;gap:calc(8px*var(--k));height:calc(20px*var(--k));margin-bottom:calc(10px*var(--k));flex:none;color:var(--text2)}
.t-ic{width:calc(16px*var(--k));height:calc(16px*var(--k));color:var(--muted)}
.t-title{font-size:var(--f-tiny);font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.t-lock{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:var(--f-tiny);color:var(--muted)}
.untitled>.t-lock{position:absolute;top:calc(10px*var(--k));right:calc(12px*var(--k))}
.t-body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:calc(8px*var(--k));position:relative}
.v-main{display:flex;align-items:baseline;gap:calc(6px*var(--k))}
.v-num{font-weight:400;letter-spacing:-.01em;font-variant-numeric:tabular-nums;line-height:1;color:var(--fg)}
.v-num[data-tone=warn]::after,.v-num[data-tone=alarm]::after,.bar-num[data-tone=warn]::after,.bar-num[data-tone=alarm]::after{content:"";display:inline-block;width:.28em;height:.28em;margin-left:.18em;vertical-align:.55em;border-radius:50%;background:var(--c)}
.v-unit{font-size:var(--f-unit);color:var(--muted)}
.v-pair{display:flex;gap:calc(24px*var(--k));align-items:flex-end}.v-col{display:flex;flex-direction:column;gap:calc(4px*var(--k));min-width:0}
.v-lab,.sp-l{font-size:var(--f-small);color:var(--text2)}.v-num.v-setn{color:var(--fg)}
.v-scale{display:flex;flex-direction:column;gap:calc(4px*var(--k))}
.v-track{position:relative;height:calc(6px*var(--k));border-radius:3px;background:var(--track);--p:0}
.v-fill{position:absolute;left:0;top:0;bottom:0;width:calc(var(--p) * 100%);border-radius:3px;background:var(--c,var(--accent));transition:width .5s cubic-bezier(.2,.8,.2,1)}
.v-set{position:absolute;top:calc(-4px*var(--k));bottom:calc(-4px*var(--k));left:calc(var(--p) * 100%);width:2px;margin-left:-1px;border-radius:1px;background:var(--fg);--p:0;transition:left .5s}
.v-lims{display:flex;justify-content:space-between;font-size:var(--f-tiny);color:var(--muted);font-variant-numeric:tabular-nums}
.spark{width:100%;height:30%;flex:none}.spark-line{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}.spark-fill{fill:var(--accent-soft)}
.gauge{display:block;margin:0 auto;--p:0;overflow:visible}
.g-track,.g-val{fill:none;stroke-width:10}.g-track{stroke:var(--track)}
.g-val{stroke:var(--c,var(--accent));stroke-dashoffset:calc(var(--len) * (1 - var(--p)));transition:stroke-dashoffset .5s cubic-bezier(.2,.8,.2,1),stroke .3s}
.g-num{font-size:30px;font-weight:400;text-anchor:middle;fill:var(--fg);font-variant-numeric:tabular-nums}.g-unit{font-size:14px;text-anchor:middle;fill:var(--muted)}.g-lim{font-size:12px;fill:var(--muted);text-anchor:middle}
.bar-wrap{display:flex;flex-direction:column;gap:calc(8px*var(--k))}
.bar{position:relative;height:calc(10px*var(--k));border-radius:calc(5px*var(--k));background:var(--track);--p:0}
.bar-fill{position:absolute;left:0;top:0;bottom:0;width:calc(var(--p) * 100%);border-radius:calc(5px*var(--k));background:var(--c,var(--accent));transition:width .5s cubic-bezier(.2,.8,.2,1),height .5s}
.bar-num{font-size:var(--f-valueS);font-weight:400;font-variant-numeric:tabular-nums;color:var(--fg);line-height:1}
.bar-wrap.vert{flex-direction:row;height:100%;align-items:stretch;gap:calc(14px*var(--k))}
.bar-wrap.vert .bar{width:calc(14px*var(--k));height:auto}
.bar-wrap.vert .bar-fill{top:auto;right:0;width:auto;height:calc(var(--p) * 100%)}
.bar-wrap.vert .v-set{left:calc(-4px*var(--k));right:calc(-4px*var(--k));top:auto;bottom:calc(var(--p) * 100%);width:auto;height:2px;margin:0 0 -1px}
.bar-read{display:flex;flex-direction:column;justify-content:flex-end;gap:calc(4px*var(--k))}.bar-unit{color:var(--muted);font-size:var(--f-unit)}.bar-lim{color:var(--muted);font-size:var(--f-tiny)}
.status{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:calc(10px*var(--k))}
.led{display:flex;align-items:center;gap:calc(10px*var(--k));font-size:var(--f-body);color:var(--muted);transition:color .3s}
.led{color:var(--text2)}.led-dot{width:calc(12px*var(--k));height:calc(12px*var(--k));border-radius:50%;border:2px solid var(--neutral);background:transparent;transition:background .3s;flex:none}
.led.on{color:var(--fg)}.led.on .led-dot{background:var(--c);border-color:var(--c)}
.btns{display:flex;gap:calc(10px*var(--k));height:100%;align-items:center}.btns.col{flex-direction:column;align-items:stretch;justify-content:center}
.btns.grid{display:grid;grid-template-columns:1fr 1fr;align-content:center}
.btn{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:calc(8px*var(--k));min-height:calc(44px*var(--k));padding:0 calc(14px*var(--k));border-radius:var(--rs);border:1px solid var(--c);background:var(--c);color:var(--on-c);font-size:var(--f-body);font-weight:600;line-height:1;cursor:pointer;transition:filter .15s,background .15s}
.btn:hover{filter:brightness(1.07)}.btn:active,.btn.on{filter:brightness(.86)}
.btn{min-width:0}.btn>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.btn.icon-only{flex:none;width:calc(44px*var(--k));padding:0}.st-btns .btn.icon-only:not(.b-secondary){flex:1;width:auto}
.b-primary{--c:var(--accent);--on-c:var(--on-accent)}
.b-ok{--c:var(--ok);--on-c:var(--on-ok)}.b-warn{--c:var(--warn);--on-c:var(--on-warn)}.b-alarm{--c:var(--alarm);--on-c:var(--on-alarm)}
.btn.b-secondary{background:var(--surface);color:var(--fg);border:1px solid var(--ctl)}.btn.b-secondary:hover{background:var(--surface2);filter:none}.btn.b-secondary.on,.btn.b-secondary:active{background:var(--track);filter:none}
.b-ic{width:calc(18px*var(--k));height:calc(18px*var(--k))}
.sw{display:flex;align-items:center;gap:calc(12px*var(--k));cursor:pointer;user-select:none}
.sw-track{width:calc(48px*var(--k));height:calc(28px*var(--k));border-radius:999px;background:var(--track);position:relative;transition:background .2s;flex:none}
.sw-knob{position:absolute;top:calc(3px*var(--k));left:calc(3px*var(--k));width:calc(22px*var(--k));height:calc(22px*var(--k));border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.sw.on .sw-track{background:var(--accent)}.sw.on .sw-knob{transform:translateX(calc(20px*var(--k)))}
.sw-lbl{font-size:var(--f-body);flex:1}.sw-state{font-size:var(--f-small);font-weight:600;color:var(--muted)}.sw .s-on{display:none}.sw.on .s-on{display:inline;color:var(--accent)}.sw.on .s-off{display:none}
.seg{display:flex;gap:3px;padding:3px;border-radius:999px;background:var(--surface2);border:1px solid var(--line)}
.seg-b{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:calc(7px*var(--k));min-height:calc(40px*var(--k));border:0;border-radius:999px;background:transparent;color:var(--text2);font-size:var(--f-body);font-weight:600;cursor:pointer;transition:background .15s,color .15s,box-shadow .15s}
.seg-b:hover{color:var(--fg)}.seg-b.on{background:var(--surface);color:var(--accent);box-shadow:inset 0 0 0 1.5px var(--accent)}
.st{display:flex;flex-direction:column;justify-content:center;gap:calc(14px*var(--k));height:100%}
.st::before{content:"";position:absolute;left:0;right:0;top:0;height:calc(3px*var(--k));border-radius:var(--r) var(--r) 0 0;background:var(--c);transition:background .3s}
.t-state .t-body{position:static}
.st-row{display:flex;align-items:center;gap:calc(12px*var(--k));min-width:0}
.st-text{font-weight:600;line-height:1.15;color:var(--fg);overflow:hidden}
.st-btns{flex:none;height:auto}
.sp{display:flex;gap:calc(20px*var(--k));align-items:flex-end}.sp-act{flex:1;min-width:0;display:flex;flex-direction:column;gap:calc(4px*var(--k))}
.sp-anum{font-size:var(--f-value)}
.sp-set{flex:1;min-width:0;display:flex;flex-direction:column;gap:calc(6px*var(--k))}
.sp-row{display:flex;align-items:stretch;gap:calc(8px*var(--k))}
.sp-btn{width:calc(44px*var(--k));min-height:calc(44px*var(--k));border-radius:var(--rs);border:1px solid var(--line);background:var(--surface);color:var(--fg);font-size:calc(20px*var(--k));line-height:1;cursor:pointer}.sp-btn:hover{background:var(--surface2)}
.sp-val{flex:1;display:flex;align-items:baseline;justify-content:center;gap:calc(6px*var(--k));padding:calc(8px*var(--k)) 0;border-radius:var(--rs);background:var(--surface2);border:1px solid var(--line)}
.sp-num{font-size:var(--f-valueS);font-weight:400;font-variant-numeric:tabular-nums;line-height:1}.sp-unit{font-size:var(--f-small);color:var(--muted)}
.sp-lim{color:var(--muted);font-size:var(--f-tiny);text-align:center}
.tr-legend{display:flex;gap:calc(14px*var(--k));font-size:var(--f-small);color:var(--text2);flex-wrap:wrap;flex:none}.tr-legend i{display:inline-block;width:calc(12px*var(--k));height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.t-trend .t-body{justify-content:flex-start}
.tr-plot{position:relative;flex:1;min-height:0;display:flex}.trend{flex:1;width:100%;height:100%;min-height:0}
.tr-max,.tr-min{position:absolute;left:0;font-size:var(--f-tiny);color:var(--muted);font-variant-numeric:tabular-nums;background:var(--surface);padding-right:4px;line-height:1}.tr-max{top:0}.tr-min{bottom:0}.tr-grid line{stroke:var(--line);stroke-width:1;vector-effect:non-scaling-stroke}
.tr-line{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round}
.tr-axis{display:flex;justify-content:space-between;font-size:var(--f-tiny);color:var(--muted);flex:none}
.t-alarms .t-body,.t-status .t-body,.t-recipe .t-body{justify-content:flex-start}
.alarms{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:0;flex:none}
.al{display:none;align-items:center;gap:calc(10px*var(--k));padding:0 calc(2px*var(--k));min-height:calc(38px*var(--k));border-bottom:1px solid var(--line);font-size:var(--f-body);line-height:1.25}
.al.active{display:flex}
.sev-alarm{--c:var(--alarm);--c-soft:var(--alarm-soft)}.sev-warning{--c:var(--warn);--c-soft:var(--warn-soft)}.sev-info{--c:var(--accent);--c-soft:var(--accent-soft)}
.al-ic{width:calc(18px*var(--k));height:calc(18px*var(--k));color:var(--c)}
.al.active:not(.cleared):not(.acked) .al-ic{animation:blink 1s steps(2,jump-none) infinite}
.al-text{flex:1;color:var(--fg)}.al-st{font-size:var(--f-tiny);color:var(--text2);white-space:nowrap}
.al.cleared .al-text{color:var(--text2)}
.al-ack{display:none;align-items:center;justify-content:center;width:calc(36px*var(--k));height:calc(30px*var(--k));border-radius:var(--rs);border:1px solid var(--line);background:var(--surface);color:var(--fg);cursor:pointer}.al-ack:hover{background:var(--surface2)}
.al.can-ack .al-ack{display:inline-flex}
.al-none{display:flex;align-items:center;gap:calc(8px*var(--k));color:var(--text2);font-size:var(--f-body)}.al-none .ic{color:var(--ok)}
.alarms.has .al-none{display:none}
.al-hist-h{margin-top:calc(8px*var(--k));padding-top:calc(8px*var(--k));border-top:1px solid var(--line);font-size:var(--f-small);font-weight:600;color:var(--text2);flex:none}
.t-alarms .t-body{overflow:hidden}
.al-hist{list-style:none;margin:0;padding:0;font-size:var(--f-small);flex:1 1 0;min-height:0;overflow:hidden;display:flex;flex-direction:column;flex-wrap:wrap;align-content:flex-start}.al-hist li{width:100%;display:flex;gap:calc(12px*var(--k));padding:calc(5px*var(--k)) 0;border-bottom:1px solid var(--line)}.al-hist li:last-child{border-bottom:0}
.al-hist .h-t{color:var(--muted);font-variant-numeric:tabular-nums;flex:none}.al-hist .h-x{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.al-hist .h-s{color:var(--muted)}.al-hist .st-active .h-s{color:var(--alarm);font-weight:600}
.txt{font-size:var(--f-body);line-height:1.5;color:var(--text2)}.t-text .t-body{justify-content:flex-start}
.rcp-active{font-size:var(--f-small);color:var(--text2);margin-bottom:calc(4px*var(--k))}.rcp-active b{color:var(--accent);margin-left:6px;font-size:var(--f-body)}
.rcp-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}.rcp-list li{display:flex;align-items:center;gap:calc(8px*var(--k));padding:calc(6px*var(--k)) 0;border-bottom:1px solid var(--line)}.rcp-list li:last-child{border-bottom:0}
.rcp-name{flex:1;min-width:0;font-size:var(--f-body);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rcp-btn{flex:none;min-height:calc(32px*var(--k));padding:0 calc(12px*var(--k));font-size:var(--f-small)}
.fp{position:absolute;inset:0;background:rgba(10,14,18,.45);display:flex;align-items:center;justify-content:center;z-index:20}.fp[hidden]{display:none}
.fp-card{width:calc(380px*var(--k));border-radius:var(--r);background:var(--surface);border:1px solid var(--line);box-shadow:0 12px 40px rgba(0,0,0,.25);padding:calc(16px*var(--k)) calc(18px*var(--k));display:flex;flex-direction:column;gap:calc(14px*var(--k))}
.fp-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:calc(10px*var(--k));border-bottom:1px solid var(--line)}.fp-title{font-size:var(--f-title);font-weight:600}
.fp-x{border:1px solid var(--line);background:var(--surface2);color:var(--fg);width:calc(32px*var(--k));height:calc(32px*var(--k));border-radius:var(--rs);font-size:calc(18px*var(--k));cursor:pointer}
.fp-status{display:flex;gap:calc(16px*var(--k))}.fp-btns{height:auto}
.fp-values{display:flex;flex-direction:column}.fp-row{display:flex;justify-content:space-between;font-size:var(--f-body);color:var(--text2);padding:calc(5px*var(--k)) 0;border-bottom:1px solid var(--line)}.fp-row:last-child{border-bottom:0}.fp-row b{color:var(--fg);font-variant-numeric:tabular-nums;font-weight:600}
.theme-contrast .tile,.theme-contrast .h-bar,.theme-contrast .h-rail,.theme-contrast .h-dock{border-width:2px}
.clickable{cursor:pointer}.clickable:hover .pump-ring,.clickable:hover .valve-body{stroke:var(--accent)}
.proc{width:100%;height:100%;overflow:visible}
.p-label{font-size:1.75px;fill:var(--muted);text-anchor:middle;font-weight:600;letter-spacing:.05em}.p-label.left{text-anchor:start}.p-label.in-vessel{fill:var(--fg)}.p-label.right{text-anchor:end}.p-text{font-size:2px;fill:var(--fg);font-weight:600}
.junction{fill:var(--pipe)}
.pump-body{fill:var(--equip);stroke:var(--equip-line);stroke-width:2px;vector-effect:non-scaling-stroke;transition:fill .3s}.pump.on .pump-body{fill:var(--equip-on)}
.pump-tri{fill:none;stroke:var(--equip-line);stroke-width:2px;vector-effect:non-scaling-stroke;stroke-linejoin:round}.pump.on .pump-tri{stroke:var(--equip-line-on)}
.rs .rs-on{display:none;fill:var(--accent)}.rs .rs-off{fill:var(--muted)}.rs.on .rs-on{display:inline}.rs.on .rs-off{display:none}
.md{display:none}.md.on{display:inline}.md path{fill:none;stroke:var(--accent);stroke-width:1.9px;stroke-linecap:round;stroke-linejoin:round}
.cb-a,.cb-w{display:none}.cb.fault .cb-a{display:inline}.cb:not(.fault) .cb-w.on{display:inline}
.cb-a circle{fill:var(--alarm)}.cb-a path{stroke:var(--on-alarm);stroke-width:.3px;stroke-linecap:round}
.cb-wt{fill:var(--warn);stroke:var(--warn);stroke-width:.25px;stroke-linejoin:round}.cb-wx{stroke:#1a232d;stroke-width:.28px;stroke-linecap:round}
.sym.vlv{--state:var(--equip-line)}.sym.vlv.on{--state:var(--surface)}
.inst-bubble{fill:var(--surface);stroke:var(--equip-line);stroke-width:2px;vector-effect:non-scaling-stroke}.inst-fn{font-size:1.75px;font-weight:700;fill:var(--fg);text-anchor:middle;letter-spacing:.04em}.inst-no{font-size:1.45px;fill:var(--muted);text-anchor:middle;font-variant-numeric:tabular-nums}.inst-conn{fill:none;stroke:var(--equip-line);stroke-width:1.5px;vector-effect:non-scaling-stroke}.inst-tap{fill:var(--muted)}.line-arrow{fill:var(--muted)}
.signal{fill:none;stroke:var(--equip-line);stroke-width:1.5px;vector-effect:non-scaling-stroke;stroke-dasharray:6 5}.sen-lead{fill:none;stroke:var(--muted);stroke-width:.3}.sen-tap{fill:var(--muted)}.p-line{font-size:1.9px;fill:var(--muted)}
.pipe-outer{fill:none;stroke:var(--pipe);stroke-width:4px;vector-effect:non-scaling-stroke;stroke-linecap:square;stroke-linejoin:miter}.pipe-inner{display:none}
.pipe-flow{display:none}.pipe-outer{transition:stroke .3s}.pipe.on .pipe-outer{stroke:var(--equip-line)}
.tank{--p:0}.tank-shell{fill:var(--surface)}.tank-out{fill:none;stroke:var(--equip-line);stroke-width:2px;vector-effect:non-scaling-stroke}.tank-liq{transform:scaleY(var(--p));transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.tank-liq rect{fill:var(--liquid)}.tank[data-tone=warn] .tank-liq rect{fill:var(--warn)}.tank[data-tone=alarm] .tank-liq rect{fill:var(--alarm)}
.tank-ticks line{stroke:var(--equip-line);stroke-width:1px;vector-effect:non-scaling-stroke}
.tank-num{font-size:3.2px;font-weight:600;fill:var(--fg);text-anchor:middle;font-variant-numeric:tabular-nums}
.sym{--state:var(--equip);--body:var(--surface);--body2:var(--equip);--line:var(--equip-line);transition:filter .3s}
.sym.on{--state:var(--equip-on);--line:var(--equip-line-on)}.sym.nostat{--state:var(--surface);--line:var(--equip-line)}
.sym .spin{transform-box:fill-box;transform-origin:center}.sym.on .spin{animation:spin 1.2s linear infinite}
.clickable:hover .sym{filter:drop-shadow(0 0 1.5px var(--accent))}
.ln{position:absolute;inset:0}.ln-svg{position:absolute;left:0;top:0;overflow:visible}
.ln-path{fill:none;stroke:var(--pipe);stroke-width:calc(3px*var(--k))}.ln-arrow{fill:var(--pipe)}
.stn{position:absolute;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:calc(1px*var(--k));padding:calc(8px*var(--k)) calc(6px*var(--k)) calc(7px*var(--k));background:var(--surface2);border:1px solid var(--line);border-top:calc(3px*var(--k)) solid var(--ctl);border-radius:calc(3px*var(--k));text-align:center;overflow:hidden}
.stn-pic{--state:var(--surface);--line:var(--equip-line);--body:var(--surface)}.stn-pic.vlv{--state:var(--equip-line)}.stn.on .stn-pic.vlv{--state:var(--surface)}
.stn-wn.on .stn{border-top-color:var(--warn)}.stn-al.fault .stn{border-top-color:var(--alarm)}
.stn.link{cursor:pointer}.stn.link:hover{border-color:var(--accent)}
.stn-name{display:flex;align-items:center;justify-content:center;gap:calc(4px*var(--k));max-width:100%;font-size:var(--f-small);font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--fg)}.stn-nt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.stn-name .rs{flex:none;width:calc(10px*var(--k));height:calc(10px*var(--k))}.md-h{display:none;flex:none;color:var(--accent)}.md-h.on{display:inline-flex}
.stn-tag{font-size:var(--f-tiny);color:var(--muted);line-height:1}
.stn>*{flex-shrink:0}.stn-pic{flex:0 1 auto;min-height:0;width:100%;height:calc(38px*var(--k));margin:calc(4px*var(--k)) 0 calc(2px*var(--k));overflow:visible}.stn-pic *{stroke-width:2px;vector-effect:non-scaling-stroke}
.stn-v{display:flex;align-items:baseline;min-height:calc(24px*var(--k));gap:calc(3px*var(--k));font-variant-numeric:tabular-nums}.stn-v b{font-size:calc(18px*var(--k));font-weight:400}.stn-u{font-size:var(--f-tiny);color:var(--muted)}
.stn-cb{position:absolute;right:calc(5px*var(--k));top:calc(6px*var(--k));line-height:0}.stn-cb svg{display:none;width:calc(18px*var(--k));height:calc(18px*var(--k))}.stn-wn.on .cbw{display:block}.stn-al.fault .cbw{display:none}.stn-al.fault .cba{display:block}.cba circle{fill:var(--alarm)}.cba path{stroke:var(--on-alarm);stroke-width:2.4px;stroke-linecap:round}.cbw .cb-wt{stroke-width:1.6px}.cbw .cb-wx{stroke-width:2.2px}
.stn.small{padding-top:calc(5px*var(--k));padding-bottom:calc(5px*var(--k))}.stn.small .stn-pic{height:calc(24px*var(--k));margin:calc(2px*var(--k)) 0}
.valve-body{fill:var(--equip-line);stroke:var(--equip-line);stroke-width:2px;vector-effect:non-scaling-stroke;stroke-linejoin:round;transition:fill .3s}
.valve.on .valve-body{fill:var(--surface)}
.p-val{font-size:1.8px;font-weight:600;fill:var(--fg);font-variant-numeric:tabular-nums}
.sen-box{fill:var(--surface);stroke:var(--line);stroke-width:1px;vector-effect:non-scaling-stroke}
.sen-num{font-size:1.8px;font-weight:700;fill:var(--fg);text-anchor:middle;font-variant-numeric:tabular-nums}.sen-tag{font-size:1.5px;fill:var(--muted);text-anchor:middle;font-weight:600;letter-spacing:.06em}
.plamp .pl-dot{fill:var(--track);transition:all .3s}.plamp .pl-halo{fill:none}.plamp.on .pl-dot{fill:var(--c)}.plamp.on .pl-halo{fill:color-mix(in srgb,var(--c) 30%,transparent)}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes flow{to{stroke-dashoffset:-16}}@keyframes blink{50%{opacity:.35}}
@keyframes wave{from{transform:translateX(-6%)}to{transform:translateX(0)}}
@media (prefers-reduced-motion:reduce){.hmi *{animation:none!important;transition:none!important}}
`;
