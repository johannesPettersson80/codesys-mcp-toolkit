/**
 * The CODESYS panel (MCP App view). Inline in the chat it is a compact card;
 * in full screen (or expanded inline where the host has no full screen) it is
 * a CODESYS-style workspace. It only reads: it polls the server's app-only
 * tools, and the model drives everything through its own tools.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { PanelState } from "../../src/sim/panel-types.js";
import type { TrendPoint } from "../../src/sim/recorder.js";
import type { SimEvent } from "../../src/sim/journal.js";
import { renderCard } from "./card.js";
import { model, type Locals, type ObjData, type WsData } from "./model.js";
import { $ } from "./util.js";
import { Workspace } from "./workspace.js";
import type { ExperimentRun, TuningLoop } from "../../src/sim/panel-types.js";
import { codePath, currentView, reviewRows, VIEWS, views, type ViewName } from "./views.js";
import { persist } from "./util.js";

const app = new App({ name: "codesys-workspace", version: "1.0.0" });

let panelId: string | undefined;
let stopped = false;
let lastSeq = 0;
let mode: "card" | "workspace" = "card";
let inlineExpanded = false;
/** The view on screen, and whether the workspace still needs its layout for it. */
let view: ViewName | undefined;
let workspaceStale = true;
let runsKey = "";
let tuningKey: number | undefined;

app.ontoolresult = (r) => {
  const id = (r.structuredContent as { panelId?: string } | undefined)?.panelId;
  if (id) panelId = id;
};

// ---------------------------------------------------------------- host context and layout

function applyContext(ctx: McpUiHostContext | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function layout() {
  const ctx = app.getHostContext();
  const full = ctx?.displayMode === "fullscreen";
  mode = full || inlineExpanded ? "workspace" : "card";
  document.body.classList.toggle("inline-expanded", !full && inlineExpanded);
  $("card").classList.toggle("hidden", mode !== "card");
  $("ws").classList.toggle("hidden", mode !== "workspace");
  if (mode === "workspace" && workspaceStale && view) {
    workspaceStale = false;
    workspace.applyView(view);
  }
  render();
}

app.onhostcontextchanged = (ctx) => {
  applyContext({ ...app.getHostContext(), ...ctx });
  layout();
};

async function setWorkspace(on: boolean) {
  const ctx = app.getHostContext();
  const canFull = ctx?.availableDisplayModes?.includes("fullscreen");
  if (canFull) {
    try {
      const r = await app.requestDisplayMode({ mode: on ? "fullscreen" : "inline" });
      inlineExpanded = false;
      if ((r.mode === "fullscreen") === on) return layout();
    } catch {
      /* fall back to expanding inline */
    }
  }
  inlineExpanded = on;
  layout();
  void context(on ? "The user opened the CODESYS workspace." : "The user went back to the compact panel.");
}

$("c-open").addEventListener("click", () => void setWorkspace(true));
$("w-close").addEventListener("click", () => void setWorkspace(false));

// ---------------------------------------------------------------- model context

// The host keeps only the latest model context, so it carries the current
// view plus the user's recent actions in the panel.
let contextTimer: ReturnType<typeof setTimeout> | undefined;
let viewing = "";
const recent: string[] = [];
function sendContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    const lines = [viewing, recent.length ? `Recent actions by the user in the CODESYS panel (oldest first):\n${recent.map((r) => `- ${r}`).join("\n")}` : ""].filter(Boolean);
    if (lines.length) app.updateModelContext({ content: [{ type: "text", text: lines.join("\n") }] }).catch(() => undefined);
  }, 400);
}
function context(text: string) {
  viewing = text;
  sendContext();
}

function toast(text: string, error = false) {
  const t = document.createElement("div");
  t.className = `toast${error ? " err" : ""}`;
  t.textContent = text;
  $("toasts").append(t);
  setTimeout(() => t.remove(), error ? 7000 : 4000);
}

