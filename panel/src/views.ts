/**
 * The panel's views. While "Follow Claude" is on, the view follows what Claude
 * is doing (the server reports its last kind of work); clicking a view pins it.
 *
 *   Code        Claude writes, creates or compiles
 *   Unit tests  Claude runs the tests
 *   Simulation  Claude starts, runs, steps or forces the simulation
 *   Tuning      Claude runs experiments (or truST tuning)
 *   Review      Claude changed objects and has been quiet for a while
 */
import { lineDiff } from "../../src/codesys/diff.js";
import type { ExperimentRun } from "../../src/sim/panel-types.js";
import { model, type ObjData } from "./model.js";
import { highlight } from "./st.js";
import { ago, esc, fmt } from "./util.js";

export type ViewName = "code" | "tests" | "simulation" | "tuning" | "review";

export const VIEWS: [ViewName, string][] = [
  ["code", "Code"],
  ["tests", "Unit tests"],
  ["simulation", "Simulation"],
  ["tuning", "Tuning"],
  ["review", "Review"],
];

/** Review comes up only once Claude has been quiet this long, so it never interrupts work. */
export const REVIEW_AFTER_MS = 20_000;

export const views = {
  /** The view the user picked (used while not following Claude). */
  pinned: undefined as ViewName | undefined,
  runs: [] as ExperimentRun[],
};

export function unreviewed(): number {
  return model.ws?.changeCount ?? 0;
}

/** The view that fits what Claude is doing. */
export function autoView(): ViewName {
  const s = model.state;
  const p = s?.phase;
  if (unreviewed() > 0 && (!p || p.view === "code") && (p?.quietMs ?? Infinity) > REVIEW_AFTER_MS && !s?.activity) return "review";
  if (p) return p.view;
  if (s && (s.status === "running" || s.status === "paused")) return "simulation";
  return "code";
}

export function currentView(follow: boolean): ViewName {
  return !follow && views.pinned ? views.pinned : autoView();
}

/** The view tab row; the view Claude's work points at is marked while following. */
export function viewTabs(current: ViewName, follow: boolean): string {
  const auto = autoView();
  const s = model.state;
  const count = (id: ViewName): string => {
    if (id === "tests" && s?.tests) return s.tests.failed ? `<span class="vc bad">${s.tests.failed}</span>` : `<span class="vc good">✓</span>`;
    if (id === "review" && unreviewed()) return `<span class="vc">${unreviewed()}</span>`;
    if (id === "code" && model.ws?.compile?.errors) return `<span class="vc bad">${model.ws.compile.errors}</span>`;
    if (id === "tuning" && s?.experiments.length) return `<span class="vc">${s.experiments.length}</span>`;
    return "";
  };
  return VIEWS.map(
    ([id, label]) =>
      `<button data-view="${id}" aria-pressed="${id === current}"${follow && id === auto ? ' class="auto" title="Claude is working here"' : ""}>${label}${count(id)}</button>`,
  ).join("");
}

// ------------------------------------------------------------------ code

/** The object Claude is working on (or the last one it changed). */
export function codePath(): string | undefined {
  const f = model.ws?.focus;
  if (f && f.action !== "delete" && f.action !== "read") return f.path;
  return model.ws?.tree?.find((n) => n.change)?.path ?? (f && f.action !== "delete" ? f.path : undefined);
}

/** Live code: the object as Claude writes it, with new lines marked. */
export function codeView(path: string | undefined, d: ObjData | undefined): string {
  if (!model.ws?.tree) return `<div class="empty">Open a project: Claude's code shows up here as it is written.</div>`;
  if (!path) return `<div class="empty">Waiting for Claude to write code. Each object it creates or changes shows here.</div>`;
  const f = model.ws.focus;
  const verb = f?.path === path ? ({ write: "is writing", create: "created", revert: "reverted", rename: "renamed" } as Record<string, string>)[f.action] ?? "" : "";
  const head = `<div class="vhead"><b>${esc(path)}</b>${verb ? `<span class="muted">Claude ${verb} it${f ? ` · ${ago(f.at)}` : ""}</span>` : ""}${compileLine()}</div>`;
  if (!d) return `${head}<div class="empty">Loading…</div>`;
  const o = d.object;
  if (!o) return `${head}<div class="empty">${esc(path)} was removed.</div>`;
  if (o.st === false) return `${head}<div class="empty">${esc(path)} has a graphical body (SFC, CFC, LD or FBD), which isn't shown as text.</div>`;
  const out: string[] = [head, `<div class="code live">`];
  for (const part of ["decl", "impl"] as const) {
    const text = part === "decl" ? o.declaration : o.implementation;
    if (text === null || (part === "impl" && !text.trim() && o.kind !== "pou" && o.kind !== "method" && o.kind !== "accessor")) continue;
    out.push(`<div class="part">${part === "decl" ? "Declaration" : "Implementation"}</div>`);
    const now = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    const base = d.base ? ((part === "decl" ? d.base.declaration : d.base.implementation) ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "") : "";
    const hs = { inComment: false };
    let n = 0;
    for (const op of lineDiff(base, now)) {
      if (op.op === "-") continue; // live view: what is there now; the Review view shows removals
      n++;
      out.push(`<div class="ln${op.op === "+" ? " add" : ""}"><span class="no">${n}</span><span class="tx">${highlight(op.text, hs) || " "}</span></div>`);
    }
  }
  out.push(`</div>`);
  return out.join("");
}

