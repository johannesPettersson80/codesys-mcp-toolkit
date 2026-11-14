/**
 * Renders an HMI screen to HTML + SVG on a fixed 1280x720 canvas (scaled to the
 * window by the page). Pure: no DOM, so the server can build screenshot pages
 * and the browser can mount live ones. Values are not rendered here: elements
 * carry `data-b` (an index into `bindings`), and the live client (live.ts)
 * applies values through CSS variables and classes, so animations keep running.
 */
import { routed } from "./route.js";
import type { ProcessItem, Screen, Tone, Widget } from "./spec.js";

export const CANVAS = { w: 1280, h: 720, header: 76, pad: 20, gap: 14 } as const;

export type Binding =
  | { kind: "text"; v: string; decimals?: number; unit?: string; bands?: { from: number; tone: Tone }[] }
  | { kind: "on"; v: string; invert?: boolean }
  | { kind: "fault"; v: string }
  | { kind: "level"; v: string; min: number; max: number; decimals?: number; unit?: string; bands?: { from: number; tone: Tone }[] }
  | { kind: "trend"; series: string[]; min?: number; max?: number; seconds: number }
  | { kind: "spark"; v: string }
  | { kind: "setpoint"; v: string; decimals: number }
  | { kind: "alarm"; v: string };

export interface Rendered {
  html: string;
  bindings: Binding[];
  css: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const r1 = (n: number) => Math.round(n * 10) / 10;

export const SERIES_COLORS = ["#38bdf8", "#a78bfa", "#fbbf24", "#34d399", "#f472b6", "#60a5fa"];

/** The pixel box of a tile on the canvas. */
export function tileBox(screen: Screen, at: [number, number, number, number]) {
  const [cols, rows] = screen.grid;
  const { w, h, header, pad, gap } = CANVAS;
  const cw = (w - 2 * pad - (cols - 1) * gap) / cols;
  const ch = (h - header - pad - (rows - 1) * gap) / rows;
  const [c, r, wd, ht] = at;
  return { x: pad + (c - 1) * (cw + gap), y: header + (r - 1) * (ch + gap), w: wd * cw + (wd - 1) * gap, h: ht * ch + (ht - 1) * gap };
}

export function renderScreen(screen: Screen): Rendered {
  const bindings: Binding[] = [];
  const bind = (b: Binding) => `data-b="${bindings.push(b) - 1}"`;
  let uid = 0;
  const id = (p: string) => `${p}${++uid}`;

  const tiles = screen.widgets.map((wg) => {
    const box = tileBox(screen, wg.at);
    const inner = widget(wg, box, bind, id);
    const title = wg.title ? `<div class="t-title">${esc(wg.title)}</div>` : "";
    return `<section class="tile t-${wg.type}${wg.title ? "" : " untitled"}${box.h < 110 ? " compact" : ""}" style="left:${r1(box.x)}px;top:${r1(box.y)}px;width:${r1(box.w)}px;height:${r1(box.h)}px">${title}<div class="t-body">${inner}</div></section>`;
  });

  const html = `<div class="hmi theme-${screen.theme}" style="width:${CANVAS.w}px;height:${CANVAS.h}px">
<div class="glow"></div>
<svg width="0" height="0" style="position:absolute" aria-hidden="true">${DEFS}</svg>
<header class="h-bar"><div class="h-titles"><div class="h-title">${esc(screen.title)}</div>${screen.subtitle ? `<div class="h-sub">${esc(screen.subtitle)}</div>` : ""}</div>
<div class="h-right"><div class="h-sim" data-sim><span class="dot"></span><span class="lbl">Offline</span></div><div class="h-clock" data-clock>--:--:--</div></div></header>
${tiles.join("\n")}
</div>`;
  return { html, bindings, css: HMI_CSS };
}

type Bind = (b: Binding) => string;

function toneOf(t: Tone | undefined): string {
  return t ?? "accent";
}

function widget(w: Widget, box: { w: number; h: number }, bind: Bind, id: (p: string) => string): string {
  const bodyH = box.h - (w.title ? 44 : 20);
  switch (w.type) {
    case "value": {
      const size = Math.max(22, Math.min(64, bodyH * (w.trend ? 0.36 : 0.55), box.w / 6));
      const spark = w.trend ? `<svg class="spark" viewBox="0 0 200 40" preserveAspectRatio="none" ${bind({ kind: "spark", v: w.value })}><path class="spark-fill"/><path class="spark-line"/></svg>` : "";
      return `<div class="v-wrap"><div class="v-num" style="font-size:${r1(size)}px" ${bind({ kind: "text", v: w.value, decimals: w.decimals, bands: w.bands })}>–</div>${w.unit ? `<div class="v-unit">${esc(w.unit)}</div>` : ""}</div>${spark}`;
    }
    case "gauge": {
      const s = Math.min(box.w - 24, bodyH * 1.25);
      const R = 80;
      const arc = describeArc(100, 100, R, -120, 120);
      const len = r1((240 / 360) * 2 * Math.PI * R);
      const ticks = Array.from({ length: 11 }, (_, i) => {
        const a = ((-120 + i * 24) * Math.PI) / 180;
        const r0 = i % 5 === 0 ? 62 : 66;
        return `<line x1="${r1(100 + r0 * Math.sin(a))}" y1="${r1(100 - r0 * Math.cos(a))}" x2="${r1(100 + 70 * Math.sin(a))}" y2="${r1(100 - 70 * Math.cos(a))}"/>`;
      }).join("");
      return `<svg class="gauge" style="width:${r1(s)}px;height:${r1(s * 0.86)}px;--len:${len}" viewBox="0 0 200 172" ${bind({ kind: "level", v: w.value, min: w.min, max: w.max, bands: w.bands })}>
<path class="g-track" d="${arc}"/><path class="g-val" d="${arc}" style="stroke-dasharray:${len};"/><g class="g-ticks">${ticks}</g>
<text x="100" y="104" class="g-num" ${bind({ kind: "text", v: w.value, decimals: w.decimals, bands: w.bands })}>–</text>
<text x="100" y="128" class="g-unit">${esc(w.unit ?? "")}</text>
<text x="${r1(100 - R * Math.sin((120 * Math.PI) / 180))}" y="166" class="g-lim">${w.min}</text><text x="${r1(100 + R * Math.sin((120 * Math.PI) / 180))}" y="166" class="g-lim">${w.max}</text></svg>`;
    }
    case "bar": {
      const lvl = bind({ kind: "level", v: w.value, min: w.min, max: w.max, bands: w.bands });
      return `<div class="bar-wrap${w.vertical ? " vert" : ""}"><div class="bar" ${lvl}><div class="bar-fill"></div></div><div class="bar-read"><span class="bar-num" ${bind({ kind: "text", v: w.value, decimals: 1, bands: w.bands })}>–</span> <span class="bar-unit">${esc(w.unit ?? "")}</span><span class="bar-lim">${w.min} – ${w.max}</span></div></div>`;
    }
    case "status":
      return `<ul class="status">${w.items.map((i) => `<li class="led tone-${toneOf(i.tone ?? "ok")}" ${bind({ kind: "on", v: i.on, invert: i.invert })}><span class="led-dot"></span><span>${esc(i.label)}</span></li>`).join("")}</ul>`;
    case "buttons":
      return `<div class="btns${w.items.length > 2 && box.w < 360 ? " col" : ""}">${w.items
        .map((i) => `<button class="btn tone-${toneOf(i.tone ?? (/stop|reset|off/i.test(i.label) ? "alarm" : "accent"))}" data-act="${i.action}" data-var="${esc(i.variable)}" ${bind({ kind: "on", v: i.variable })}>${esc(i.label)}</button>`)
        .join("")}</div>`;
    case "switch":
      return `<label class="sw" data-act="toggle" data-var="${esc(w.variable)}" ${bind({ kind: "on", v: w.variable })}><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-lbl">${esc(w.label ?? "")}</span><span class="sw-state"><span class="s-on">ON</span><span class="s-off">OFF</span></span></label>`;
    case "setpoint": {
      const dec = w.step !== undefined && !Number.isInteger(w.step) ? String(w.step).split(".")[1]!.length : 0;
      return `<div class="sp" data-var="${esc(w.variable)}" data-min="${w.min}" data-max="${w.max}" data-step="${w.step ?? 1}" ${bind({ kind: "setpoint", v: w.variable, decimals: dec })}>
<div class="sp-row"><button class="sp-btn" data-step="-1">−</button><div class="sp-val"><span class="sp-num" ${bind({ kind: "text", v: w.variable, decimals: dec })}>–</span><span class="sp-unit">${esc(w.unit ?? "")}</span></div><button class="sp-btn" data-step="1">+</button></div>
<input class="sp-range" type="range" min="${w.min}" max="${w.max}" step="${w.step ?? 1}"><div class="sp-lim"><span>${w.min}</span><span>${w.max}</span></div></div>`;
    }
    case "trend": {
      const lines = w.series.map((s, i) => `<path class="tr-line" style="stroke:${SERIES_COLORS[i % SERIES_COLORS.length]}"/>`).join("");
      const legend = w.series.map((s, i) => `<span><i style="background:${SERIES_COLORS[i % SERIES_COLORS.length]}"></i>${esc(s.label ?? s.value.split(".").pop()!)}</span>`).join("");
      const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="600" y1="${200 * f}" y2="${200 * f}"/>`).join("");
      return `<div class="tr-legend">${legend}</div><svg class="trend" viewBox="0 0 600 200" preserveAspectRatio="none" ${bind({ kind: "trend", series: w.series.map((s) => s.value), min: w.min, max: w.max, seconds: w.seconds })}><g class="tr-grid">${grid}</g>${lines}</svg><div class="tr-axis"><span>−${w.seconds} s</span><span class="tr-range"><span class="tr-min"></span> – <span class="tr-max"></span></span><span>now</span></div>`;
    }
    case "alarms":
      return `<ul class="alarms">${w.items.map((i) => `<li class="al sev-${i.severity}" ${bind({ kind: "alarm", v: i.active })}><span class="al-badge">${i.severity === "info" ? "INFO" : i.severity === "warning" ? "WARN" : "ALARM"}</span><span class="al-text">${esc(i.text)}</span></li>`).join("")}<li class="al-none">No active alarms</li></ul>`;
    case "text":
      return `<div class="txt">${esc(w.text).replace(/\n/g, "<br>")}</div>`;
    case "process": {
      const vw = 100;
      const vh = r1((100 * Math.max(60, bodyH)) / Math.max(60, box.w - 24));
      const sy = vh / 100;
      const items = routed(w.items, sy).sort((a, b) => (a.type === "pipe" ? -1 : 0) - (b.type === "pipe" ? -1 : 0));
      return `<svg class="proc" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${items.map((p) => processSvg(p, sy, bind, id)).join("")}</svg>`;
    }
  }
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

function processSvg(p: ProcessItem, sy: number, bind: Bind, id: (p: string) => string): string {
  const Y = (y: number) => r1(y * sy);
  const label = (x: number, y: number, t?: string) => (t ? `<text class="p-label" x="${r1(x)}" y="${Y(y)}">${esc(t)}</text>` : "");
  switch (p.type) {
    case "pipe": {
      const d = (p.points ?? []).map(([x, y], i) => `${i ? "L" : "M"}${r1(x)} ${Y(y)}`).join(" ");
      return `<g class="pipe" ${p.flow ? bind({ kind: "on", v: p.flow }) : ""}><path class="pipe-outer" d="${d}"/><path class="pipe-inner" d="${d}"/><path class="pipe-flow" d="${d}"/></g>`;
    }
    case "tank": {
      const x = r1(p.x), y = Y(p.y), w = r1(p.w), h = Y(p.h);
      const clip = id("tk");
      const ticks = [0.25, 0.5, 0.75].map((f) => `<line x1="${r1(x + w - 2.2)}" x2="${r1(x + w - 0.8)}" y1="${r1(y + h * (1 - f))}" y2="${r1(y + h * (1 - f))}"/>`).join("");
      return `<g class="tank" ${bind({ kind: "level", v: p.level, min: 0, max: p.max, bands: p.bands })}>
<clipPath id="${clip}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r1(Math.min(w, h) * 0.12)}"/></clipPath>
<rect class="tank-shell" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r1(Math.min(w, h) * 0.12)}"/>
<g clip-path="url(#${clip})"><g class="tank-liq" style="transform-origin:${x}px ${r1(y + h)}px"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#gLiquid)"/><path class="tank-wave" d="M${x} ${r1(y + 1)} q ${r1(w / 8)} -1.2 ${r1(w / 4)} 0 t ${r1(w / 4)} 0 t ${r1(w / 4)} 0 t ${r1(w / 4)} 0 t ${r1(w / 4)} 0 V ${r1(y + 3)} H ${x} Z"/></g></g>
<rect class="tank-gloss" x="${r1(x + w * 0.1)}" y="${r1(y + h * 0.05)}" width="${r1(w * 0.12)}" height="${r1(h * 0.9)}" rx="${r1(w * 0.06)}"/>
<g class="tank-ticks">${ticks}</g>
<text class="tank-num" x="${r1(x + w / 2)}" y="${r1(y + h / 2 + 1.5)}" ${bind({ kind: "text", v: p.level, decimals: 0, unit: p.unit })}>–</text>
${label(x + w / 2, p.y + p.h + 2.8 / sy, p.label)}</g>`;
    }
    case "pump": {
      const s = p.size, cx = r1(p.x), cy = Y(p.y), r = r1(s / 2);
      const blades = [0, 60, 120, 180, 240, 300].map((a) => `<path d="M0 0 Q ${r1(r * 0.3)} ${r1(-r * 0.25)} ${r1(r * 0.12)} ${r1(-r * 0.62)}" transform="rotate(${a})"/>`).join("");
      return `<g ${p.fault ? bind({ kind: "fault", v: p.fault }) : ""}><g class="pump" ${bind({ kind: "on", v: p.running })}>
<circle class="pump-ring" cx="${cx}" cy="${cy}" r="${r}"/><circle class="pump-body" cx="${cx}" cy="${cy}" r="${r1(r * 0.86)}" fill="url(#gHub)"/>
<g transform="translate(${cx} ${cy})"><g class="pump-imp">${blades}<circle r="${r1(r * 0.14)}" class="pump-hub"/></g></g>
${label(p.x, p.y + (s / 2 + 2.6) / sy, p.label)}</g></g>`;
    }
    case "fan": {
      const s = p.size, cx = r1(p.x), cy = Y(p.y), r = r1(s / 2);
      const blades = [0, 120, 240].map((a) => `<path d="M0 0 C ${r1(r * 0.5)} ${r1(-r * 0.2)} ${r1(r * 0.55)} ${r1(-r * 0.8)} 0 ${r1(-r * 0.86)} C ${r1(-r * 0.2)} ${r1(-r * 0.6)} ${r1(-r * 0.1)} ${r1(-r * 0.2)} 0 0Z" transform="rotate(${a})"/>`).join("");
      return `<g class="pump fan" ${bind({ kind: "on", v: p.running })}><circle class="pump-ring" cx="${cx}" cy="${cy}" r="${r}"/><circle class="pump-body" cx="${cx}" cy="${cy}" r="${r1(r * 0.9)}" fill="url(#gHub)"/><g transform="translate(${cx} ${cy})"><g class="pump-imp">${blades}<circle r="${r1(r * 0.12)}" class="pump-hub"/></g></g>${label(p.x, p.y + (s / 2 + 2.6) / sy, p.label)}</g>`;
    }
    case "valve": {
      const s = p.size, cx = r1(p.x), cy = Y(p.y), h = r1(s / 2);
      const body = `<path class="valve-body" d="M${r1(-h)} ${r1(-h * 0.7)} L${h} ${r1(h * 0.7)} L${h} ${r1(-h * 0.7)} L${r1(-h)} ${r1(h * 0.7)} Z"/><line class="valve-stem" x1="0" y1="0" x2="0" y2="${r1(-h * 1.1)}"/><rect class="valve-act" x="${r1(-h * 0.5)}" y="${r1(-h * 1.5)}" width="${h}" height="${r1(h * 0.45)}" rx="${r1(h * 0.1)}"/>`;
      return `<g class="valve" ${bind({ kind: "on", v: p.open })}><g transform="translate(${cx} ${cy})${p.vertical ? " rotate(90)" : ""}">${body}</g>${p.label ? (p.vertical ? `<text class="p-label left" x="${r1(p.x + s * 0.75)}" y="${r1(cy + 0.6)}">${esc(p.label)}</text>` : label(p.x, p.y + (s / 2 + 2.6) / sy, p.label)) : ""}</g>`;
    }
    case "sensor": {
      const cx = r1(p.x), cy = Y(p.y);
      return `<g class="sensor"><rect class="sen-box" x="${r1(cx - 6.5)}" y="${r1(cy - 2.1)}" width="13" height="4.2" rx="2.1"/><text class="sen-num" x="${cx}" y="${r1(cy + 0.75)}" ${bind({ kind: "text", v: p.value, decimals: p.decimals ?? 1, unit: p.unit })}>–</text>${p.label ? `<text class="sen-tag" x="${cx}" y="${r1(cy - 3)}">${esc(p.label)}</text>` : ""}</g>`;
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

export const HMI_CSS = String.raw`
.hmi{position:relative;overflow:hidden;font-family:"Segoe UI Variable Display","Segoe UI",Inter,system-ui,sans-serif;color:var(--fg);background:var(--bg);border-radius:18px;box-sizing:border-box;-webkit-font-smoothing:antialiased}
.hmi *{box-sizing:border-box}
.theme-dark{--bg:radial-gradient(1200px 600px at 15% -10%,#13284a 0%,transparent 60%),radial-gradient(900px 500px at 110% 110%,#1c1640 0%,transparent 55%),#070d1a;--fg:#e6edf7;--muted:#8193ad;--tile:linear-gradient(160deg,rgba(30,41,64,.72),rgba(14,21,37,.78));--tile-bd:rgba(148,163,184,.13);--tile-sh:0 10px 30px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.05);--track:rgba(148,163,184,.16);--accent:#38bdf8;--ok:#22c55e;--warn:#f59e0b;--alarm:#ef4444;--neutral:#64748b;--shell-a:#1e293b;--shell-b:#334155;--liq-a:#38bdf8;--liq-b:#0369a1;--hub-a:#475569;--hub-b:#0f172a;--pipe:#334155;--pipe-in:#1e293b;--btn:rgba(148,163,184,.1)}
.theme-light{--bg:radial-gradient(1000px 500px at 10% -10%,#dbeafe 0%,transparent 60%),#eef2f7;--fg:#0f172a;--muted:#64748b;--tile:linear-gradient(160deg,#ffffff,#f8fafc);--tile-bd:#e2e8f0;--tile-sh:0 6px 20px rgba(15,23,42,.06);--track:#e2e8f0;--accent:#0284c7;--ok:#16a34a;--warn:#d97706;--alarm:#dc2626;--neutral:#94a3b8;--shell-a:#cbd5e1;--shell-b:#f1f5f9;--liq-a:#38bdf8;--liq-b:#0284c7;--hub-a:#e2e8f0;--hub-b:#94a3b8;--pipe:#94a3b8;--pipe-in:#cbd5e1;--btn:#f1f5f9}
.glow{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(56,189,248,.06),transparent 30%)}
.h-bar{position:absolute;left:20px;right:20px;top:0;height:76px;display:flex;align-items:center;justify-content:space-between}
.h-title{font-size:24px;font-weight:650;letter-spacing:-.01em}
.h-sub{font-size:13px;color:var(--muted);margin-top:2px}
.h-right{display:flex;gap:12px;align-items:center}
.h-sim{display:flex;align-items:center;gap:8px;padding:7px 13px;border-radius:999px;border:1px solid var(--tile-bd);background:var(--tile);font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.h-sim .dot{width:8px;height:8px;border-radius:50%;background:var(--neutral)}
.h-sim.run{color:var(--ok)}.h-sim.run .dot{background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 25%,transparent);animation:pulse 1.6s infinite}
.h-sim.stop{color:var(--warn)}.h-sim.stop .dot{background:var(--warn)}
.h-clock{font-variant-numeric:tabular-nums;font-size:15px;color:var(--muted);min-width:76px;text-align:right}
.tile{position:absolute;border-radius:16px;background:var(--tile);border:1px solid var(--tile-bd);box-shadow:var(--tile-sh);backdrop-filter:blur(8px);display:flex;flex-direction:column;padding:14px 16px 12px}
.tile.compact{padding:8px 16px}.tile.compact .t-title{height:15px;font-size:10.5px}
.t-title{font-size:11.5px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);height:20px;flex:none}
.t-body{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;position:relative}
.tone-accent{--c:var(--accent)}.tone-ok{--c:var(--ok)}.tone-warn{--c:var(--warn)}.tone-alarm{--c:var(--alarm)}.tone-neutral{--c:var(--neutral)}
[data-tone=accent]{--c:var(--accent)}[data-tone=ok]{--c:var(--ok)}[data-tone=warn]{--c:var(--warn)}[data-tone=alarm]{--c:var(--alarm)}[data-tone=neutral]{--c:var(--neutral)}
.v-wrap{display:flex;align-items:baseline;gap:8px}
.v-num{font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1;color:var(--c,var(--fg));transition:color .3s}
.v-unit{font-size:15px;color:var(--muted);font-weight:500}
.spark{width:100%;height:34%;margin-top:8px}.spark-line{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}.spark-fill{fill:color-mix(in srgb,var(--accent) 16%,transparent)}
.gauge{display:block;margin:0 auto;--p:0}.g-track,.g-val{fill:none;stroke-width:14;stroke-linecap:round}.g-track{stroke:var(--track)}
.g-val{stroke:var(--c,var(--accent));stroke-dashoffset:calc(var(--len) * (1 - var(--p)));transition:stroke-dashoffset .5s cubic-bezier(.2,.8,.2,1),stroke .3s;filter:drop-shadow(0 0 6px color-mix(in srgb,var(--c,var(--accent)) 55%,transparent))}
.g-ticks line{stroke:var(--muted);stroke-width:1.5;opacity:.5}
.g-num{font-size:34px;font-weight:650;text-anchor:middle;fill:var(--fg);font-variant-numeric:tabular-nums}.g-unit{font-size:13px;text-anchor:middle;fill:var(--muted)}.g-lim{font-size:11px;fill:var(--muted);text-anchor:middle}
.bar-wrap{display:flex;flex-direction:column;gap:10px;--p:0}.bar{height:16px;border-radius:999px;background:var(--track);overflow:hidden;--p:0}
.bar-fill{height:100%;width:calc(var(--p) * 100%);border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--c,var(--accent)) 70%,transparent),var(--c,var(--accent)));box-shadow:0 0 14px color-mix(in srgb,var(--c,var(--accent)) 45%,transparent);transition:width .5s cubic-bezier(.2,.8,.2,1)}
.bar-wrap.vert{flex-direction:row;height:100%;align-items:stretch}.bar-wrap.vert .bar{width:22px;height:auto;display:flex;align-items:flex-end}.bar-wrap.vert .bar-fill{width:100%;height:calc(var(--p) * 100%);transition:height .5s}
.bar-read{display:flex;align-items:baseline;gap:4px}.bar-num{font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--c,var(--fg))}.bar-unit{color:var(--muted);font-size:13px}.bar-lim{margin-left:auto;color:var(--muted);font-size:11px}
.status{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.led{display:flex;align-items:center;gap:11px;font-size:14px;color:var(--muted);transition:color .3s}
.led-dot{width:12px;height:12px;border-radius:50%;background:var(--track);box-shadow:inset 0 1px 2px rgba(0,0,0,.4);transition:all .3s;flex:none}
.led.on{color:var(--fg)}.led.on .led-dot{background:radial-gradient(circle at 35% 35%,#fff 0,var(--c) 45%);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 22%,transparent),0 0 14px var(--c)}
.btns{display:flex;gap:10px;height:100%;align-items:center}.btns.col{flex-direction:column;align-items:stretch}
.btn{flex:1;min-height:52px;border-radius:12px;border:1px solid color-mix(in srgb,var(--c) 40%,var(--tile-bd));background:linear-gradient(180deg,color-mix(in srgb,var(--c) 22%,var(--btn)),color-mix(in srgb,var(--c) 10%,var(--btn)));color:var(--fg);font:650 16px/1 inherit;letter-spacing:.03em;cursor:pointer;transition:all .15s;box-shadow:0 4px 14px color-mix(in srgb,var(--c) 18%,transparent),inset 0 1px 0 rgba(255,255,255,.08)}
.btn:hover{filter:brightness(1.15)}.btn:active,.btn.on{transform:translateY(1px);background:color-mix(in srgb,var(--c) 45%,var(--btn));box-shadow:0 0 18px color-mix(in srgb,var(--c) 45%,transparent)}
.sw{display:flex;align-items:center;gap:14px;cursor:pointer;user-select:none}
.sw-track{width:58px;height:32px;border-radius:999px;background:var(--track);position:relative;transition:background .25s;flex:none}
.sw-knob{position:absolute;top:3px;left:3px;width:26px;height:26px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.35);transition:transform .25s cubic-bezier(.2,.8,.2,1)}
.sw.on .sw-track{background:var(--ok);box-shadow:0 0 16px color-mix(in srgb,var(--ok) 45%,transparent)}.sw.on .sw-knob{transform:translateX(26px)}
.sw-lbl{font-size:15px;flex:1}.sw-state{font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--muted)}.sw .s-on{display:none}.sw.on .s-on{display:inline;color:var(--ok)}.sw.on .s-off{display:none}
.sp{display:flex;flex-direction:column;gap:10px}.sp-row{display:flex;align-items:center;gap:10px}
.sp-btn{width:40px;height:40px;border-radius:12px;border:1px solid var(--tile-bd);background:var(--btn);color:var(--fg);font-size:22px;cursor:pointer}.sp-btn:hover{border-color:var(--accent)}
.sp-val{flex:1;text-align:center}.sp-num{font-size:30px;font-weight:650;font-variant-numeric:tabular-nums}.sp-unit{margin-left:6px;color:var(--muted);font-size:13px}
.sp-range{width:100%;accent-color:var(--accent)}.sp-lim{display:flex;justify-content:space-between;color:var(--muted);font-size:11px}
.tr-legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-bottom:6px;flex-wrap:wrap}.tr-legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.trend{flex:1;width:100%;min-height:0}.tr-grid line{stroke:var(--track);stroke-width:1;vector-effect:non-scaling-stroke}
.tr-line{fill:none;stroke-width:2.2;vector-effect:non-scaling-stroke;stroke-linejoin:round;filter:drop-shadow(0 0 4px rgba(56,189,248,.35))}
.tr-axis{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);margin-top:4px}
.alarms{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;overflow:hidden}
.al{display:none;align-items:center;gap:9px;padding:8px 10px;border-radius:10px;font-size:12.5px;line-height:1.25;background:color-mix(in srgb,var(--c) 12%,transparent);border:1px solid color-mix(in srgb,var(--c) 35%,transparent)}
.al.active{display:flex}.sev-alarm{--c:var(--alarm)}.sev-warning{--c:var(--warn)}.sev-info{--c:var(--accent)}
.sev-alarm.active{animation:blink 1.2s infinite}
.al-badge{font-size:10px;font-weight:800;letter-spacing:.08em;padding:3px 7px;border-radius:6px;background:var(--c);color:#fff}
.al-none{display:flex;align-items:center;gap:9px;color:var(--ok);font-size:14px}.al-none::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok)}
.alarms.has .al-none{display:none}
.txt{font-size:14px;line-height:1.5;color:var(--muted)}
.proc{width:100%;height:100%;overflow:visible}
.p-label{font-size:1.75px;fill:var(--muted);text-anchor:middle;font-weight:600;letter-spacing:.05em}.p-label.left{text-anchor:start}.p-text{font-size:2px;fill:var(--fg);font-weight:600}
.junction{fill:var(--pipe)}
.pipe-outer{fill:none;stroke:var(--pipe);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.pipe-inner{fill:none;stroke:var(--pipe-in);stroke-width:1;stroke-linecap:round;stroke-linejoin:round}
.pipe-flow{fill:none;stroke:var(--accent);stroke-width:.55;stroke-dasharray:1.1 1.9;stroke-linecap:round;opacity:0;transition:opacity .4s}.pipe.on .pipe-flow{opacity:1;animation:flow .8s linear infinite;filter:drop-shadow(0 0 1px var(--accent))}
.tank{--p:0}.tank-shell{fill:url(#gShell);stroke:var(--tile-bd);stroke-width:.4}.tank-liq{transform:scaleY(var(--p));transition:transform .8s cubic-bezier(.2,.8,.2,1)}
.tank-liq rect{fill:url(#gLiquid);opacity:.92}.tank[data-tone=warn] .tank-liq rect{fill:var(--warn)}.tank[data-tone=alarm] .tank-liq rect{fill:var(--alarm)}
.tank-wave{fill:rgba(255,255,255,.22);animation:wave 3s ease-in-out infinite alternate}
.tank-gloss{fill:rgba(255,255,255,.08)}.tank-ticks line{stroke:var(--muted);stroke-width:.3}
.tank-num{font-size:3.4px;font-weight:700;fill:#fff;text-anchor:middle;paint-order:stroke;stroke:rgba(2,6,23,.45);stroke-width:.6px;font-variant-numeric:tabular-nums}
.pump-ring{fill:none;stroke:var(--neutral);stroke-width:.9;transition:all .3s}.pump-body{stroke:var(--tile-bd);stroke-width:.3}.pump-out{fill:var(--shell-b);stroke:var(--tile-bd);stroke-width:.3}
.pump-imp path{fill:none;stroke:var(--muted);stroke-width:.9;stroke-linecap:round}.fan .pump-imp path{fill:var(--muted);stroke:none;opacity:.85}.pump-hub{fill:var(--muted)}
.pump.on .pump-ring{stroke:var(--ok);filter:url(#fGlow)}.pump.on .pump-imp{animation:spin 1s linear infinite}.pump.on .pump-imp path{stroke:var(--ok)}.fan.on .pump-imp path{fill:var(--ok)}.pump.on .pump-hub{fill:var(--ok)}
.fault .pump-ring{stroke:var(--alarm);animation:blink .8s infinite}
.valve-body{fill:var(--neutral);stroke:var(--tile-bd);stroke-width:.3;transition:fill .3s}.valve-stem{stroke:var(--muted);stroke-width:.6}.valve-act{fill:var(--shell-b);stroke:var(--tile-bd);stroke-width:.3}
.valve.on .valve-body{fill:var(--ok);filter:url(#fGlow)}
.sen-box{fill:rgba(2,6,23,.6);stroke:color-mix(in srgb,var(--accent) 70%,transparent);stroke-width:.22}.theme-light .sen-box{fill:#fff}
.sen-num{font-size:2px;font-weight:700;fill:var(--fg);text-anchor:middle;font-variant-numeric:tabular-nums}.sen-tag{font-size:1.5px;fill:var(--muted);text-anchor:middle;font-weight:600;letter-spacing:.06em}
.plamp .pl-dot{fill:var(--track);transition:all .3s}.plamp .pl-halo{fill:none}.plamp.on .pl-dot{fill:var(--c)}.plamp.on .pl-halo{fill:color-mix(in srgb,var(--c) 30%,transparent);filter:url(#fGlow)}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes flow{to{stroke-dashoffset:-3}}@keyframes pulse{50%{opacity:.55}}@keyframes blink{50%{opacity:.45}}
@keyframes wave{from{transform:translateX(-6%)}to{transform:translateX(0)}}
@media (prefers-reduced-motion:reduce){.hmi *{animation:none!important;transition:none!important}}
`;
