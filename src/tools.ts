/** Model-facing MCP tools for CODESYS (ST only, offline only). */
import { copyFile } from "node:fs/promises";
import { annotationsFor, type ToolAnnotations } from "./annotations.js";
import { getUiCapability } from "@modelcontextprotocol/ext-apps/server";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BridgeError, type CodesysBridge } from "./bridge/bridge.js";
import type { SimController } from "./sim/controller.js";
import { buildOutline, ioList, type OutlineTask } from "./codesys/outline.js";
import { diffObjects, formatDiff, lineDiff, snapshot, type ChangeStore, type SnapObject } from "./codesys/changes.js";
import { parseDeclaration } from "./codesys/decl.js";
import type { ProjectCache } from "./codesys/cache.js";
import { heldMessage, type Driver } from "./driver.js";
import { checkDeclaration, kindLabel, normalizeText, type CreateKind, type TreeNode } from "./codesys/st.js";

export interface AppContext {
  bridge: CodesysBridge;
  /** Save the project after every change (default true, like v1). */
  autosave: boolean;
  /** Base folder for relative project paths. */
  workspace: string;
  /** CODESYS Templates folder (holds Standard.project). */
  templatesDir?: string;
  /** Description of the CODESYS in use, for status. */
  codesys?: { exe: string; profile: string; label: string };
  /** How long a tool call waits for CODESYS to finish starting. */
  startWaitMs: number;
  /** Last project opened through these tools (status never queries CODESYS). */
  project?: { path: string; application?: string };
  /** The truST simulation (absent when disabled). */
  sim?: SimController;
  /** Checkpoints and change tracking (absent when disabled). */
  changes?: ChangeStore;
  /** What the server knows about the open project, for the workspace panel. */
  cache?: ProjectCache;
  /** Whether the user has paused Claude in the panel. */
  driver?: Driver;
  /** The browser viewer (the panel in a normal browser window). */
  viewer?: { url: string; open(force?: boolean): boolean };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function run(ctx: AppContext, fn: () => Promise<string>): Promise<ToolResult> {
  try {
    if (!(await ctx.bridge.waitReady(ctx.startWaitMs))) {
      const h = ctx.bridge.health();
      const secs = h.startedAt ? Math.round((Date.now() - Date.parse(h.startedAt)) / 1000) : 0;
      return text(
        `CODESYS is still starting (${secs}s so far; a cold start takes 1-3 minutes). Call the tool again shortly, or check codesys_status.`,
        true,
      );
    }
    return text(await fn());
  } catch (e) {
    if (e instanceof BridgeError) return text(`${e.code}: ${e.message}`, true);
    return text(`error: ${(e as Error).message}`, true);
  }
}

const pathArg = z.string().describe("Object path relative to the application, e.g. 'PLC_PRG', 'FB_Pump/Start', 'FB_Pump/Speed/Get'. Prefix '/' for a path from the project root.");

function absPath(ctx: AppContext, p: string): string {
  return isAbsolute(p) ? p : resolvePath(ctx.workspace, p);
}

function formatObject(o: TreeNode & { error?: string }): string {
  if (o.error) return `=== ${o.path} ===\nerror: ${o.error}`;
  const parts = [`=== ${o.path} (${kindLabel(o)}) ===`];
  if (o.declaration !== undefined) parts.push("--- declaration ---", normalizeText(o.declaration)!.replace(/\n+$/, ""));
  if (o.implementation !== undefined) parts.push("--- implementation ---", normalizeText(o.implementation)!.replace(/\n+$/, ""));
  else if (o.st === false) parts.push("--- implementation ---", "(graphical body: SFC/CFC/LD/FBD; not editable as ST)");
  return parts.join("\n");
}

const CREATE_TO_NODE: Record<CreateKind, { kind: TreeNode["kind"]; sub?: string }> = {
  program: { kind: "pou", sub: "program" },
  function_block: { kind: "pou", sub: "function_block" },
  function: { kind: "pou", sub: "function" },
  method: { kind: "method" },
  property: { kind: "property" },
  action: { kind: "action" },
  interface: { kind: "interface" },
  dut: { kind: "dut" },
  gvl: { kind: "gvl" },
  folder: { kind: "folder" },
};

interface BuildMessage {
  category: string;
  severity: string;
  text: string;
  prefix?: string | null;
  number?: number | null;
  object?: string | null;
  position?: string | null;
}

export function formatBuild(messages: BuildMessage[]): { text: string; errors: number } {
  const isErr = (m: BuildMessage) => /error/i.test(m.severity);
  const isWarn = (m: BuildMessage) => /warning/i.test(m.severity);
  const errs = messages.filter(isErr);
  const warns = messages.filter(isWarn);
  const line = (m: BuildMessage) => {
    const code = m.prefix ? `${m.prefix}${m.number ?? ""}` : "";
    const where = m.object ? `${m.object}${m.position ? ` (${m.position})` : ""}` : "";
    return `${isErr(m) ? "ERROR" : "WARNING"}${code ? " " + code : ""}${where ? " " + where : ""}: ${m.text}`;
  };
  const out = [`Build: ${errs.length} error(s), ${warns.length} warning(s).`];
  for (const m of [...errs, ...warns]) out.push(line(m));
  if (!errs.length) out.push("Note: CODESYS only compiles POUs reachable from a task; unreferenced POUs are not checked.");
  return { text: out.join("\n"), errors: errs.length };
}

export function registerTools(server: McpServer, ctx: AppContext): void {
  const b = ctx.bridge;
  /** Tools that change the project are held while the user has paused Claude (panel). */
  const HELD = new Set(["write_object", "create_object", "delete_object", "rename_object", "revert_object", "add_library", "create_project", "open_project", "close_project"]);
  const reg = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    server.registerTool(
      name,
      { ...(config as object), annotations: annotationsFor(name, (config as { annotations?: ToolAnnotations }).annotations) } as never,
      (async (...a: unknown[]) => {
        if (HELD.has(name) && ctx.driver?.held) return text(heldMessage(ctx.driver, name), true);
        ctx.driver?.note(name); // the panel picks its view from what Claude does
        return cb(...a);
      }) as never,
    )) as unknown as McpServer["registerTool"];
  const cache = ctx.cache;
  /** Export all ST (and keep the workspace cache current). */
  const exportNodes = async (): Promise<TreeNode[]> => {
    const nodes = (await b.call<{ nodes: TreeNode[] }>("export", {}, { timeoutMs: 120_000 })).nodes;
    cache?.setAll(nodes);
    return nodes;
  };
  /** Re-read one object into the cache after a change (best effort). */
  const refresh = async (path: string, action: "write" | "create" | "revert") => {
    if (!cache) return;
    try {
      const o = (await b.call<{ objects: (TreeNode & { error?: string })[] }>("objects.read", { paths: [path] })).objects[0];
      if (o && !o.error) cache.upsert(o);
    } catch {
      /* the cache is best effort */
    }
    cache.touch(path, action);
  };
  /**
   * After opening a project: fill the cache with one export, and take the
   * session-start checkpoint from it the first time in this process.
   */
  const sessionStart = async (project: string): Promise<string> => {
    cache?.reset(project);
    // Where the chat can show MCP Apps the user watches in the panel (open_sim_panel);
    // otherwise the same workspace opens in their browser.
    const inChat = !!getUiCapability(server.server.getClientCapabilities());
    const shown = inChat
      ? " Call open_sim_panel now so the user can watch the project tree and the code as you write it."
      : ctx.viewer
        ? ctx.viewer.open()
          ? ` The live CODESYS workspace opened in the user's browser (${ctx.viewer.url}): it shows the project tree and the code as you write it.`
          : ` Live CODESYS workspace for the user: ${ctx.viewer.url}`
        : "";
    if (!cache && !ctx.changes) return shown;
    let nodes: TreeNode[];
    try {
      nodes = await exportNodes();
    } catch {
      return shown;
    }
    if (!ctx.changes) return shown;
    const taken = await ctx.changes.sessionStart(project, async () => nodes);
    return (taken ? " Checkpoint 'session-start' saved (get_changes shows what changes from here)." : "") + shown;
  };
  const save = () => ({ save: ctx.autosave });
  const savedNote = (r: { saved?: boolean }) => (r.saved ? " Project saved." : ctx.autosave ? "" : " (not saved; call save_project)");

