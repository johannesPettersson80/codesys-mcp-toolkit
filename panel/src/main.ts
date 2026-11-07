/**
 * The simulation panel (MCP App view). Read-only: it polls the server's
 * app-only tools and draws the code with the current line, the plant, I/O,
 * trends, experiments and events.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { PanelSignal, PanelState, SourceView } from "../../src/sim/panel-types.js";
import type { TrendPoint } from "../../src/sim/recorder.js";
import type { SimEvent } from "../../src/sim/journal.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (n: number) => {
  const a = Math.abs(n);
  return a >= 1000 ? n.toFixed(0) : a >= 10 ? n.toFixed(1) : a >= 1 ? n.toFixed(2) : n.toFixed(3);
};

/** A signal value for display: numbers shortened, other values as ST. */
const show = (x?: PanelSignal) => {
  if (!x || x.value === undefined) return "–";
  if (typeof x.num === "number" && /^-?\d/.test(x.value) && !/^(TRUE|FALSE)$/.test(x.value)) return fmt(x.num);
  return x.value;
};

const app = new App({ name: "codesys-sim-panel", version: "1.0.0" });

let panelId: string | undefined;
let state: PanelState | undefined;
let stopped = false;
let lastSeq = 0;
let events: SimEvent[] = [];
let source: SourceView | undefined;
let sourceKey = "";
let trendEpoch = -1;
let trend: TrendPoint[] = [];
const valueRange = new Map<string, { min: number; max: number }>();

