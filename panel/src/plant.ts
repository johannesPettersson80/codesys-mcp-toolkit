/** P&ID drawn from plant.toml: a tank for tank models, valves and pumps from [[feedback]]. */
import type { PanelSignal, PanelState } from "../../src/sim/panel-types.js";
import { esc, fmt, short, show, truthy } from "./util.js";

const ranges = new Map<string, number>();

const sig = (s: PanelState, name?: string): PanelSignal | undefined => (name ? s.signals.find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined);

function deviceState(s: PanelState, fb: { signal: string; follows: string; invert: boolean }) {
  const on = truthy(sig(s, fb.signal));
  const cmd = truthy(sig(s, fb.follows)) !== fb.invert;
  const forced = !!sig(s, fb.signal)?.forced || !!sig(s, fb.follows)?.forced;
  const color = s.status !== "running" && s.status !== "paused" ? "var(--fg2)" : on ? "var(--ok)" : cmd ? "var(--warn)" : "var(--fg2)";
  return { on, cmd, forced, color, label: on ? (cmd ? "on" : "stopping") : cmd ? "starting" : "off" };
}

export function renderPid(el: HTMLElement, s: PanelState): void {
  if (!s.plants.length && !s.feedback.length) {
    el.innerHTML = `<div class="empty">No plant. Describe one in plant.toml (see sync_mirror).</div>`;
    return;
  }
  const W = 360;
  const H = 190;
  const parts: string[] = [];
  const tank = s.plants.find((p) => /tank/i.test(p.model)) ?? s.plants[0];
  const valve = s.feedback.find((f) => /xv|valve|vlv/i.test(f.signal + f.follows));
  const pump = s.feedback.find((f) => f !== valve && /p\d{2,}|pump|pmp/i.test(short(f.signal) + short(f.follows)));
  const others = s.feedback.filter((f) => f !== valve && f !== pump);
  if (tank) {
    const lv = sig(s, tank.outputs[0]);
    const inflow = sig(s, tank.inputs[0]);
    if (typeof lv?.num === "number") ranges.set(tank.id, Math.max(ranges.get(tank.id) ?? 0, lv.num));
    const max = tank.display?.max ?? Math.max(1, Math.ceil((ranges.get(tank.id) ?? 0) * 1.25 * 2) / 2);
    const min = tank.display?.min ?? 0;
    const unit = tank.display?.unit ?? (/tank/i.test(tank.model) ? "m" : "");
    const level = typeof lv?.num === "number" ? lv.num : null;
    const frac = level === null ? 0 : Math.max(0, Math.min(1, (level - min) / (max - min)));
    const tx = 150, ty = 28, tw = 90, th = 125;
    parts.push(`<line x1="20" y1="${ty + 12}" x2="${tx}" y2="${ty + 12}" stroke="var(--fg2)" stroke-width="4"/>`);
    if (inflow) parts.push(`<text x="22" y="${ty + 2}" class="small">${esc(short(inflow.name))} ${esc(show(inflow))}${inflow.forced ? " F" : ""}</text>`);
    if (valve) {
      const d = deviceState(s, valve);
      const vx = 90, vy = ty + 12;
      parts.push(`<polygon points="${vx - 12},${vy - 9} ${vx - 12},${vy + 9} ${vx + 12},${vy - 9} ${vx + 12},${vy + 9}" fill="${d.on ? d.color : "var(--bg)"}" stroke="${d.color}" stroke-width="2"/>`);
      parts.push(`<text x="${vx}" y="${vy + 24}" text-anchor="middle" class="small">${esc(short(valve.signal).replace(/_?(Opened|Open|FB)$/i, ""))} ${d.label}${d.forced ? " F" : ""}</text>`);
    }
    const ly = ty + 2 + (th - 4) * (1 - frac);
    parts.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="6" fill="var(--bg)" stroke="var(--fg2)" stroke-width="2"/>`);
    parts.push(`<rect x="${tx + 2}" y="${ly}" width="${tw - 4}" height="${(th - 4) * frac}" rx="4" fill="var(--water-bg)"/>`);
    parts.push(`<line x1="${tx + 2}" x2="${tx + tw - 2}" y1="${ly}" y2="${ly}" stroke="var(--water)" stroke-width="2"/>`);
    parts.push(`<text x="${tx + tw / 2}" y="${ty - 8}" text-anchor="middle">${esc(tank.display?.label ?? tank.id)}</text>`);
    parts.push(`<text x="${tx + tw / 2}" y="${ty + th / 2 + 4}" text-anchor="middle" style="font-weight:600">${level === null ? "–" : `${fmt(level)} ${unit}`}${lv?.forced ? " F" : ""}</text>`);
    parts.push(`<text x="${tx + tw + 4}" y="${ty + 8}" class="small">${fmt(max)}</text><text x="${tx + tw + 4}" y="${ty + th}" class="small">${fmt(min)}</text>`);
    if (lv) parts.push(`<text x="${tx + tw / 2}" y="${ty + th + 14}" text-anchor="middle" class="small">${esc(short(lv.name))}</text>`);
    const oy = ty + th - 14;
    parts.push(`<line x1="${tx + tw}" y1="${oy}" x2="${W - 10}" y2="${oy}" stroke="var(--fg2)" stroke-width="4"/>`);
    if (pump) {
      const d = deviceState(s, pump);
      const px = tx + tw + 50;
      parts.push(`<circle cx="${px}" cy="${oy}" r="13" fill="${d.on ? d.color : "var(--bg)"}" stroke="${d.color}" stroke-width="2"/>`);
      parts.push(`<polygon points="${px - 5},${oy - 7} ${px - 5},${oy + 7} ${px + 8},${oy}" fill="${d.on ? "var(--bg)" : d.color}"/>`);
      parts.push(`<text x="${px}" y="${oy + 28}" text-anchor="middle" class="small">${esc(short(pump.signal).replace(/_?(Running|Run|FB)$/i, ""))} ${d.label}${d.forced ? " F" : ""}</text>`);
    }
  }
  others.slice(0, 4).forEach((f, i) => {
    const d = deviceState(s, f);
    const x = 14 + i * 80;
    parts.push(`<rect x="${x}" y="${H - 18}" width="12" height="12" rx="3" fill="${d.on ? d.color : "var(--bg)"}" stroke="${d.color}" stroke-width="2"/>`);
    parts.push(`<text x="${x + 16}" y="${H - 8}" class="small">${esc(short(f.signal))}</text>`);
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Plant">${parts.join("")}</svg>`;
}