  reg(
    "codesys_status",
    {
      description: "Show the CODESYS connection state, installation and open project. Never waits on CODESYS, so it is safe while CODESYS starts or is busy.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const h = b.health();
      const lines = [
        `CODESYS: ${ctx.codesys ? `${ctx.codesys.label} (profile "${ctx.codesys.profile}")` : "unknown"}`,
        `Bridge: ${h.state} / ${h.verdict}${h.pid ? `, pid ${h.pid}` : ""}${h.readyAfterMs ? `, started in ${Math.round(h.readyAfterMs / 1000)}s` : ""}, ${h.calls} call(s), ${h.restarts} restart(s)`,
      ];
      if (h.heartbeat) lines.push(`Watcher: ${h.heartbeat.state}${h.heartbeat.op ? ` (${h.heartbeat.op})` : ""}, heartbeat ${Math.round(h.heartbeat.ageMs / 1000)}s ago`);
      if (h.lastError) lines.push(`Last error: ${h.lastError}`);
      lines.push(ctx.project ? `Project (last opened): ${ctx.project.path}, application ${ctx.project.application ?? "none"}` : "Project: none opened in this session");
      if (h.sessionDir) lines.push(`Session folder: ${h.sessionDir}`);
      return text(lines.join("\n"));
    },
  );

