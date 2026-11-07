/**
 * The simulation panel: an MCP App (ui:// resource) plus the app-only tools
 * it polls. Read-only in this phase: it shows the code with the current line,
 * the plant (P&ID), I/O, trends, experiments and events.
 *
 * Every open_sim_panel call mounts a new panel in the host and older ones keep
 * running, so the server remembers the newest panel id and tells older panels
 * to stop polling (`current: false`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { getUiCapability, registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { SimController } from "./controller.js";
import type { PanelState } from "./panel-types.js";
import type { ProjectCache } from "../codesys/cache.js";
import { diffObjects, REVIEW, snapshot, type ChangeStore, type SnapObject } from "../codesys/changes.js";
import type { Driver } from "../driver.js";
import { parseDeclaration } from "../codesys/decl.js";

export const PANEL_URI = "ui://codesys/sim-panel.html";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The built single-file panel (dist/panel/sim-panel.html). */
export function panelHtml(): string {
  for (const p of [join(HERE, "..", "panel", "sim-panel.html"), join(HERE, "..", "..", "dist", "panel", "sim-panel.html")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:16px">The simulation panel is not built. Run <code>npm run build</code>.</body>`;
}

/** Which panel is the newest; shared by all connections of this process. */
let latestPanel: string | undefined;

const json = (data: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> });

/** What the workspace reads besides the simulation. */
export interface WorkspaceDeps {
  cache?: ProjectCache;
  changes?: ChangeStore;
  project: () => string | undefined;
  /** "Pause Claude". */
  driver?: Driver;
  /** Revert an object in CODESYS to a checkpoint (the revert_object logic). */
  revert?: (path: string, to: string) => Promise<string>;
  /** The browser viewer, opened by open_sim_panel. */
  viewer?: () => { url: string; open(force?: boolean): boolean } | undefined;
}

export function registerPanel(server: McpServer, sim: SimController, ws: WorkspaceDeps = { project: () => undefined }): void {
  registerAppResource(
    server,
    "CODESYS simulation panel",
    PANEL_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Live view of the truST simulation: code, plant, I/O, trends, experiments." },
    async () => ({ contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: panelHtml(), _meta: { ui: { prefersBorder: true } } }] }),
  );

  registerAppTool(
    server,
    "open_sim_panel",
    {
      description:
        "Show the live simulation panel to the user: code with the current line and breakpoints, the plant (P&ID), I/O values, trends, experiments and events. Read-only; drive the simulation with the other tools. Returns a text snapshot too.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    async () => {
      const panelId = randomUUID();
      latestPanel = panelId;
      const s = await sim.panelState();
      const lines = [
        `Panel opened. Simulation: ${s.status}${s.status === "running" || s.status === "paused" ? `, scan ${s.scan}, ${s.simTime.toFixed(2)} s simulated, ${s.timeScale}x` : ""}.`,
      ];
      if (s.location && !s.location.harness && s.location.obj) lines.push(`Stopped at ${s.location.obj} line ${s.location.line} (${s.location.reason}).`);
      for (const sig of s.signals) if (sig.value !== undefined) lines.push(`${sig.name} = ${sig.value}${sig.forced ? " (forced)" : ""}`);
      if (s.status === "no_project") lines.push("Open a CODESYS project, then sync_mirror and sim_start.");
      else if (s.status === "no_mirror") lines.push("Call sync_mirror and sim_start to start the simulation.");
      else if (s.status === "stopped") lines.push("Call sim_start to start the simulation.");
      // A chat that can't show MCP Apps gets the same panel in the browser instead.
      const v = ws.viewer?.();
      if (v && !getUiCapability(server.server.getClientCapabilities())) {
        v.open(true);
        lines.push(`This chat can't show the panel, so it opened in the user's browser: ${v.url} (if they don't see it, give them this link).`);
      }
      // Some hosts show the model only structuredContent when it is present,
      // so the snapshot goes there too, not just in content.
      const snapshot = lines.join("\n");
      return { content: [{ type: "text", text: snapshot }], structuredContent: { panelId, status: s.status, snapshot } };
    },
  );

  const appOnly = { ui: { resourceUri: PANEL_URI, visibility: ["app" as const] } };
  const tools: RegisteredTool[] = [];

  tools.push(
    registerAppTool(
      server,
      "get_sim_state",
      {
        description: "Panel: simulation state snapshot.",
        inputSchema: z.object({ panelId: z.string().optional() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ panelId }) => {
        const s = await sim.panelState();
        const state: PanelState = {
          ...s,
          current: !panelId || !latestPanel || panelId === latestPanel,
          ...(ws.driver?.held ? { held: true, heldSince: ws.driver.since } : {}),
          ...(ws.driver?.phase ? { phase: { view: ws.driver.phase.view, tool: ws.driver.phase.tool, quietMs: Date.now() - (ws.driver.lastCallAt ?? ws.driver.phase.at) } } : {}),
        };
        return json(state);
      },
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_events",
      {
        description: "Panel: simulation events after a sequence number.",
        inputSchema: z.object({ since: z.number().int().min(0) }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ since }) => json({ events: sim.journal.since(since, 200), last: sim.journal.last }),
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_source",
      {
        description: "Panel: the mirror source of an object, with CODESYS line numbers.",
        inputSchema: z.object({ obj: z.string().optional() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ obj }) => json({ source: (await sim.sourceView(obj)) ?? null }),
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_trend",
      {
        description: "Panel: trend samples after a simulated time.",
        inputSchema: z.object({ epoch: z.number().int(), since: z.number() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ epoch, since }) => json(sim.trend(epoch, since)),
    ),
  );

  // ---- workspace: project tree, objects, inspector

  let baseline: { project: string; objects: Map<string, SnapObject> } | undefined;
  const sessionBase = async (): Promise<Map<string, SnapObject> | undefined> => {
    const project = ws.project();
    if (!project || !ws.changes) return undefined;
    if (baseline?.project !== project) {
      const cp = await ws.changes.review(project);
      if (!cp) return undefined;
      baseline = { project, objects: new Map(cp.objects.map((o) => [o.path.toLowerCase(), o] as const)) };
    }
    return baseline.objects;
  };

  tools.push(
    registerAppTool(
      server,
      "get_workspace",
      {
        description: "Panel: the project tree with badges (changed since session start, compile errors), the last compile and what Claude touched last. Answers {unchanged} when version matches.",
        inputSchema: z.object({ version: z.number().int().optional() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ version }) => {
        const cache = ws.cache;
        if (!cache) return json({ version: 0, tree: null, reason: "no cache" });
        if (version !== undefined && version === cache.version && cache.nodes) return json({ unchanged: true, version: cache.version });
        if (!cache.nodes) return json({ version: cache.version, project: ws.project() ?? null, tree: null });
        const base = await sessionBase();
        const changes = base ? diffObjects([...base.values()], snapshot(cache.nodes)) : [];
        const changeOf = new Map(changes.map((c) => [c.path.toLowerCase(), c.change] as const));
        const problems = new Map<string, { errors: number; warnings: number }>();
        for (const m of cache.compile?.messages ?? []) {
          if (!m.object) continue;
          const k = m.object.replace(/^\/+/, "").toLowerCase();
          const p = problems.get(k) ?? { errors: 0, warnings: 0 };
          if (m.severity === "error") p.errors++;
          else p.warnings++;
          problems.set(k, p);
        }
        const tree = cache.nodes.map((n) => {
          const k = n.path.toLowerCase();
          const ch = changeOf.get(k);
          const pr = problems.get(k);
          const attrs = parseDeclaration(n.declaration).header.attributes;
          return {
            path: n.path,
            name: n.name,
            kind: n.kind,
            ...(n.sub ? { sub: n.sub } : {}),
            depth: n.depth,
            ...(n.st === false ? { st: false } : {}),
            ...(ch ? { change: ch === "added" ? "A" : "M" } : {}),
            ...(pr ? pr : {}),
            ...(attrs.some((a) => a.toLowerCase() === "test") ? { test: true } : {}),
          };
        });
        return json({
          version: cache.version,
          project: ws.project() ?? null,
          tree,
          removed: changes.filter((c) => c.change === "removed").map((c) => c.path),
          changeCount: changes.length,
          compile: cache.compile ?? null,
          focus: cache.focus ?? null,
        });
      },
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_object",
      {
        description: "Panel: one object's CODESYS text, and its text at session start for the diff view.",
        inputSchema: z.object({ path: z.string() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ path }) => {
        const n = ws.cache?.get(path);
        const base = (await sessionBase())?.get(path.toLowerCase());
        if (!n && !base) return json({ object: null });
        return json({
          object: n ? { path: n.path, name: n.name, kind: n.kind, sub: n.sub ?? null, st: n.st ?? null, declaration: n.declaration ?? null, implementation: n.implementation ?? null } : null,
          base: base ? { declaration: base.declaration ?? null, implementation: base.implementation ?? null } : null,
        });
      },
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_experiments",
      {
        description: "Panel: experiment runs with their step responses (Tuning view).",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async () => json({ runs: sim.experimentRuns() }),
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_locals",
      {
        description: "Panel: locals and call stack while the simulation is paused in user code.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async () => json(await sim.panelLocals().catch(() => ({ paused: false, stack: [], locals: [] }))),
    ),
  );

  tools.push(
    registerAppTool(
      server,
      "get_values",
      {
        description: "Panel: current values of watched variables.",
        inputSchema: z.object({ names: z.array(z.string()).max(50) }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ names }) => json({ values: await sim.panelValues(names).catch(() => ({})) }),
    ),
  );

  // ---- user actions from the panel (Phase 7)

  /**
   * A user action: journaled as the user's (the model sees it in events and
   * gets told through model context by the panel). Run controls are refused
   * while Claude is in the middle of a run.
   */
  const action = <S extends z.ZodObject>(name: string, description: string, schema: S, fn: (a: z.infer<S>) => Promise<string>, o: { whileBusy?: boolean } = {}) => {
    tools.push(
      registerAppTool(server, name, { description: `Panel (user action): ${description}`, inputSchema: schema, _meta: appOnly }, (async (a: z.infer<S>) => {
        try {
          if (!o.whileBusy && sim.busyWith) return json({ ok: false, message: `Claude is busy (${sim.busyWith}). Wait until it finishes, or use Pause Claude.` });
          const message = await sim.journal.asUser(() => fn(a));
          return json({ ok: true, message });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      }) as never),
    );
  };
  const note = async (text: string) => {
    await sim.journal.asUser(async () => void sim.journal.add("user", text));
    return text;
  };

  action("ui_set_breakpoint", "set a breakpoint on an implementation line.", z.object({ path: z.string(), line: z.number().int().min(1), condition: z.string().optional() }), (a) => sim.setBreakpoint(a.path, a.line, a.condition), { whileBusy: true });
  action("ui_clear_breakpoint", "clear a breakpoint.", z.object({ id: z.number().int() }), (a) => sim.clearBreakpoint({ id: a.id }), { whileBusy: true });
  action("ui_continue", "run until a breakpoint (in the background; Pause stops it).", z.object({}), async () => sim.continueInBackground());
  action("ui_pause", "pause the simulation.", z.object({}), () => sim.pauseNow(), { whileBusy: true });
  action("ui_step", "step over, into or out of the current statement.", z.object({ kind: z.enum(["step_over", "step_in", "step_out"]) }), (a) => sim.step(a.kind));
  action("ui_run_for", "run for some simulated seconds.", z.object({ seconds: z.number().positive().max(3600) }), (a) => sim.runFor(a.seconds));
  action("ui_force_var", "force a variable.", z.object({ name: z.string(), value: z.string() }), (a) => sim.forceVar(a.name, a.value));
  action("ui_unforce_var", "release a forced variable.", z.object({ name: z.string() }), (a) => sim.unforceVar(a.name));
  action("ui_write_var", "write a value once.", z.object({ name: z.string(), value: z.string() }), (a) => sim.writeVar(a.name, a.value));
  action("ui_set_plant_params", "change plant parameters (restarts the simulation).", z.object({ plant: z.string(), params: z.record(z.string(), z.number()) }), (a) => sim.setPlantParams(a.plant, a.params));
  action(
    "ui_hold",
    "pause or resume Claude (its tools that change the project or simulation are held).",
    z.object({ on: z.boolean() }),
    async (a) => {
      if (!ws.driver) throw new Error("Pause Claude is not available.");
      ws.driver.hold(a.on);
      ws.cache?.bump();
      return note(a.on ? "paused Claude and took over the simulation" : "resumed Claude");
    },
    { whileBusy: true },
  );
  action(
    "ui_accept_object",
    "accept the current text of an object (and its children) as reviewed.",
    z.object({ path: z.string() }),
    async (a) => {
      const project = ws.project();
      if (!project || !ws.changes || !ws.cache?.nodes) throw new Error("No project is open.");
      const n = await ws.changes.accept(project, a.path, snapshot(ws.cache.nodes));
      baseline = undefined;
      ws.cache.bump();
      return note(`accepted the changes to ${a.path}${n > 1 ? ` and its ${n - 1} child object${n === 2 ? "" : "s"}` : ""}`);
    },
    { whileBusy: true },
  );
  action(
    "ui_revert_object",
    "revert an object (and its children) in CODESYS to the reviewed text.",
    z.object({ path: z.string() }),
    async (a) => {
      if (!ws.revert) throw new Error("Revert is not available.");
      const r = await ws.revert(a.path, REVIEW);
      baseline = undefined;
      ws.cache?.bump();
      await note(`reverted ${a.path} in CODESYS to the reviewed version`);
      return r;
    },
    { whileBusy: true },
  );

  // Clients without MCP Apps support would show app-only tools to the model; hide them there.
  const prev = server.server.oninitialized;
  server.server.oninitialized = () => {
    prev?.();
    if (!getUiCapability(server.server.getClientCapabilities())) for (const t of tools) t.disable();
  };
}
