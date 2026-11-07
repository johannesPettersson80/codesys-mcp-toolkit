/** Model-facing MCP tools for CODESYS (ST only, offline only). */
import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BridgeError, type CodesysBridge } from "./bridge/bridge.js";
import type { SimController } from "./sim/controller.js";
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
  const save = () => ({ save: ctx.autosave });
  const savedNote = (r: { saved?: boolean }) => (r.saved ? " Project saved." : ctx.autosave ? "" : " (not saved; call save_project)");

  server.registerTool(
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

  server.registerTool(
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
        return `${r.reused ? "Already open" : "Opened"}: ${r.path}. Active application: ${r.application ?? "none"}.`;
      }),
  );

  server.registerTool(
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
          return `Created empty project ${r.path}.`;
        }
        const src = t === "standard" ? (ctx.templatesDir ? join(ctx.templatesDir, "Standard.project") : "") : absPath(ctx, t);
        if (!src || !existsSync(src)) throw new Error(`Template not found: ${src || "CODESYS Templates folder unknown"}`);
        await copyFile(src, target);
        const r = await b.call<{ path: string; application?: string }>("project.open", { path: target }, { timeoutMs: 300_000 });
        ctx.project = { path: r.path, application: r.application };
        return `Created ${r.path} from ${t === "standard" ? "Standard.project" : src}. Active application: ${r.application ?? "none"}. Run compile to check that its libraries are installed.`;
      }),
  );

  server.registerTool(
    "save_project",
    { description: "Save the open project.", inputSchema: z.object({}) },
    async () => run(ctx, async () => `Saved ${(await b.call<{ path: string }>("project.save")).path}.`),
  );

  server.registerTool(
    "close_project",
    {
      description: "Close the open project. Refuses when there are unsaved changes unless discardChanges is true.",
      inputSchema: z.object({ discardChanges: z.boolean().optional() }),
    },
    async ({ discardChanges }) =>
      run(ctx, async () => {
        const r = await b.call<{ closed: boolean }>("project.close", { discard_changes: !!discardChanges });
        ctx.project = undefined;
        return r.closed ? "Project closed." : "No project was open.";
      }),
  );

  server.registerTool(
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

  server.registerTool(
    "read_objects",
    {
      description: "Read the declaration and implementation text of ST objects: POUs, methods, property accessors (path 'FB/Prop/Get'), actions, interfaces, DUTs and GVLs.",
      inputSchema: z.object({ paths: z.array(pathArg).min(1).max(50) }),
      annotations: { readOnlyHint: true },
    },
    async ({ paths }) =>
      run(ctx, async () => {
        const r = await b.call<{ objects: (TreeNode & { error?: string })[] }>("objects.read", { paths });
        return r.objects.map(formatObject).join("\n\n");
      }),
  );

  server.registerTool(
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
        return `Updated ${r.path} (${[declaration !== undefined && "declaration", implementation !== undefined && "implementation"].filter(Boolean).join(" + ")}).${savedNote(r)}`;
      }),
  );

  server.registerTool(
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
        return `Created ${a.kind} ${r.path}.${savedNote(r)}`;
      }),
  );

  server.registerTool(
    "delete_object",
    { description: "Delete an object (and its children).", inputSchema: z.object({ path: pathArg }), annotations: { destructiveHint: true } },
    async ({ path }) =>
      run(ctx, async () => {
        const r = await b.call<{ path: string; saved?: boolean }>("object.delete", { path, ...save() });
        return `Deleted ${r.path}.${savedNote(r)}`;
      }),
  );

  server.registerTool(
    "rename_object",
    {
      description: "Rename an object. References in other code are NOT updated; search_code for the old name afterwards.",
      inputSchema: z.object({ path: pathArg, newName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
    },
    async ({ path, newName }) =>
      run(ctx, async () => {
        const r = await b.call<{ path: string; saved?: boolean }>("object.rename", { path, new_name: newName, ...save() });
        return `Renamed to ${r.path}.${savedNote(r)}`;
      }),
  );

  server.registerTool(
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
        const r = await b.call<{ nodes: TreeNode[] }>("export", {}, { timeoutMs: 120_000 });
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

  server.registerTool(
    "compile",
    {
      description: "Build the active application and return errors and warnings with object and line. CODESYS only compiles POUs reachable from a task.",
      inputSchema: z.object({}),
    },
    async () =>
      run(ctx, async () => {
        const r = await b.call<{ messages: BuildMessage[] }>("build", {}, { timeoutMs: 600_000 });
        return formatBuild(r.messages).text;
      }),
  );

  server.registerTool(
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

  server.registerTool(
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

  server.registerTool(
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
}