  reg(
    "open_project",
    {
      description: "Open a CODESYS .project file. All other tools work on the open project. Refuses to drop unsaved changes in a different open project unless discardChanges is true. Projects are opened without version upgrades.",
      inputSchema: z.object({
        path: z.string().describe("Path to the .project file (absolute, or relative to the workspace)"),
        discardChanges: z.boolean().optional(),
      }),
    },
    async ({ path, discardChanges }) =>
      run(ctx, async () => {
        const r = await b.call<{ path: string; application?: string; reused?: boolean }>(
          "project.open",
          { path: absPath(ctx, path), discard_changes: !!discardChanges },
          { timeoutMs: 300_000 },
        );
        ctx.project = { path: r.path, application: r.application };
        const cp = await sessionStart(r.path);
        return `${r.reused ? "Already open" : "Opened"}: ${r.path}. Active application: ${r.application ?? "none"}.${cp}`;
      }),
  );

  reg(
    "create_project",
    {
      description: "Create a new CODESYS project and open it. template 'standard' copies CODESYS's Standard.project (device + application + PLC_PRG); 'empty' creates an empty project; any other value is a path to a template .project file.",
      inputSchema: z.object({
        path: z.string().describe("New .project file path"),
        template: z.string().optional().describe("'standard' (default), 'empty', or a template file path"),
      }),
    },
    async ({ path, template }) =>
      run(ctx, async () => {
        const target = absPath(ctx, path);
        if (existsSync(target)) throw new Error(`File already exists: ${target}`);
        const t = template ?? "standard";
        if (t === "empty") {
          const r = await b.call<{ path: string; application?: string }>("project.create_empty", { path: target }, { timeoutMs: 120_000 });
          ctx.project = { path: r.path, application: r.application };
          await sessionStart(r.path);
          return `Created empty project ${r.path}.`;
        }
        const src = t === "standard" ? (ctx.templatesDir ? join(ctx.templatesDir, "Standard.project") : "") : absPath(ctx, t);
        if (!src || !existsSync(src)) throw new Error(`Template not found: ${src || "CODESYS Templates folder unknown"}`);
        await copyFile(src, target);
        const r = await b.call<{ path: string; application?: string }>("project.open", { path: target }, { timeoutMs: 300_000 });
        ctx.project = { path: r.path, application: r.application };
        await sessionStart(r.path);
        return `Created ${r.path} from ${t === "standard" ? "Standard.project" : src}. Active application: ${r.application ?? "none"}. Run compile to check that its libraries are installed.`;
      }),
  );

  reg(
    "save_project",
    { description: "Save the open project.", inputSchema: z.object({}) },
    async () => run(ctx, async () => `Saved ${(await b.call<{ path: string }>("project.save")).path}.`),
  );

  reg(
    "close_project",
    {
      description: "Close the open project. Refuses when there are unsaved changes unless discardChanges is true.",
      inputSchema: z.object({ discardChanges: z.boolean().optional() }),
    },
    async ({ discardChanges }) =>
      run(ctx, async () => {
        const r = await b.call<{ closed: boolean }>("project.close", { discard_changes: !!discardChanges });
        ctx.project = undefined;
        cache?.reset();
        return r.closed ? "Project closed." : "No project was open.";
      }),
  );

