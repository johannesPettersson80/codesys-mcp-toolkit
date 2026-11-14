/**
 * Every CODESYS action behind one MCP tool, `codesys`.
 *
 * Claude Desktop asks for approval per tool, read-only or not, and remembers
 * "Always allow" per tool. With one tool the user presses once. That press
 * also covers writes and deletes, so the tool declares itself destructive.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export const TOOL_NAME = "codesys";

export type ActionContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ActionResult = { content: ActionContent[]; isError?: boolean };

export interface ActionConfig<S extends z.ZodObject = z.ZodObject> {
  description: string;
  inputSchema: S;
}

export interface Action extends ActionConfig {
  run: (args: unknown) => Promise<ActionResult>;
}

export type RegisterAction = <S extends z.ZodObject>(name: string, config: ActionConfig<S>, run: (args: z.infer<S>) => ActionResult | Promise<ActionResult>) => void;

interface Schema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema | boolean;
}

const fields = (s: Schema): [string, Schema, string][] => {
  const required = new Set(s.required ?? []);
  return Object.entries(s.properties ?? {}).map(([k, p]) => [k, p, `${k}${required.has(k) ? "" : "?"}`]);
};

function typeName(s: Schema): string {
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.anyOf) return s.anyOf.map(typeName).join(" | ");
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "array") return `${s.items ? typeName(s.items) : "any"}[]`;
  if (s.type === "object" && s.properties) return `{ ${fields(s).map(([, p, label]) => `${label}: ${typeName(p)}`).join(", ")} }`;
  if (s.type === "object" && typeof s.additionalProperties === "object") return `{ [name]: ${typeName(s.additionalProperties)} }`;
  return s.type ?? "any";
}

/** One action's description and arguments, as the model reads them. */
export function usage(name: string, a: ActionConfig): string {
  const s = z.toJSONSchema(a.inputSchema, { io: "input" }) as Schema;
  const params = fields(s).map(([, p, label]) => `  ${label}: ${typeName(p)}${p.description ? ` - ${p.description}` : ""}`);
  return [`${name}: ${a.description}`, ...params].join("\n");
}

const HOW_TO_CALL = `Everything this toolkit does in CODESYS V3.5. Call it as {"action": "<name>", "args": {...}}, with the action's arguments in args. Leave args out when the action takes none. Example: {"action": "read_objects", "args": {"paths": ["PLC_PRG"]}}. Use batch to send several actions in one call: it is much faster than separate calls. Some actions change or delete project code. {"action": "help"} returns this list, and {"action": "help", "args": {"action": "write_object"}} one action, for when a client shortens this text.`;

const MAX_BATCH = 50;

const reply = (text: string, isError = false): ActionResult => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

// Strict: nothing else checks the arguments, and a misspelt optional one must not be dropped silently.
const checkArgs = (a: ActionConfig, args: unknown) => a.inputSchema.strict().safeParse(args ?? {});

const batchInput = z.object({
  calls: z.array(z.object({ action: z.string(), args: z.record(z.string(), z.unknown()).optional() })).min(1).max(MAX_BATCH).describe(`The steps, in order, at most ${MAX_BATCH}`),
  continueOnError: z.boolean().optional().describe("Run the remaining steps after one fails (default false)"),
});

/** Most of a session's time is the round trip between calls, not CODESYS: this saves those. */
function batchAction(actions: Map<string, Action>): Action {
  return {
    description:
      "Run several actions in one call, in order, and get all their results back. Use this whenever you already know the next steps, for example several create_object or write_object calls and then compile, or a simulation step (codesys_sim_force, wait, codesys_sim_cycle, codesys_sim_read). Every step is checked first, and nothing runs if one is invalid. It stops at the first step that fails, unless continueOnError is true. A batch can't contain help or another batch.",
    inputSchema: batchInput,
    run: async (raw) => {
      const { calls, continueOnError } = raw as z.infer<typeof batchInput>;
      const steps: { name: string; action: Action; args: unknown }[] = [];
      for (const [i, c] of calls.entries()) {
        const action = actions.get(c.action);
        if (!action) return reply(`Step ${i + 1}: '${c.action}' can't run in a batch, so nothing was run. Actions: ${[...actions.keys()].join(", ")}.`, true);
        const parsed = checkArgs(action, c.args);
        if (!parsed.success) return reply(`Step ${i + 1} (${c.action}) has invalid arguments, so nothing was run:\n${z.prettifyError(parsed.error)}\n\n${usage(c.action, action)}`, true);
        steps.push({ name: c.action, action, args: parsed.data });
      }
      const out: string[] = [];
      let failed = false;
      for (const [i, s] of steps.entries()) {
        const r = await s.action.run(s.args);
        out.push(`[${i + 1}/${steps.length}] ${s.name}${r.isError ? " FAILED" : ""}:\n${r.content.map((c) => (c.type === "text" ? c.text : "(an image: call this action on its own to see it)")).join("\n")}`);
        failed ||= !!r.isError;
        if (r.isError && !continueOnError) {
          if (i + 1 < steps.length) out.push(`Stopped: the remaining ${steps.length - i - 1} step(s) were not run.`);
          break;
        }
      }
      return reply(out.join("\n\n"), failed);
    },
  };
}

export function registerActionTool(server: McpServer, actions: Map<string, Action>): void {
  const all = new Map<string, Action>([["batch", batchAction(actions)], ...actions]);
  const names = [...all.keys()];
  const catalog = names.map((n) => usage(n, all.get(n)!)).join("\n\n");
  server.registerTool(
    TOOL_NAME,
    {
      description: `${HOW_TO_CALL}\n\nActions:\n\n${catalog}`,
      inputSchema: z.object({
        action: z.enum(["help", ...names]).describe("The action to run"),
        args: z.record(z.string(), z.unknown()).optional().describe("The action's arguments, as listed for it in this tool's description"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ action, args }) => {
      if (action === "help") {
        if (args?.action === undefined) return reply(catalog);
        const wanted = String(args.action);
        const known = all.get(wanted);
        return known ? reply(usage(wanted, known)) : reply(`Unknown action '${wanted}'. Actions: ${names.join(", ")}.`, true);
      }
      const a = all.get(action)!;
      const parsed = checkArgs(a, args);
      if (!parsed.success) return reply(`Invalid arguments for ${action}:\n${z.prettifyError(parsed.error)}\n\n${usage(action, a)}`, true);
      return a.run(parsed.data);
    },
  );
}