app.ontoolresult = (r) => {
  const id = (r.structuredContent as { panelId?: string } | undefined)?.panelId;
  if (id) panelId = id;
};

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}
app.onhostcontextchanged = (ctx) => {
  applyContext({ ...app.getHostContext(), ...ctx });
  if (state) render();
};

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T | undefined> {
  try {
    const r = await app.callServerTool({ name, arguments: args });
    if (r.isError) return undefined;
    if (r.structuredContent) return r.structuredContent as T;
    const text = r.content?.find((c) => c.type === "text") as { text?: string } | undefined;
    return text?.text ? (JSON.parse(text.text) as T) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- polling

async function poll() {
  if (stopped) return;
  const s = await call<PanelState>("get_sim_state", panelId ? { panelId } : {});
  if (s) {
    if (!s.current) {
      stopped = true;
      document.body.classList.add("superseded");
      return;
    }
    state = s;
    if (s.journalSeq > lastSeq) {
      const e = await call<{ events: SimEvent[]; last: number }>("get_events", { since: lastSeq });
      if (e) {
        events = [...events, ...e.events].slice(-200);
        lastSeq = e.events.at(-1)?.seq ?? e.last;
        if (e.events.some((x) => x.kind === "mirror_synced")) sourceKey = "";
      }
    }
    const busy = s.status === "running" || !!s.activity;
    if (busy || s.trendEpoch !== trendEpoch || trend.length === 0) {
      const since = s.trendEpoch === trendEpoch ? (trend.at(-1)?.t ?? -1) : -1;
      const t = await call<{ epoch: number; points: TrendPoint[]; reset: boolean }>("get_trend", { epoch: trendEpoch, since });
      if (t) {
        if (t.reset || t.epoch !== trendEpoch) {
          trend = [];
          valueRange.clear();
        }
        trendEpoch = t.epoch;
        trend = [...trend, ...t.points].slice(-20000);
      }
    }
    await loadSource(s);
    render();
  }
  const fast = state && (state.status === "running" || state.activity);
  setTimeout(poll, fast ? 250 : 1000);
}

async function loadSource(s: PanelState) {
  const want = s.location && !s.location.harness && s.location.obj ? s.location.obj : (source?.title ?? "");
  const top = want.split("/")[0] ?? "";
  if (top && source && source.title.toLowerCase() === top.toLowerCase() && sourceKey) return;
  if (!top && sourceKey) return;
  const r = await call<{ source: SourceView | null }>("get_source", top ? { obj: top } : {});
  if (r?.source) {
    source = r.source;
    sourceKey = source.file;
  }
}

// ---------------------------------------------------------------- render

function render() {
  const s = state!;
  const label: Record<string, string> = { running: "Running", paused: "Paused", stopped: "Stopped", no_mirror: "Not started", no_project: "No project" };
  // Between the segments of a run or an experiment the runtime is briefly paused; show the activity as running.
  const shown = s.activity && (s.status === "paused" || s.status === "running") ? "running" : s.status;
  $("status").className = `pill ${shown === "running" ? "running" : shown === "paused" ? "paused" : "stopped"}`;
  $("statusText").textContent = label[shown] ?? shown;
  $("meta").textContent =
    s.status === "running" || s.status === "paused"
      ? `scan ${s.scan} · ${s.simTime.toFixed(2)} s · ${s.timeScale}x${s.cycleMs ? ` · ${s.cycleMs} ms cycle` : ""}`
      : (s.exitInfo ?? (s.project ? s.project.split(/[\\/]/).pop()! : ""));
  const where = s.location && !s.location.harness && s.location.obj ? `Stopped${s.location.breakpoint ? ` at breakpoint #${s.location.breakpoint}` : ` (${s.location.reason})`}: ${s.location.obj} line ${s.location.line}` : "";
  $("activity").textContent = s.activity ?? where;
  const badge = $("badge");
  badge.textContent = `Simulated in truST${s.trust ? ` ${s.trust}` : ""}${s.warnings.length ? ` · ${s.warnings.length} warning${s.warnings.length > 1 ? "s" : ""}` : ""}`;
  badge.className = `badge${s.warnings.length ? " warn" : ""}`;
  badge.title = s.warnings.join("\n");
  renderCode(s);
  renderPid(s);
  renderIo(s);
  renderTrend(s);
  renderExperiments(s);
  renderEvents();
}

function renderCode(s: PanelState) {
  const el = $("code");
  if (!source) {
    el.innerHTML = `<div class="empty">${s.status === "no_project" ? "Open a CODESYS project." : "Run sync_mirror to see the code."}</div>`;
    $("codeTitle").textContent = "";
    return;
  }
  $("codeTitle").textContent = source.title;
  const loc = s.location && !s.location.harness ? s.location : undefined;
  const bps = new Set(s.breakpoints.map((b) => `${b.obj.toLowerCase()}:${b.line}`));
  const out: string[] = [];
  let section = "";
  let curIdx = -1;
  source.lines.forEach((l, i) => {
    const key = l.obj ? `${l.obj}|${l.part}` : section;
    if (l.obj && key !== section) {
      section = key;
      if (l.obj.includes("/") || l.part === "impl") out.push(`<div class="sect">${esc(l.obj)}${l.part === "decl" ? "" : " · implementation"}</div>`);
    }
    const cur = !!loc && !!l.obj && l.obj.toLowerCase() === loc.obj?.toLowerCase() && l.part === loc.part && l.line === loc.line;
    if (cur) curIdx = i;
    const bp = l.obj && l.part === "impl" && bps.has(`${l.obj.toLowerCase()}:${l.line}`);
    const cls = ["ln", l.part === "decl" ? "decl" : l.obj ? "" : "gen", cur ? "cur" : ""].filter(Boolean).join(" ");
    out.push(`<div class="${cls}" data-i="${i}"><span class="bp">${bp ? "●" : ""}</span><span class="no">${l.line ?? ""}</span><span class="tx">${esc(l.text) || " "}</span></div>`);
  });
  const html = out.join("");
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
    if (curIdx >= 0) {
      const row = el.querySelector<HTMLElement>(`[data-i="${curIdx}"]`);
      if (row) el.scrollTop = Math.max(0, row.offsetTop - el.clientHeight / 2);
    }
  }
}

const sig = (s: PanelState, name?: string): PanelSignal | undefined => (name ? s.signals.find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined);
const short = (name: string) => name.split(".").pop()!;
const truthy = (x?: PanelSignal) => x?.num !== undefined && x.num !== null && x.num !== 0;

function deviceState(s: PanelState, fb: { signal: string; follows: string; invert: boolean }) {
  const on = truthy(sig(s, fb.signal));
  const cmd = truthy(sig(s, fb.follows)) !== fb.invert;
  const forced = !!sig(s, fb.signal)?.forced || !!sig(s, fb.follows)?.forced;
  const color = s.status !== "running" && s.status !== "paused" ? "var(--fg2)" : on ? "var(--ok)" : cmd ? "var(--warn)" : "var(--fg2)";
  return { on, cmd, forced, color, label: on ? (cmd ? "on" : "stopping") : cmd ? "starting" : "off" };
}

function renderPid(s: PanelState) {
  const el = $("pid");
  if (!s.plants.length && !s.feedback.length) {
    el.innerHTML = `<div class="empty">No plant. Describe one in plant.toml (see sync_mirror).</div>`;
    return;
  }
  const W = 360;
  const H = 200;
  const parts: string[] = [];
  const tank = s.plants.find((p) => /tank/i.test(p.model)) ?? s.plants[0];
  const valve = s.feedback.find((f) => /xv|valve|vlv/i.test(f.signal + f.follows));
  const pump = s.feedback.find((f) => f !== valve && /p\d{2,}|pump|pmp/i.test(short(f.signal) + short(f.follows)));
  const others = s.feedback.filter((f) => f !== valve && f !== pump);
  if (tank) {
    const lv = sig(s, tank.outputs[0]);
    const inflow = sig(s, tank.inputs[0]);
    const r = valueRange.get(tank.id) ?? { min: 0, max: 0 };
    if (lv?.num !== undefined && lv.num !== null) r.max = Math.max(r.max, lv.num);
    valueRange.set(tank.id, r);
    const max = tank.display?.max ?? Math.max(1, Math.ceil(r.max * 1.25 * 2) / 2);
    const min = tank.display?.min ?? 0;
    const unit = tank.display?.unit ?? (/tank/i.test(tank.model) ? "m" : "");
    const level = lv?.num ?? null;
    const frac = level === null ? 0 : Math.max(0, Math.min(1, (level - min) / (max - min)));
    const tx = 150, ty = 30, tw = 90, th = 130;
    // inlet pipe with valve
    parts.push(`<line x1="20" y1="${ty + 12}" x2="${tx}" y2="${ty + 12}" stroke="var(--fg2)" stroke-width="4"/>`);
    if (inflow) parts.push(`<text x="22" y="${ty + 2}" class="small">${esc(short(inflow.name))} ${esc(show(inflow))}${inflow.forced ? " F" : ""}</text>`);
    if (valve) {
      const d = deviceState(s, valve);
      const vx = 90, vy = ty + 12;
      parts.push(`<polygon points="${vx - 12},${vy - 9} ${vx - 12},${vy + 9} ${vx + 12},${vy - 9} ${vx + 12},${vy + 9}" fill="${d.on ? d.color : "var(--bg)"}" stroke="${d.color}" stroke-width="2"/>`);
      parts.push(`<text x="${vx}" y="${vy + 24}" text-anchor="middle" class="small">${esc(short(valve.signal).replace(/_?(Opened|Open|FB)$/i, ""))} ${d.label}${d.forced ? " F" : ""}</text>`);
    }
    // tank
    parts.push(`<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="6" fill="var(--bg)" stroke="var(--fg2)" stroke-width="2"/>`);
    parts.push(`<rect x="${tx + 2}" y="${ty + 2 + (th - 4) * (1 - frac)}" width="${tw - 4}" height="${(th - 4) * frac}" rx="4" fill="var(--water-bg)" stroke="none"/>`);
    parts.push(`<line x1="${tx + 2}" x2="${tx + tw - 2}" y1="${ty + 2 + (th - 4) * (1 - frac)}" y2="${ty + 2 + (th - 4) * (1 - frac)}" stroke="var(--water)" stroke-width="2"/>`);
    parts.push(`<text x="${tx + tw / 2}" y="${ty - 8}" text-anchor="middle">${esc(tank.display?.label ?? tank.id)}</text>`);
    parts.push(`<text x="${tx + tw / 2}" y="${ty + th / 2 + 4}" text-anchor="middle" style="font-weight:600">${level === null ? "–" : `${fmt(level)} ${unit}`}${lv?.forced ? " F" : ""}</text>`);
    parts.push(`<text x="${tx + tw + 4}" y="${ty + 8}" class="small">${fmt(max)}</text><text x="${tx + tw + 4}" y="${ty + th}" class="small">${fmt(min)}</text>`);
    if (lv) parts.push(`<text x="${tx + tw / 2}" y="${ty + th + 14}" text-anchor="middle" class="small">${esc(short(lv.name))}</text>`);
    // outlet with pump
    const oy = ty + th - 14;
    parts.push(`<line x1="${tx + tw}" y1="${oy}" x2="${W - 10}" y2="${oy}" stroke="var(--fg2)" stroke-width="4"/>`);
    if (pump) {
      const d = deviceState(s, pump);
      const px = tx + tw + 50;
      parts.push(`<circle cx="${px}" cy="${oy}" r="13" fill="${d.on ? d.color : "var(--bg)"}" stroke="${d.color}" stroke-width="2"/>`);
      parts.push(`<polygon points="${px - 5},${oy - 7} ${px - 5},${oy + 7} ${px + 8},${oy}" fill="${d.on ? "var(--bg)" : d.color}"/>`);
      parts.push(`<text x="${px}" y="${oy + 28}" text-anchor="middle" class="small">${esc(short(pump.signal).replace(/_?(Running|Run|FB)$/i, ""))} ${d.label}${d.forced ? " F" : ""}</text>`);
    }
    for (const p of s.plants.filter((x) => x !== tank).slice(0, 2)) parts.push(`<text x="10" y="${H - 20}" class="small">${esc(p.id)} (${esc(p.model)})</text>`);
  }
  others.slice(0, 4).forEach((f, i) => {
    const d = deviceState(s, f);
    const x = 14 + i * 80;
    parts.push(`<rect x="${x}" y="${H - 26}" width="12" height="12" rx="3" fill="${d.on ? d.color : "var(--bg)"}" stroke="${d.color}" stroke-width="2"/>`);
    parts.push(`<text x="${x + 16}" y="${H - 16}" class="small">${esc(short(f.signal))}</text>`);
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Plant">${parts.join("")}</svg>`;
}

function renderIo(s: PanelState) {
  const el = $("io");
  if (!s.signals.length) {
    el.innerHTML = `<div class="empty">No plant signals.</div>`;
    return;
  }
  const role: Record<string, string> = { plant_out: "plant → PLC", plant_in: "PLC → plant", feedback: "feedback", command: "command", experiment: "experiment" };
  el.innerHTML = `<table>${s.signals
    .map(
      (x) =>
        `<tr title="${esc(x.value ?? "")}"><td>${esc(x.name)}${x.forced ? '<span class="forced">F</span>' : ""}<div class="r">${role[x.role] ?? x.role}${x.address ? ` · ${esc(x.address)}` : ""}</div></td><td class="v">${esc(show(x))}</td></tr>`,
    )
    .join("")}</table>`;
}

const COLORS = ["#2563eb", "#16a34a", "#d97706", "#9333ea", "#dc2626", "#0891b2", "#db2777", "#65a30d"];

function renderTrend(s: PanelState) {
  const canvas = $<HTMLCanvasElement>("trend");
  const names = s.signals.map((x) => x.name).filter((n) => trend.some((p) => typeof p.values[n] === "number"));
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const lane = 34;
  const cssH = Math.max(60, names.length * lane + 18);
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
    $("trendInfo").textContent = "";
    return;
  }
  const t0 = trend[0]!.t;
  const t1 = Math.max(trend.at(-1)!.t, t0 + 1e-6);
  const left = 150;
  const right = 8;
  const plotW = cssW - left - right;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * plotW;
  $("trendInfo").textContent = `${t0.toFixed(1)}–${t1.toFixed(1)} s simulated`;
  names.forEach((n, i) => {
    const top = 4 + i * lane;
    const h = lane - 8;
    const pts = trend.map((p) => [p.t, p.values[n]] as const).filter((p): p is readonly [number, number] => typeof p[1] === "number");
    const isBool = /^(TRUE|FALSE)$/.test(s.signals.find((x) => x.name === n)?.value ?? "") && pts.every((p) => p[1] === 0 || p[1] === 1);
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
    g.fillText(isBool ? (last ? "TRUE" : "FALSE") : `${fmt(last)}  [${fmt(lo)}…${fmt(hi)}]`, 8, top + 24);
  });
  // time axis labels
  g.fillStyle = fg2;
  g.fillText(`${t0.toFixed(0)} s`, left, cssH - 3);
  const end = `${t1.toFixed(0)} s`;
  g.fillText(end, cssW - right - g.measureText(end).width, cssH - 3);
}

function renderExperiments(s: PanelState) {
  const el = $("exps");
  if (!s.experiments.length) {
    el.innerHTML = `<div class="empty">No experiments yet.</div>`;
    return;
  }
  const keys: [string, string, boolean][] = [
    ["overshoot_pct", "overshoot %", true],
    ["rise_time_s", "rise s", true],
    ["settling_time_s", "settling s", true],
    ["iae", "IAE", true],
  ];
  el.innerHTML = [...s.experiments]
    .reverse()
    .map((e) => {
      const prev = [...s.experiments].reverse().find((p) => p.n < e.n && p.name === e.name);
      const m = keys
        .filter(([k]) => k in e.metrics)
        .map(([k, l, lowerBetter]) => {
          const v = e.metrics[k];
          const pv = prev?.metrics[k];
          let cls = "";
          if (typeof v === "number" && typeof pv === "number" && v !== pv) cls = (v < pv) === lowerBetter ? "better" : "worse";
          return `${l} <span class="${cls}">${v === null ? "–" : typeof v === "number" ? fmt(v) : esc(String(v))}</span>`;
        })
        .join(" · ");
      return `<div class="exp"><span class="t">#${e.n}</span><b>${esc(e.name)}</b><div class="m">${m || "no metrics"}</div></div>`;
    })
    .join("");
}

function renderEvents() {
  const el = $("events");
  if (!events.length) return;
  el.innerHTML = [...events]
    .reverse()
    .slice(0, 40)
    .map((e) => `<div><span class="t">${new Date(e.at).toLocaleTimeString()}</span>${esc(e.text)}</div>`)
    .join("");
}

window.addEventListener("resize", () => state && renderTrend(state));

app
  .connect()
  .then(() => {
    applyContext(app.getHostContext());
    void poll();
  })
  .catch((e: Error) => {
    $("statusText").textContent = "Not connected";
    $("activity").textContent = e.message;
  });