function compileLine(): string {
  const c = model.ws?.compile;
  if (!c) return "";
  return `<span class="cl ${c.errors ? "bad" : "good"}">${c.errors ? `${c.errors} compile error${c.errors > 1 ? "s" : ""}` : "Compiles"}${c.warnings ? `, ${c.warnings} warning${c.warnings > 1 ? "s" : ""}` : ""}</span>`;
}

/** Compile messages for the object (or all), below the code. */
export function problemsList(path?: string): string {
  const msgs = (model.ws?.compile?.messages ?? []).filter((m) => m.severity !== "info" && (!path || (m.object ?? "").toLowerCase().includes(path.toLowerCase().split("/")[0]!)));
  if (!msgs.length) return "";
  return `<ul class="problems">${msgs
    .slice(0, 6)
    .map((m) => `<li><span class="${m.severity === "error" ? "err" : "wrn"}">${m.severity === "error" ? "Error" : "Warning"}</span> ${esc(m.text)}${m.position ? ` <span class="muted">${esc(m.position)}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

// ------------------------------------------------------------------ unit tests

export function testsView(): string {
  const t = model.state?.tests;
  const testObjs = (model.ws?.tree ?? []).filter((n) => n.test);
  if (!t) {
    return testObjs.length
      ? `<div class="vhead"><b>${testObjs.length} test${testObjs.length > 1 ? "s" : ""}</b><span class="muted">not run yet</span></div><ul class="tests">${testObjs.map((n) => `<li><span class="ti">·</span><span>${esc(n.path)}</span></li>`).join("")}</ul>`
      : `<div class="empty">No tests yet. A test is a PROGRAM marked {attribute 'test'}; Claude runs them in truST with run_tests.</div>`;
  }
  const rows = (t.results ?? t.failing.map((f) => ({ name: f, obj: f, status: "failed" as string, message: undefined as string | undefined, durationMs: undefined as number | undefined })))
    .slice()
    .sort((a, b) => Number(a.status === "passed") - Number(b.status === "passed"));
  return (
    `<div class="vhead"><b class="${t.failed ? "bad" : "good"}">${t.passed}/${t.total} passed</b>${t.failed ? `<span class="bad">${t.failed} failing</span>` : ""}<span class="muted">${ago(t.at)}</span></div>` +
    `<ul class="tests">${rows
      .map(
        (r) =>
          `<li class="${r.status === "passed" ? "pass" : "fail"}"><span class="ti">${r.status === "passed" ? "✓" : "✗"}</span><span><b>${esc(r.obj)}</b>${r.message ? `<div class="msg">${esc(r.message)}</div>` : ""}</span>${r.durationMs !== undefined ? `<span class="muted t">${r.durationMs} ms</span>` : ""}</li>`,
      )
      .join("")}</ul>`
  );
}

// ------------------------------------------------------------------ tuning

/** The runs to compare: the latest experiment and earlier runs of the same name. */
export function compareRuns(): ExperimentRun[] {
  const last = views.runs.at(-1);
  if (!last) return [];
  return views.runs.filter((r) => r.name === last.name).slice(-6);
}

const RUN_COLORS = ["#94a3b8", "#0891b2", "#9333ea", "#d97706", "#16a34a", "#2563eb"];

export function tuningView(): string {
  const runs = compareRuns();
  if (!runs.length) return `<div class="empty">No experiments yet. Claude's step tests (run_experiment) show here, overlaid, so you can compare tunings.</div>`;
  const best = runs.reduce((a, b) => (num(b.metrics.iae) < num(a.metrics.iae) ? b : a));
  const color = (i: number) => RUN_COLORS[(RUN_COLORS.length - runs.length + i) % RUN_COLORS.length];
  const setTxt = (r: ExperimentRun) =>
    Object.entries(r.set)
      .map(([k, v]) => `${esc(k.split(".").pop()!.replace(/^_/, ""))}=${esc(String(v))}`)
      .join(", ") || `<span class="muted">as programmed</span>`;
  const m = (r: ExperimentRun, k: string, unit = "") => (typeof r.metrics[k] === "number" ? `${fmt(r.metrics[k] as number)}${unit}` : "–");
  return (
    `<div class="vhead"><b>${esc(runs.at(-1)!.name)}</b><span class="muted">${runs.length} run${runs.length > 1 ? "s" : ""}${runs.at(-1)!.pv ? ` · ${esc(runs.at(-1)!.pv!)}` : ""}</span></div>` +
    `<canvas class="runs"></canvas>` +
    `<table class="runtab"><thead><tr><th></th><th>Run</th><th>Settings</th><th>Rise</th><th>Overshoot</th><th>Settling</th><th>IAE</th></tr></thead><tbody>${runs
      .map(
        (r, i) =>
          `<tr${r === best && runs.length > 1 ? ' class="best"' : ""}><td><span class="sw" style="background:${color(i)}"></span></td><td>#${r.n}</td><td>${setTxt(r)}</td><td>${m(r, "rise_time_s", " s")}</td><td>${m(r, "overshoot_pct", " %")}</td><td>${m(r, "settling_time_s", " s")}</td><td>${m(r, "iae")}${r === best && runs.length > 1 ? ' <span class="good">best</span>' : ""}</td></tr>`,
      )
      .join("")}</tbody></table>`
  );
}

function num(x: unknown): number {
  return typeof x === "number" ? x : Infinity;
}

/** Overlay the step responses of the compared runs, with the setpoint dashed. */
export function drawRuns(canvas: HTMLCanvasElement): void {
  const runs = compareRuns();
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = 170;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
  }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const pts = runs.flatMap((r) => r.points.filter((p) => p.pv !== null));
  if (!pts.length) return;
  const sps = runs.map((r) => Number(r.sp?.value)).filter(Number.isFinite);
  const t0 = Math.min(...pts.map((p) => p.t));
  const t1 = Math.max(...pts.map((p) => p.t));
  let y0 = Math.min(...pts.map((p) => p.pv!), ...sps);
  let y1 = Math.max(...pts.map((p) => p.pv!), ...sps);
  const pad = (y1 - y0) * 0.08 || 0.1;
  y0 -= pad;
  y1 += pad;
  const css = getComputedStyle(document.documentElement);
  const fg2 = css.getPropertyValue("--fg2").trim() || "#888";
  const line = css.getPropertyValue("--line").trim() || "#ddd";
  const L = 40, R = 8, T = 8, B = 18;
  const X = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (w - L - R);
  const Y = (y: number) => T + (1 - (y - y0) / (y1 - y0 || 1)) * (h - T - B);
  g.font = `10px ${css.getPropertyValue("--font") || "sans-serif"}`;
  g.strokeStyle = line;
  g.fillStyle = fg2;
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = y0 + ((y1 - y0) * i) / 4;
    g.beginPath();
    g.moveTo(L, Y(y));
    g.lineTo(w - R, Y(y));
    g.stroke();
    g.fillText(fmt(y), 2, Y(y) + 3);
  }
  g.fillText(`${fmt(t0)} s`, L, h - 4);
  g.fillText(`${fmt(t1)} s`, w - R - 40, h - 4);
  const last = runs.at(-1)!;
  if (last.sp && Number.isFinite(Number(last.sp.value))) {
    g.setLineDash([4, 4]);
    g.strokeStyle = fg2;
    g.beginPath();
    const ts = last.sp.at_s ?? t0;
    const before = runs.at(-1)!.points.find((p) => p.pv !== null)?.pv ?? Number(last.sp.value);
    g.moveTo(X(t0), Y(before));
    g.lineTo(X(ts), Y(before));
    g.lineTo(X(ts), Y(Number(last.sp.value)));
    g.lineTo(X(t1), Y(Number(last.sp.value)));
    g.stroke();
    g.setLineDash([]);
  }
  runs.forEach((r, i) => {
    g.strokeStyle = RUN_COLORS[(RUN_COLORS.length - runs.length + i) % RUN_COLORS.length]!;
    g.lineWidth = r === last ? 2.2 : 1.3;
    g.beginPath();
    let started = false;
    for (const p of r.points) {
      if (p.pv === null) continue;
      if (!started) g.moveTo(X(p.t), Y(p.pv));
      else g.lineTo(X(p.t), Y(p.pv));
      started = true;
    }
    g.stroke();
  });
}

// ------------------------------------------------------------------ review

export function reviewView(): string {
  const tree = model.ws?.tree ?? [];
  const changed = tree.filter((n) => n.change && !tree.some((p) => p.change && n.path.toLowerCase().startsWith(p.path.toLowerCase() + "/")));
  const removed = model.ws?.removed ?? [];
  if (!changed.length && !removed.length) return `<div class="empty">Nothing to review: every change Claude made is accepted.</div>`;
  const row = (path: string, mark: string, what: string) =>
    `<li data-path="${esc(path)}"><span class="mk ${mark}">${mark}</span><span class="rp"><b>${esc(path)}</b><span class="muted">${what}</span></span>` +
    `<button class="btn" data-rv="diff">Changes</button><button class="btn good" data-rv="accept">Accept</button><button class="btn danger" data-rv="revert">Revert</button></li>`;
  return (
    `<div class="vhead"><b>${changed.length + removed.length} to review</b><span class="muted">since you last accepted</span></div>` +
    `<ul class="review-list">${changed.map((n) => row(n.path, n.change!, n.change === "A" ? "added" : "changed")).join("")}${removed
      .filter((p) => !removed.some((q) => p.toLowerCase().startsWith(q.toLowerCase() + "/")))
      .map((p) => row(p, "D", "removed"))
      .join("")}</ul>`
  );
}