  reg(
    "get_project_tree",
    {
      description: "List the objects of the open project's application (or a sub-tree) with their kinds. Objects with graphical bodies (SFC/CFC/LD/FBD) are marked [non-ST]; v2 reads and edits ST only.",
      inputSchema: z.object({
        root: pathArg.optional().describe("Sub-tree to list (default: the active application)"),
        wholeProject: z.boolean().optional().describe("List from the project root (devices, pool) instead of the application"),
        maxDepth: z.number().int().min(0).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ root, wholeProject, maxDepth }) =>
      run(ctx, async () => {
        const r = await b.call<{ nodes: TreeNode[]; application?: string }>("tree", { root, whole_project: !!wholeProject, max_depth: maxDepth ?? null });
        const head = root ? `Tree under ${root}:` : wholeProject ? "Project tree:" : `Application ${r.application ?? "?"} (paths are relative to it):`;
        const lines = r.nodes.map((n) => `${"  ".repeat(n.depth)}${n.name}  [${kindLabel(n)}]${n.st === false ? " [non-ST]" : ""}`);
        return [head, ...(lines.length ? lines : ["(empty)"])].join("\n");
      }),
  );

  reg(
    "read_objects",
    {
      description: "Read the declaration and implementation text of ST objects: POUs, methods, property accessors (path 'FB/Prop/Get'), actions, interfaces, DUTs and GVLs.",
      inputSchema: z.object({ paths: z.array(pathArg).min(1).max(50) }),
      annotations: { readOnlyHint: true },
    },
    async ({ paths }) =>
      run(ctx, async () => {
        const r = await b.call<{ objects: (TreeNode & { error?: string })[] }>("objects.read", { paths });
        if (cache) {
          for (const o of r.objects) if (!o.error) cache.upsert(o);
          const last = r.objects.filter((o) => !o.error).at(-1);
          if (last) cache.touch(last.path, "read");
        }
        return r.objects.map(formatObject).join("\n\n");
      }),
  );

  reg(
    "write_object",
    {
      description: "Replace the declaration and/or implementation text of an ST object. The declaration must keep the object's header (e.g. 'FUNCTION_BLOCK FB_Pump', 'METHOD Start : BOOL'); a GVL declaration starts with VAR_GLOBAL; property accessors hold only VAR blocks.",
      inputSchema: z.object({
        path: pathArg,
        declaration: z.string().optional(),
        implementation: z.string().optional(),
        skipHeaderCheck: z.boolean().optional().describe("Skip the header check (only if you know CODESYS accepts the change)"),
      }),
    },
    async ({ path, declaration, implementation, skipHeaderCheck }) =>
      run(ctx, async () => {
        if (declaration === undefined && implementation === undefined) throw new Error("Give declaration and/or implementation.");
        if (declaration !== undefined && !skipHeaderCheck) {
          const cur = (await b.call<{ objects: (TreeNode & { error?: string })[] }>("objects.read", { paths: [path] })).objects[0];
          if (!cur || cur.error) throw new Error(cur?.error ?? `No object ${path}`);
          const problem = checkDeclaration(cur.kind, cur.sub, cur.name, declaration);
          if (problem) throw new Error(problem);
        }
        const r = await b.call<{ path: string; kind: string; saved?: boolean }>("object.write", { path, declaration, implementation, ...save() });
        await refresh(r.path, "write");
        return `Updated ${r.path} (${[declaration !== undefined && "declaration", implementation !== undefined && "implementation"].filter(Boolean).join(" + ")}).${savedNote(r)}`;
      }),
  );

  reg(
    "create_object",
    {
      description:
        "Create an ST object. kind: program | function_block | function (needs returnType) | method (under a POU or interface) | property (needs returnType) | action | interface | dut (dutType struct|enum|union|alias) | gvl | folder. Optionally set its declaration/implementation in the same call.",
      inputSchema: z.object({
        parent: pathArg.optional().describe("Parent object path (default: the application). Methods/properties/actions go under their POU."),
        kind: z.enum(["program", "function_block", "function", "method", "property", "action", "interface", "dut", "gvl", "folder"]),
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an IEC identifier"),
        returnType: z.string().optional(),
        dutType: z.enum(["struct", "enum", "union", "alias"]).optional(),
        baseInterfaces: z.string().optional().describe("Interfaces to extend, comma separated (interfaces only)"),
        declaration: z.string().optional(),
        implementation: z.string().optional(),
      }),
    },
    async (a) =>
      run(ctx, async () => {
        if (a.declaration !== undefined) {
          const n = CREATE_TO_NODE[a.kind];
          const problem = checkDeclaration(n.kind, n.sub, a.name, a.declaration);
          if (problem) throw new Error(problem);
        }
        const r = await b.call<{ path: string; kind: string; saved?: boolean }>("object.create", {
          parent: a.parent,
          kind: a.kind,
          name: a.name,
          return_type: a.returnType,
          dut_type: a.dutType,
          base_interfaces: a.baseInterfaces,
          declaration: a.declaration,
          implementation: a.implementation,
          ...save(),
        });
        await refresh(r.path, "create");
        return `Created ${a.kind} ${r.path}.${savedNote(r)}`;
      }),
  );

  reg(
    "delete_object",
    { description: "Delete an object (and its children).", inputSchema: z.object({ path: pathArg }), annotations: { destructiveHint: true } },
    async ({ path }) =>
      run(ctx, async () => {
        const r = await b.call<{ path: string; saved?: boolean }>("object.delete", { path, ...save() });
        cache?.remove(r.path);
        cache?.touch(r.path, "delete");
        return `Deleted ${r.path}.${savedNote(r)}`;
      }),
  );

  reg(
    "rename_object",
    {
      description: "Rename an object. References in other code are NOT updated; search_code for the old name afterwards.",
      inputSchema: z.object({ path: pathArg, newName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
    },
    async ({ path, newName }) =>
      run(ctx, async () => {
        const r = await b.call<{ path: string; saved?: boolean }>("object.rename", { path, new_name: newName, ...save() });
        cache?.rename(path.replace(/^\/+/, ""), newName);
        cache?.touch(r.path, "rename");
        return `Renamed to ${r.path}.${savedNote(r)}`;
      }),
  );

  reg(
    "search_code",
    {
      description: "Search all ST text (declarations and implementations) of the application. Returns path, part and line for each hit.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ pattern, regex, caseSensitive, maxResults }) =>
      run(ctx, async () => {
        const re = new RegExp(regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
        const r = { nodes: await exportNodes() };
        const hits: string[] = [];
        const limit = maxResults ?? 50;
        let total = 0;
        for (const n of r.nodes) {
          for (const [part, body] of [["decl", n.declaration], ["impl", n.implementation]] as const) {
            if (!body) continue;
            normalizeText(body)!.split("\n").forEach((l, i) => {
              if (re.test(l)) {
                total++;
                if (hits.length < limit) hits.push(`${n.path} [${part}]:${i + 1}: ${l.trim().slice(0, 200)}`);
              }
            });
          }
        }
        if (!total) return `No matches for ${regex ? "/" + pattern + "/" : JSON.stringify(pattern)}.`;
        return [`${total} match(es)${total > hits.length ? `, showing ${hits.length}` : ""}:`, ...hits].join("\n");
      }),
  );

  reg(
    "compile",
    {
      description: "Build the active application and return errors and warnings with object and line. CODESYS only compiles POUs reachable from a task.",
      inputSchema: z.object({}),
    },
    async () =>
      run(ctx, async () => {
        const r = await b.call<{ messages: BuildMessage[] }>("build", {}, { timeoutMs: 600_000 });
        const f = formatBuild(r.messages);
        if (cache) {
          const counted = r.messages.filter((m) => /error|warning/i.test(m.severity));
          cache.setCompile({
            at: new Date().toISOString(),
            errors: f.errors,
            warnings: counted.length - f.errors,
            messages: counted.map((m) => ({ severity: /error/i.test(m.severity) ? "error" : "warning", text: m.text, object: m.object, position: m.position, ...(m.prefix ? { code: `${m.prefix}${m.number ?? ""}` } : {}) })),
          });
        }
        return f.text;
      }),
  );

  reg(
    "list_libraries",
    { description: "List the libraries referenced by the application's Library Manager.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () =>
      run(ctx, async () => {
        const r = await b.call<{ libraries: { name: string; is_placeholder?: boolean; namespace?: string; effective_resolution?: string }[] }>("libraries.list");
        if (!r.libraries.length) return "No libraries referenced.";
        return r.libraries
          .map((l) => `${l.name}${l.is_placeholder ? " (placeholder)" : ""}${l.namespace ? `, namespace ${l.namespace}` : ""}${l.effective_resolution ? ` -> ${l.effective_resolution}` : ""}`)
          .join("\n");
      }),
  );

  reg(
    "add_library",
    {
      description: "Add a library reference by its full name, e.g. 'Standard, * (System)' or 'Util, 3.5.17.0 (System)'. The library must be installed in the CODESYS library repository.",
      inputSchema: z.object({ name: z.string().min(1) }),
    },
    async ({ name }) =>
      run(ctx, async () => {
        const r = await b.call<{ added: string; saved?: boolean }>("libraries.add", { name, ...save() });
        return `Added library ${r.added}.${savedNote(r)}`;
      }),
  );

  reg(
    "list_tasks",
    { description: "List the application's tasks with interval, priority and the POUs each one calls.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () =>
      run(ctx, async () => {
        const r = await b.call<{ tasks: { name: string; interval?: string; interval_unit?: string; priority?: string; kind?: string; pous: string[] }[] }>("tasks.list");
        if (!r.tasks.length) return "No tasks found.";
        return r.tasks
          .map((t) => `${t.name}: ${t.kind ?? "?"}${t.interval ? `, interval ${t.interval}${t.interval_unit && !/[a-z]/i.test(t.interval) ? " " + t.interval_unit : ""}` : ""}${t.priority ? `, priority ${t.priority}` : ""}; calls ${t.pous.join(", ") || "nothing"}`)
          .join("\n");
      }),
  );

  reg(
    "get_outline",
    {
      description:
        "Outline of the project without reading every object: tasks and what they run, then each POU with its interface (inputs, outputs, methods, properties, actions), interfaces, DUTs (enum members, struct fields), GVLs and tests. Pass path for one object in detail (all variables with types, initial values, AT addresses and comments; method signatures) or for one folder.",
      inputSchema: z.object({
        path: pathArg.optional().describe("An object (details) or a folder (its overview). Omit for the whole application."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ path }) =>
      run(ctx, async () => {
        const [e, t] = [{ nodes: await exportNodes() }, await b.call<{ tasks: OutlineTask[] }>("tasks.list")];
        return buildOutline(e.nodes, t.tasks, { path });
      }),
  );

  reg(
    "get_io_list",
    {
      description:
        "Variables mapped to I/O (AT %I, %Q, %M addresses, including the %I* / %Q* placeholders that the device tree maps), with type, owner (GVL or POU) and comment. Filter by text in the name, address or comment.",
      inputSchema: z.object({ filter: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ filter }) =>
      run(ctx, async () => {
        const e = { nodes: await exportNodes() };
        let io = ioList(e.nodes);
        if (filter) {
          const f = filter.toLowerCase();
          io = io.filter((x) => `${x.owner}.${x.name} ${x.at} ${x.comment ?? ""}`.toLowerCase().includes(f));
        }
        if (!io.length) return filter ? `No I/O variables match '${filter}'.` : "No variables with AT addresses in the project.";
        const group = (d: string, label: string) => {
          const xs = io.filter((x) => x.direction === d);
          return xs.length ? [`${label} (${xs.length}):`, ...xs.map((x) => `  ${x.at.padEnd(9)} ${x.owner}.${x.name} : ${x.type}${x.comment ? ` // ${x.comment}` : ""}`)] : [];
        };
        const placeholders = io.filter((x) => x.placeholder).length;
        return [
          ...group("input", "Inputs"),
          ...group("output", "Outputs"),
          ...group("memory", "Memory"),
          ...(placeholders ? [`${placeholders} placeholder(s) (%I* / %Q*): their addresses come from the device tree's I/O mapping, which isn't read yet.`] : []),
        ].join("\n");
      }),
  );

  // ---------------------------------------------------------------- libraries

  type LibApi = { library: string; path: string; title?: string; version?: string; company?: string; compiled?: boolean; nodes: TreeNode[] };
  const libCache = new Map<string, LibApi>();
  reg(
    "get_library_api",
    {
      description:
        "The real interface of a referenced library's function blocks, functions, DUTs and GVLs (inputs, outputs, methods, types), read from the installed library, so calls use the right parameters. Pass symbol for one object in detail. Works for source libraries (.library); compiled libraries (.compiled-library) carry no readable declarations.",
      inputSchema: z.object({
        name: z.string().describe("Library as listed by list_libraries, e.g. 'Util' or 'Util, * (System)'"),
        symbol: z.string().optional().describe("One object in the library, e.g. 'BLINK'"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ name, symbol }) =>
      run(ctx, async () => {
        const key = name.toLowerCase();
        let lib = libCache.get(key);
        if (!lib) {
          lib = await b.call<LibApi>("library.api", { name }, { timeoutMs: 180_000 });
          lib.nodes = lib.nodes.map((n) => ({ ...n, path: n.path.replace(/^\/+/, "") }));
          libCache.set(key, lib);
        }
        const head = `${lib.library}${lib.title ? ` (${lib.title}${lib.version ? ` ${lib.version}` : ""}${lib.company ? `, ${lib.company}` : ""})` : ""}`;
        if (lib.compiled) return `${head} is a compiled library (${lib.path}). Its declarations can't be read by scripting; check the library's documentation in CODESYS, or test calls with compile.`;
        if (symbol) {
          const hit = lib.nodes.find((n) => n.name.toLowerCase() === symbol.toLowerCase() && ["pou", "dut", "gvl", "interface"].includes(n.kind));
          if (!hit) return `${head} has no object '${symbol}'.`;
          return `${head}\n${buildOutline(lib.nodes, [], { path: hit.path })}`;
        }
        return `${head}\n${buildOutline(lib.nodes, [], { maxLines: 300 })}`;
      }),
  );

  // ---------------------------------------------------------------- changes

  const store = () => {
    if (!ctx.changes) throw new Error("Change tracking is not enabled.");
    if (!ctx.project) throw new Error("No project is open. Call open_project first.");
    return { store: ctx.changes, project: ctx.project.path };
  };

  reg(
    "checkpoint",
    {
      description:
        "Save a named snapshot of all ST in the project, to compare against (get_changes) or go back to (revert_object). A 'session-start' checkpoint is taken automatically when a project is opened. Without a name, lists the checkpoints.",
      inputSchema: z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, _ . -").optional() }),
    },
    async ({ name }) =>
      run(ctx, async () => {
        const { store: s, project } = store();
        if (!name) {
          const list = await s.list(project);
          return list.length ? list.map((c) => `${c.name}  ${c.at}  (${c.objects} objects)`).join("\n") : "No checkpoints yet.";
        }
        const cp = await s.save(project, name, await exportNodes());
        return `Checkpoint '${name}' saved (${cp.objects.length} objects).`;
      }),
  );

  reg(
    "get_changes",
    {
      description:
        "What changed in the project's ST since a checkpoint (default 'session-start'): added, removed and modified objects with line counts. Pass path for the line diff of one object (declaration and implementation, with line numbers).",
      inputSchema: z.object({ since: z.string().optional(), path: pathArg.optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ since, path }) =>
      run(ctx, async () => {
        const { store: s, project } = store();
        const name = since ?? "session-start";
        const cp = await s.load(project, name);
        if (!cp) {
          const list = await s.list(project);
          return `No checkpoint '${name}'.${list.length ? ` Checkpoints: ${list.map((c) => c.name).join(", ")}.` : ""}`;
        }
        const now = snapshot(await exportNodes());
        if (path) {
          const key = path.replace(/^\/+/, "").toLowerCase();
          const old = cp.objects.find((o) => o.path.toLowerCase() === key);
          const cur = now.find((o) => o.path.toLowerCase() === key);
          if (!old && !cur) return `No object '${path}' now or in '${name}'.`;
          const out = [`${cur?.path ?? old!.path}: ${!old ? "added" : !cur ? "removed" : "compared"} since '${name}' (${cp.at})`];
          for (const [label, a, bb] of [
            ["declaration", old?.declaration, cur?.declaration],
            ["implementation", old?.implementation, cur?.implementation],
          ] as const) {
            const ops = lineDiff(normalizeText(a ?? "")!.replace(/\s+$/, ""), normalizeText(bb ?? "")!.replace(/\s+$/, ""));
            if (ops.every((o) => o.op === " ")) continue;
            out.push(`--- ${label}`, ...formatDiff(ops));
          }
          if (out.length === 1) out.push("No changes.");
          return out.join("\n");
        }
        const changes = diffObjects(cp.objects, now);
        if (!changes.length) return `No changes since '${name}' (${cp.at}).`;
        const counts = (x?: { plus: number; minus: number }) => (x ? `+${x.plus} -${x.minus}` : "");
        return [
          `${changes.length} change(s) since '${name}' (${cp.at}):`,
          ...changes.map((c) => {
            const mark = c.change === "added" ? "A" : c.change === "removed" ? "D" : "M";
            const detail = c.change === "modified" ? ` (${[c.decl && `declaration ${counts(c.decl)}`, c.impl && `implementation ${counts(c.impl)}`].filter(Boolean).join(", ")})` : "";
            return `${mark} ${c.path} [${c.kind}]${detail}`;
          }),
          "Pass path to see one object's diff; revert_object puts it back.",
        ].join("\n");
      }),
  );

  reg(
    "revert_object",
    {
      description:
        "Put an object (and everything under it, e.g. an FB with its methods and properties) back to how it was at a checkpoint (default 'session-start'): modified objects are rewritten, objects added since are deleted, removed ones are recreated.",
      inputSchema: z.object({ path: pathArg, to: z.string().optional() }),
    },
    async ({ path, to }) => run(ctx, () => revertObject(ctx, path, to ?? "session-start")),
  );
}

/**
 * Put an object (and everything under it) back to how it was at a checkpoint:
 * modified objects are rewritten, objects added since are deleted, removed
 * ones are recreated. Used by revert_object and by the panel's Revert.
 */
export async function revertObject(ctx: AppContext, path: string, name: string): Promise<string> {
  if (!ctx.changes) throw new Error("Change tracking is not enabled.");
  if (!ctx.project) throw new Error("No project is open. Call open_project first.");
  const s = ctx.changes;
  const project = ctx.project.path;
  const b = ctx.bridge;
  const cache = ctx.cache;
  const exportNodes = async () => {
    const nodes = (await b.call<{ nodes: TreeNode[] }>("export", {}, { timeoutMs: 120_000 })).nodes;
    cache?.setAll(nodes);
    return nodes;
  };
  const cp = await s.load(project, name);
  if (!cp) throw new Error(`No checkpoint '${name}'.`);
  const key = path.replace(/^\/+/, "").toLowerCase();
  const inTree = (o: SnapObject) => o.path.toLowerCase() === key || o.path.toLowerCase().startsWith(key + "/");
  const old = cp.objects.filter(inTree);
  const now = snapshot(await exportNodes()).filter(inTree);
  if (!old.length && !now.length) throw new Error(`No object '${path}' now or in '${name}'.`);
  const oldBy = new Map(old.map((o) => [o.path.toLowerCase(), o] as const));
  const nowBy = new Map(now.map((o) => [o.path.toLowerCase(), o] as const));
  const done: string[] = [];
  const same = (a?: string, c?: string) => (normalizeText(a ?? "") ?? "").replace(/\s+$/, "") === (normalizeText(c ?? "") ?? "").replace(/\s+$/, "");
  // 1. delete what was added (top-most only; children go with their parent)
  const added = now.filter((o) => !oldBy.has(o.path.toLowerCase()));
  for (const o of added) {
    if (added.some((p) => o.path.toLowerCase().startsWith(p.path.toLowerCase() + "/"))) continue;
    await b.call("object.delete", { path: o.path, save: false });
    done.push(`deleted ${o.path}`);
  }
  // 2. recreate what was removed (parents first) and rewrite what changed
  const ordered = [...old].sort((x, y) => x.path.split("/").length - y.path.split("/").length);
  for (const o of ordered) {
    const cur = nowBy.get(o.path.toLowerCase());
    if (!cur) {
      if (o.kind === "accessor") {
        // created with its property; write its text below
      } else {
        const parent = o.path.includes("/") ? o.path.slice(0, o.path.lastIndexOf("/")) : undefined;
        const header = parseDeclaration(o.declaration).header;
        const kind = o.kind === "pou" ? o.sub : o.kind === "interface_method" ? "method" : o.kind;
        await b.call("object.create", {
          parent,
          kind,
          name: o.name,
          return_type: header.returnType,
          dut_type: o.kind === "dut" ? o.sub : undefined,
          base_interfaces: o.kind === "interface" ? "" : undefined,
          declaration: o.kind === "folder" ? undefined : o.declaration,
          implementation: o.implementation,
          save: false,
        });
        done.push(`recreated ${o.path}`);
        continue;
      }
    }
    if (o.kind === "folder") continue;
    const args: Record<string, unknown> = { path: o.path, save: false };
    if (o.declaration !== undefined && !same(o.declaration, cur?.declaration)) args.declaration = o.declaration;
    if (o.implementation !== undefined && !same(o.implementation, cur?.implementation)) args.implementation = o.implementation;
    if (args.declaration === undefined && args.implementation === undefined) continue;
    await b.call("object.write", args);
    done.push(`restored ${o.path}`);
  }
  if (!done.length) return `${path} is already as it was at '${name}'.`;
  let saved = "";
  if (ctx.autosave) {
    await b.call("project.save");
    saved = " Project saved.";
  }
  if (cache) {
    await exportNodes().catch(() => undefined);
    cache.touch(path.replace(/^\/+/, ""), "revert");
  }
  return `Reverted ${path} to '${name}' (${cp.at}): ${done.join(", ")}.${saved}`;
}
