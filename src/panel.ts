/**
 * The CODESYS panel: an MCP App (ui:// resource) plus the app-only tools it
 * polls. It shows the project tree, the code as Claude writes it, compile
 * problems and the changes to review.
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
import type { PanelState } from "./panel-types.js";
import type { ProjectCache } from "./codesys/cache.js";
import { diffObjects, REVIEW, snapshot, type ChangeStore, type SnapObject } from "./codesys/changes.js";
import type { Driver } from "./driver.js";
import type { HmiService } from "./hmi/service.js";

export const PANEL_URI = "ui://codesys/sim-panel.html";

/** The name the browser viewer's own connection uses; it isn't a card. */
export const VIEWER_CLIENT = "codesys-viewer";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The built single-file panel (dist/panel/sim-panel.html). */
export function panelHtml(): string {
  for (const p of [join(HERE, "panel", "sim-panel.html"), join(HERE, "..", "dist", "panel", "sim-panel.html")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:16px">The panel is not built. Run <code>npm run build</code>.</body>`;
}

/** Which panel is the newest; shared by all connections of this process. */
let latestPanel: string | undefined;

const json = (data: object) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> });

/** What the panel reads from the session. */
export interface PanelDeps {
  cache?: ProjectCache;
  changes?: ChangeStore;
  project: () => string | undefined;
  /** Which CODESYS, Scripting add-on and compiler the session uses. */
  versions?: () => string;
  /** CODESYS's own simulation, while it runs. */
  codesysSim?: () => PanelState["codesysSim"];
  /** "Pause Claude". */
  driver?: Driver;
  /** Revert an object in CODESYS to a checkpoint (the revert_object logic). */
  revert?: (path: string, to: string) => Promise<string>;
  /** The server log: how far a card got, since a client can accept the tool and draw nothing. */
  log?: (message: string) => void;
  /** HMI screens of the open project. */
  hmi?: HmiService;
}

