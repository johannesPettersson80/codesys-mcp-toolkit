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

const app = new App({ name: "codesys-workspace", version: "1.0.0" });

let panelId: string | undefined;
let stopped = false;
let lastSeq = 0;
let mode: "card" | "workspace" = "card";
let inlineExpanded = false;

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

let contextTimer: ReturnType<typeof setTimeout> | undefined;
function context(text: string) {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);
  }, 400);
}

const workspace = new Workspace({
  needObject: (path) => void fetchObject(path),
  context,
});

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
  if (mode === "workspace") workspace.render();
}

async function poll() {
  if (stopped) return;
  const s = await call<PanelState>("get_sim_state", panelId ? { panelId } : {});
  if (s) {
    if (!s.current) {
      stopped = true;
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
  const fast = s && (s.status === "running" || s.activity);
  setTimeout(poll, fast ? 300 : 1000);
}

function render() {
  if (mode === "card") renderCard();
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
