/** Trend strips: one lane per signal, shared time axis; booleans as steps. */
import type { PanelState } from "../../src/sim/panel-types.js";
import type { TrendPoint } from "../../src/sim/recorder.js";
import { fmt, short } from "./util.js";

const COLORS = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#db2777", "#65a30d"];

export function drawTrend(canvas: HTMLCanvasElement, s: PanelState, trend: TrendPoint[], o: { compact?: boolean; names?: string[] } = {}): string {
  let names = (o.names ?? s.signals.map((x) => x.name)).filter((n) => trend.some((p) => typeof p.values[n] === "number"));
  if (o.compact) names = names.filter((n) => !/^(TRUE|FALSE)$/.test(s.signals.find((x) => x.name === n)?.value ?? "")).slice(0, 2);
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const lane = o.compact ? 30 : 34;
  const cssH = o.compact ? Math.max(60, names.length * lane + 14) : Math.max(60, names.length * lane + 18);
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;
  }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const css = getComputedStyle(document.documentElement);
  const fg2 = css.getPropertyValue("--fg2").trim() || "#888";
  const line = css.getPropertyValue("--line").trim() || "#ddd";
  g.font = `11px ${css.getPropertyValue("--font") || "sans-serif"}`;
  if (!names.length || trend.length < 2) {
    g.fillStyle = fg2;
    g.fillText(s.status === "running" || s.status === "paused" ? "Run the simulation to record a trend." : "No trend yet.", 10, 20);
    return "";
  }
  const t0 = trend[0]!.t;
  const t1 = Math.max(trend.at(-1)!.t, t0 + 1e-6);
  const left = o.compact ? 110 : 150;
  const right = 8;
  const plotW = cssW - left - right;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * plotW;
  names.forEach((n, i) => {
    const top = 4 + i * lane;
    const h = lane - 8;
    const pts = trend.map((p) => [p.t, p.values[n]] as const).filter((p): p is readonly [number, number] => typeof p[1] === "number");
    const isBool = /^(TRUE|FALSE)$/.test(s.signals.find((v) => v.name === n)?.value ?? "") && pts.every((p) => p[1] === 0 || p[1] === 1);
    let lo = isBool ? 0 : Math.min(...pts.map((p) => p[1]));
    let hi = isBool ? 1 : Math.max(...pts.map((p) => p[1]));
    if (hi - lo < 1e-9) {
      hi += 0.5;
      lo -= 0.5;
    }
    const y = (v: number) => top + h - ((v - lo) / (hi - lo)) * h;
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(left, top + h + 2);
    g.lineTo(cssW - right, top + h + 2);
    g.stroke();
    const color = COLORS[i % COLORS.length]!;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    pts.forEach(([t, v], k) => {
      if (!k) return g.moveTo(x(t), y(v));
      if (isBool) g.lineTo(x(t), y(pts[k - 1]![1]));
      g.lineTo(x(t), y(v));
    });
    g.stroke();
    const last = pts.at(-1)![1];
    g.fillStyle = color;
    g.fillText(short(n), 8, top + 11);
    g.fillStyle = fg2;
    g.fillText(isBool ? (last ? "TRUE" : "FALSE") : o.compact ? fmt(last) : `${fmt(last)}  [${fmt(lo)}…${fmt(hi)}]`, 8, top + 23);
  });
  if (!o.compact) {
    g.fillStyle = fg2;
    g.fillText(`${t0.toFixed(0)} s`, left, cssH - 3);
    const end = `${t1.toFixed(0)} s`;
    g.fillText(end, cssW - right - g.measureText(end).width, cssH - 3);
  }
  return `${t0.toFixed(1)}–${t1.toFixed(1)} s simulated`;
}