async function act(tool: string, args: Record<string, unknown>, what: string) {
  const r = await call<{ ok: boolean; message: string }>(tool, args);
  if (!r) {
    toast("No answer from the server.", true);
    return undefined;
  }
  toast(r.message.split("\n")[0]!, !r.ok);
  if (r.ok) {
    recent.push(`${new Date().toLocaleTimeString()}: ${what}. Result: ${r.message.split("\n")[0]}`);
    if (recent.length > 8) recent.shift();
    sendContext();
  }
  pollSoon();
  return r;
}

const viewLabel = (v: ViewName) => VIEWS.find(([id]) => id === v)![1];

function pickView(v: ViewName) {
  workspace.follow = false;
  persist("ws-follow", false);
  views.pinned = v;
  render();
  context(`The user switched the CODESYS panel to the ${viewLabel(v)} view.`);
  pollSoon();
}

function followChanged() {
  if (workspace.follow) views.pinned = undefined;
  render();
  pollSoon();
}

/** Accept / Revert (second click confirms) / show changes, from a review list. */
function review(kind: string, path: string, btn: HTMLElement) {
  if (kind === "diff" && mode === "card") {
    // in the chat: show the changes in place
    const k = path.toLowerCase();
    if (!views.expanded.delete(k)) views.expanded.add(k);
    render();
    return;
  }
  if (kind === "diff" || kind === "full") {
    void setWorkspace(true).then(() => {
      workspace.diff = true;
      workspace.open(path, true);
    });
    return;
  }
  if (kind === "accept") {
    void act("ui_accept_object", { path }, `accepted Claude's changes to ${path} after reviewing them`);
    return;
  }
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.textContent = "Click again to revert";
    setTimeout(() => {
      btn.dataset.confirm = "";
      btn.textContent = "Revert";
    }, 4000);
    return;
  }
  void act("ui_revert_object", { path }, `reverted ${path} in CODESYS to the reviewed version`);
}

const workspace = new Workspace({
  needObject: (path) => void fetchObject(path),
  context,
  act,
  pickView,
  followChanged,
  review,
});

$("c-views").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("[data-view]")?.dataset.view as ViewName | undefined;
  if (v) pickView(v);
});
$("c-follow").addEventListener("click", () => {
  workspace.follow = !workspace.follow;
  persist("ws-follow", workspace.follow);
  followChanged();
});
$("c-view").addEventListener("click", (e) => {
  const rv = (e.target as HTMLElement).closest<HTMLElement>("[data-rv]");
  if (rv) review(rv.dataset.rv!, rv.closest<HTMLElement>("[data-path]")!.dataset.path!, rv);
});

$("c-hold").addEventListener("click", () => void act("ui_hold", { on: !model.state?.held }, model.state?.held ? "resumed Claude" : "paused Claude to drive the simulation themselves"));

// ---------------------------------------------------------------- server calls

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

async function fetchObject(path: string) {
  const r = await call<Omit<ObjData, "version">>("get_object", { path });
  if (!r) return;
  model.objects.set(path.toLowerCase(), { ...r, version: model.ws?.version ?? 0 });
  render();
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let polling = false;

/** Poll right away (after a user action), unless a poll is running. */
function pollSoon() {
  if (polling) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, 50);
}

async function poll() {
  if (stopped || polling) return;
  polling = true;
  try {
    await pollOnce();
  } finally {
    polling = false;
  }
  const s = model.state;
  const fast = s && (s.status === "running" || s.activity);
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, fast ? 300 : 1000);
}

