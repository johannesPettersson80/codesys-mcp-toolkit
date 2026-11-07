/** The compact card shown inline in the chat. */
import { model } from "./model.js";
import { renderPid } from "./plant.js";
import { drawTrend } from "./trend.js";
import { $, ago, esc } from "./util.js";

export function renderCard(): void {
  const s = model.state;
  const ws = model.ws;
  const label: Record<string, string> = { running: "Running", paused: "Paused", stopped: "Stopped", no_mirror: "Not simulated", no_project: "No project" };
  const shown = s?.activity && (s.status === "paused" || s.status === "running") ? "running" : (s?.status ?? "stopped");
  $("c-status").className = `pill ${shown === "running" ? "running" : shown === "paused" ? "paused" : ""}`;
  $("c-statusText").textContent = s ? (label[shown] ?? shown) : "Connecting";
  $("c-meta").textContent = s && (s.status === "running" || s.status === "paused") ? `scan ${s.scan} · ${s.simTime.toFixed(2)} s · ${s.timeScale}x` : (ws?.project?.split(/[\\/]/).pop() ?? "");
  const where = s?.location && !s.location.harness && s.location.obj ? `Stopped${s.location.breakpoint ? ` at breakpoint #${s.location.breakpoint}` : ""}: ${s.location.obj} line ${s.location.line}` : "";
  $("c-activity").textContent = s?.held ? "You're driving: Claude is paused." : (s?.activity ?? where);
  $("c-hold").setAttribute("aria-pressed", String(!!s?.held));
  $("c-hold").textContent = s?.held ? "Resume Claude" : "Pause Claude";

  const facts: string[] = [];
  const f = ws?.focus;
  if (f) facts.push(`<span class="fact"><span class="muted">Working on</span><b>${esc(f.path)}</b><span class="muted">${f.action} · ${ago(f.at)}</span></span>`);
  if (ws?.changeCount !== undefined && ws.tree) facts.push(`<span class="fact"><span class="muted">Changes</span><b>${ws.changeCount}</b><span class="muted">object${ws.changeCount === 1 ? "" : "s"} this session</span></span>`);
  const c = ws?.compile;
  if (c) facts.push(`<span class="fact"><span class="muted">Compile</span><b class="${c.errors ? "bad" : "good"}">${c.errors} error${c.errors === 1 ? "" : "s"}</b>${c.warnings ? `<span class="warnc">${c.warnings} warning${c.warnings === 1 ? "" : "s"}</span>` : ""}</span>`);
  const t = s?.tests;
  if (t) facts.push(`<span class="fact"><span class="muted">Tests</span><b class="${t.failed ? "bad" : "good"}">${t.passed}/${t.total}</b>${t.failed ? `<span class="bad">${t.failed} failing</span>` : ""}</span>`);
  const e = s?.experiments.at(-1);
  if (e) {
    const prev = [...(s?.experiments ?? [])].reverse().find((p) => p.n < e.n && p.name === e.name);
    const iae = e.metrics.iae;
    const was = prev?.metrics.iae;
    facts.push(
      `<span class="fact"><span class="muted">Experiment</span><b>${esc(e.name)}</b>${typeof iae === "number" ? `<span>IAE ${iae}${typeof was === "number" ? ` <span class="${iae < was ? "good" : "bad"}">(was ${was})</span>` : ""}</span>` : ""}</span>`,
    );
  }
  $("c-facts").innerHTML = facts.join("") || `<span class="muted">Nothing yet: open a project, sync the mirror and start the simulation.</span>`;
  if (s) {
    renderPid($("c-pid"), s);
    drawTrend($("c-trend") as HTMLCanvasElement, s, model.trend, { compact: true });
  }
}