export function registerPanel(server: McpServer, ws: PanelDeps = { project: () => undefined }): void {
  const clientName = () => server.server.getClientVersion()?.name ?? "the client";
  let pageRunning = false;

  registerAppResource(
    server,
    "CODESYS panel",
    PANEL_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Live view of the CODESYS project: tree, code, compile problems and changes to review." },
    async () => {
      ws.log?.(`card: ${clientName()} fetched the panel page`);
      return { contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: panelHtml(), _meta: { ui: { prefersBorder: true } } }] };
    },
  );

  const tools: RegisteredTool[] = [];

  // Separate from the `codesys` tool because MCP ties a panel to a tool's definition:
  // on `codesys` it would mount a new panel on every call. So it costs its own approval.
  // Listed for every client: Claude Desktop's Code tab draws the card without declaring MCP Apps.
  registerAppTool(
    server,
    "open_sim_panel",
    {
      description: "Show the live CODESYS panel to the user in this chat: the project tree, the code as you write it, compile problems and the changes to review. Read-only. Returns a text snapshot too.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    async () => {
      const panelId = randomUUID();
      latestPanel = panelId;
      ws.log?.(`card: ${clientName()} called open_sim_panel`);
      const project = ws.project();
      const sim = ws.codesysSim?.();
      const lines = [`Panel opened. ${project ? `Project: ${project}.` : "No project is open yet."}`];
      if (sim) lines.push(`CODESYS simulation: application ${sim.state}.`);
      // Some hosts show the model only structuredContent when it is present,
      // so the snapshot goes there too, not just in content.
      const text = lines.join("\n");
      return { content: [{ type: "text", text }], structuredContent: { panelId, snapshot: text } };
    },
  );

  const appOnly = { ui: { resourceUri: PANEL_URI, visibility: ["app" as const] } };

  tools.push(
    registerAppTool(
      server,
      "get_sim_state",
      {
        description: "Panel: state snapshot.",
        inputSchema: z.object({ panelId: z.string().optional() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ panelId }) => {
        if (!pageRunning && clientName() !== VIEWER_CLIENT) {
          pageRunning = true;
          ws.log?.(`card: the panel page is running in ${clientName()}`);
        }
        const codesysSim = ws.codesysSim?.();
        const state: PanelState = {
          current: !panelId || !latestPanel || panelId === latestPanel,
          ...(codesysSim ? { codesysSim } : {}),
          ...(ws.driver?.held ? { held: true, heldSince: ws.driver.since } : {}),
          ...(ws.driver?.phase ? { phase: { view: ws.driver.phase.view, tool: ws.driver.phase.tool, quietMs: Date.now() - (ws.driver.lastCallAt ?? ws.driver.phase.at) } } : {}),
        };
        return json(state);
      },
    ),
  );

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
          return {
            path: n.path,
            name: n.name,
            kind: n.kind,
            ...(n.sub ? { sub: n.sub } : {}),
            depth: n.depth,
            ...(n.st === false ? { st: false } : {}),
            ...(ch ? { change: ch === "added" ? "A" : "M" } : {}),
            ...(pr ? pr : {}),
          };
        });
        return json({
          version: cache.version,
          project: ws.project() ?? null,
          versions: ws.versions?.() || undefined,
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

  /** A user action from the panel; a failure is an answer, not a tool error. */
  const action = <S extends z.ZodObject>(name: string, description: string, schema: S, fn: (a: z.infer<S>) => Promise<string>) => {
    tools.push(
      registerAppTool(server, name, { description: `Panel (user action): ${description}`, inputSchema: schema, _meta: appOnly }, (async (a: z.infer<S>) => {
        try {
          return json({ ok: true, message: await fn(a) });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      }) as never),
    );
  };

  action("ui_hold", "pause or resume Claude (its tools that change the project or the simulation are held).", z.object({ on: z.boolean() }), async (a) => {
    if (!ws.driver) throw new Error("Pause Claude is not available.");
    ws.driver.hold(a.on);
    ws.cache?.bump();
    return a.on ? "paused Claude" : "resumed Claude";
  });
  action("ui_accept_object", "accept the current text of an object (and its children) as reviewed.", z.object({ path: z.string() }), async (a) => {
    const project = ws.project();
    if (!project || !ws.changes || !ws.cache?.nodes) throw new Error("No project is open.");
    const n = await ws.changes.accept(project, a.path, snapshot(ws.cache.nodes));
    baseline = undefined;
    ws.cache.bump();
    return `accepted the changes to ${a.path}${n > 1 ? ` and its ${n - 1} child object${n === 2 ? "" : "s"}` : ""}`;
  });
  action("ui_revert_object", "revert an object (and its children) in CODESYS to the reviewed text.", z.object({ path: z.string() }), async (a) => {
    if (!ws.revert) throw new Error("Revert is not available.");
    const r = await ws.revert(a.path, REVIEW);
    baseline = undefined;
    ws.cache?.bump();
    return r;
  });

  tools.push(
    registerAppTool(
      server,
      "get_hmi",
      {
        description: "Panel: the project's HMI screens, one screen's description and its live values from the simulation.",
        inputSchema: z.object({ screen: z.string().optional() }),
        annotations: { readOnlyHint: true },
        _meta: appOnly,
      },
      async ({ screen }) => {
        const hmi = ws.hmi;
        const all = hmi?.screens() ?? [];
        const s = hmi?.screen(screen) ?? all[0];
        const live = s && hmi ? await hmi.values(s).catch(() => ({ values: {}, errors: {} })) : { values: {}, errors: {} };
        return json({ screens: all.map((x) => ({ name: x.name, title: x.title })), ...(s ? { screen: s } : {}), values: live.values, sim: hmi?.sim() ?? {}, alarms: hmi?.page().alarms ?? [] });
      },
    ),
  );
  action("ui_hmi_write", "operate the HMI: write a value into CODESYS's simulation (only variables on an HMI screen).", z.object({ variable: z.string(), value: z.string() }), async (a) => {
    if (!ws.hmi) throw new Error("No HMI.");
    return ws.hmi.write(a.variable, a.value);
  });

  // Clients without MCP Apps support would show app-only tools to the model; hide them there.
  const prev = server.server.oninitialized;
  server.server.oninitialized = () => {
    prev?.();
    if (!getUiCapability(server.server.getClientCapabilities())) for (const t of tools) t.disable();
  };
}