async function pollOnce() {
  const s = await call<PanelState>("get_sim_state", panelId ? { panelId } : {});
  if (s) {
    if (!s.current) {
      stopped = true;
      clearTimeout(pollTimer);
      document.body.classList.add("superseded");
      return;
    }
    model.state = s;
    const newEvents = s.journalSeq > lastSeq;
    if (newEvents) {
      const e = await call<{ events: SimEvent[]; last: number }>("get_events", { since: lastSeq });
      if (e) {
        model.events = [...model.events, ...e.events].slice(-300);
        lastSeq = e.events.at(-1)?.seq ?? e.last;
      }
    }
    const busy = s.status === "running" || !!s.activity;
    if (busy || newEvents || s.trendEpoch !== model.trendEpoch || model.trend.length === 0) {
      const since = s.trendEpoch === model.trendEpoch ? (model.trend.at(-1)?.t ?? -1) : -1;
      const t = await call<{ epoch: number; points: TrendPoint[]; reset: boolean }>("get_trend", { epoch: model.trendEpoch, since });
      if (t) {
        if (t.reset || t.epoch !== model.trendEpoch) model.trend = [];
        model.trendEpoch = t.epoch;
        model.trend = [...model.trend, ...t.points].slice(-20000);
      }
    }
  }
  const w = await call<WsData & { unchanged?: boolean }>("get_workspace", model.ws?.tree ? { version: model.ws.version } : {});
  if (w && !w.unchanged) {
    const changed = model.ws?.version !== w.version;
    model.ws = w;
    if (changed && mode === "workspace") {
      // refetch the objects that are open; the rest refetch when opened
      for (const p of workspace.tabs) {
        const o = model.objects.get(p.toLowerCase());
        if (!o || o.version !== w.version) await fetchObject(p);
      }
    }
  }
  // What the current view needs.
  const v = currentView(workspace.follow);
  if (v === "code" && mode === "card") {
    const p = codePath();
    const o = p ? model.objects.get(p.toLowerCase()) : undefined;
    if (p && (!o || o.version !== model.ws?.version)) await fetchObject(p);
  }
  if (v === "review" && mode === "card") {
    // the counts and in-place diffs need every changed object and its reviewed version
    const need = reviewRows()
      .flatMap((r) => (r.mark === "D" ? [] : r.members))
      .filter((p) => model.objects.get(p.toLowerCase())?.version !== model.ws?.version)
      .slice(0, 20);
    for (const p of need) await fetchObject(p);
  }
  const key = (s?.experiments ?? []).map((e) => e.n).join(",");
  if (key !== runsKey && (v === "tuning" || mode === "card")) {
    const r = await call<{ runs: ExperimentRun[] }>("get_experiments");
    if (r) {
      views.runs = r.runs;
      runsKey = key;
    }
  }
  if (s && s.tuningVersion !== tuningKey && (v === "tuning" || mode === "card")) {
    const r = await call<{ version: number; loops: TuningLoop[] }>("get_tuning");
    if (r) {
      views.loops = r.loops;
      tuningKey = s.tuningVersion;
    }
  }
  if (mode === "workspace") {
    workspace.autoFollow();
    const paused = s?.status === "paused" && s.location && !s.location.harness;
    if (paused) {
      const l = await call<Locals>("get_locals");
      if (l) model.locals = l;
    } else model.locals = undefined;
    if ((s?.status === "running" || s?.status === "paused") && workspace.watch.length && workspace.insp === "watch") {
      const v = await call<{ values: typeof model.values }>("get_values", { names: workspace.watch });
      if (v) model.values = v.values;
    }
  }
  render();
}

function render() {
  const v = currentView(workspace.follow);
  if (v !== view) {
    view = v;
    if (mode === "workspace") workspace.applyView(v);
    else workspaceStale = true;
    if (mode === "workspace") return;
  }
  if (mode === "card") renderCard(v, workspace.follow);
  else workspace.render();
}

window.addEventListener("resize", () => render());

app
  .connect()
  .then(() => {
    applyContext(app.getHostContext());
    layout();
    void poll();
  })
  .catch((e: Error) => {
    $("card").classList.remove("hidden");
    $("c-statusText").textContent = "Not connected";
    $("c-activity").textContent = e.message;
  });
