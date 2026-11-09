/** The compact card shown inline in the chat: status, a view tab row, and the current view. */
import { model } from "./model.js";
import { renderPid } from "./plant.js";
import { drawTrend } from "./trend.js";
import { $, ago, esc } from "./util.js";
import { codePath, codeView, drawTuningCharts, problemsList, reviewView, testsView, tuningView, viewTabs, type ViewName } from "./views.js";

let shownView: ViewName | undefined;
let shownHtml = "";
/** The added lines last scrolled to, so a re-render doesn't jump around. */
let writtenKey = "";

export function renderCard(view: ViewName, follow: boolean): void {
  const s = model.state;
  const ws = model.ws;
  const label: Record<string, string> = { running: "Running", paused: "Paused", stopped: "Stopped", no_mirror: "Not simulated", no_project: "No project" };
  const shown = s?.activity && (s.status === "paused" || s.status === "running") ? "running" : (s?.status ?? "stopped");
  $("c-status").className = `pill ${shown === "running" ? "running" : shown === "paused" ? "paused" : ""}`;
  // Before the simulation runs, the project is what matters.
  $("c-statusText").textContent = !s ? "Connecting" : s.status === "no_mirror" || s.status === "no_project" ? (ws?.project ? "Project open" : "No project") : (label[shown] ?? shown);
  $("c-meta").textContent = s && (s.status === "running" || s.status === "paused") ? `scan ${s.scan} · ${s.simTime.toFixed(2)} s · ${s.timeScale}x` : (ws?.project?.split(/[\\/]/).pop() ?? "");
  $("c-meta").title = ws?.versions ?? "";
  const where = s?.location && !s.location.harness && s.location.obj ? `Stopped${s.location.breakpoint ? ` at breakpoint #${s.location.breakpoint}` : ""}: ${s.location.obj} line ${s.location.line}` : "";
  $("c-activity").textContent = s?.held ? "You're driving: Claude is paused." : (s?.activity ?? where);
  $("c-hold").setAttribute("aria-pressed", String(!!s?.held));
  $("c-hold").textContent = s?.held ? "Resume Claude" : "Pause Claude";
  $("c-follow").setAttribute("aria-pressed", String(follow));

  const facts: string[] = [];
  const f = ws?.focus;
  if (f) facts.push(`<span class="fact"><span class="muted">Working on</span><b>${esc(f.path)}</b><span class="muted">${f.action} · ${ago(f.at)}</span></span>`);
  if (ws?.changeCount !== undefined && ws.tree) facts.push(`<span class="fact"><span class="muted">Changes</span><b>${ws.changeCount}</b><span class="muted">to review</span></span>`);
  $("c-facts").innerHTML = facts.join("");

  $("c-views").innerHTML = viewTabs(view, follow);
  const el = $("c-view");
  if (view === "simulation") {
    if (shownView !== view) {
      el.innerHTML = `<div class="card-body"><div class="box pid"><h3>Plant</h3><div class="pidbox"></div></div><div class="box"><h3>Trend</h3><canvas class="trend"></canvas></div></div>`;
      shownHtml = "";
    }
    if (s) {
      renderPid(el.querySelector<HTMLElement>(".pidbox")!, s);
      drawTrend(el.querySelector<HTMLCanvasElement>("canvas.trend")!, s, model.trend, { compact: true });
    } else el.querySelector<HTMLElement>(".pidbox")!.innerHTML = `<div class="empty">No simulation yet.</div>`;
    shownView = view;
    return;
  }
  let html = "";
  if (view === "code") {
    const path = codePath();
    html = codeView(path, path ? model.objects.get(path.toLowerCase()) : undefined) + problemsList(path);
  } else if (view === "tests") html = testsView();
  else if (view === "tuning") html = tuningView();
  else html = reviewView(true);
  // Don't rebuild (and lose the scroll position) when nothing changed.
  if (shownView !== view || html !== shownHtml) {
    const before = el.querySelector<HTMLElement>(".code.live")?.scrollTop ?? 0;
    el.innerHTML = html;
    shownHtml = html;
    const live = el.querySelector<HTMLElement>(".code.live");
    if (live) {
      // Follow the writing: jump to the newest added line when Claude wrote
      // something new; otherwise keep where the user scrolled to.
      const added = live.querySelectorAll<HTMLElement>(".ln.add");
      const key = `${codePath()}|${added.length}|${added[added.length - 1]?.textContent ?? ""}`;
      if (added.length && (key !== writtenKey || shownView !== view)) live.scrollTop = Math.max(0, added[added.length - 1]!.offsetTop - live.clientHeight / 2);
      else live.scrollTop = before;
      writtenKey = key;
    }
  }
  if (view === "tuning") {
    drawTuningCharts(el);
  }
  shownView = view;
}
