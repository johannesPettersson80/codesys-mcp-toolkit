/**
 * What CODESYS's compiler knows about names: the interface of any POU or type,
 * including FBs in compiled libraries (TON, MC_MoveAbsolute, SysFileOpen...),
 * and where a name is read, written or called. See watcher/mcp_lang.py.
 */
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import type { AppContext } from "../tools.js";

interface Var {
  name: string;
  type: string;
  section: "input" | "output" | "other";
  comment?: string;
  hidden?: boolean;
  init?: string;
}
interface Sig {
  name: string;
  kind?: string;
  library?: string;
  comment?: string;
  variables?: Var[];
  members?: string[];
  error?: string;
}

/** A library doc comment without its reStructuredText blocks (examples, ranges, images). */
export function plainComment(c?: string): string {
  return (c ?? "").split(/\s\.\.\s|^\.\.\s/)[0]!.trim();
}

export function formatSignature(s: Sig): string {
  if (s.error) return `${s.name}: ${s.error}`;
  const head = `${s.name} (${s.kind ?? "?"}${s.library ? `, ${s.library}` : ", this project"})${plainComment(s.comment) ? `: ${plainComment(s.comment)}` : ""}`;
  const shown = (s.variables ?? []).filter((v) => !v.hidden);
  const line = (v: Var) => `  ${v.name} : ${v.type}${v.init ? ` := ${v.init}` : ""}${v.comment ? `  // ${v.comment}` : ""}`;
  const parts = [head];
  const ins = shown.filter((v) => v.section === "input");
  const outs = shown.filter((v) => v.section === "output");
  const other = shown.filter((v) => v.section === "other");
  if (ins.length) parts.push("VAR_INPUT", ...ins.map(line));
  if (outs.length) parts.push("VAR_OUTPUT", ...outs.map(line));
  if (other.length) parts.push("Other variables (in/out, locals)", ...other.map(line));
  const hidden = (s.variables ?? []).filter((v) => v.hidden).map((v) => v.name);
  if (hidden.length) parts.push(`Hidden (internal): ${hidden.join(", ")}`);
  if (s.members?.length) parts.push(`Methods, properties and actions: ${s.members.join(", ")}`);
  return parts.join("\n");
}

export function registerLangActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const b = ctx.bridge;
  reg(
    "get_signature",
    {
      description:
        "The real interface of POUs and types as CODESYS's compiler sees them: inputs, outputs, other variables with types, initial values and doc comments, and methods/properties. Works for the project's own code and for FBs in any referenced library, compiled ones included (TON, CTU, R_TRIG, MC_MoveAbsolute, SysFileOpen...). Use it before calling a library FB instead of guessing its parameters. Builds the application first if the names aren't known yet.",
      inputSchema: z.object({ names: z.array(z.string()).min(1).max(20).describe("POU or type names, e.g. ['TON', 'FB_Pump']") }),
    },
    async ({ names }) =>
      run(async () => {
        const r = await b.call<{ signatures: Sig[] }>("lang.signature", { names }, { timeoutMs: 300_000 });
        return r.signatures.map(formatSignature).join("\n\n");
      }),
  );
  reg(
    "find_references",
    {
      description: "Where a variable, POU or type is used in the application: each read, write and call with the POU, line and column, from CODESYS's cross-reference list. Builds first. Use it before renaming or changing an interface.",
      inputSchema: z.object({
        name: z.string().describe("e.g. 'xRunning', 'fbPump', 'FB_Pump'"),
        kind: z.enum(["variable", "pou", "type"]).default("variable"),
      }),
    },
    async ({ name, kind }) =>
      run(async () => {
        const r = await b.call<{ references: { access: string; pou: string; location: string; text: string }[] }>("lang.xref", { name, kind }, { timeoutMs: 300_000 });
        if (!r.references.length) return `No references to ${name} (as a ${kind}).`;
        return [`${r.references.length} reference${r.references.length === 1 ? "" : "s"} to ${name}:`, ...r.references.map((x) => `  ${x.access.padEnd(11)} ${x.pou}  ${x.location}  ${x.text}`)].join("\n");
      }),
  );
}

interface Ref {
  access: string;
  pou: string;
  location: string;
  text: string;
}

/** "Line 3, Column 22 (Impl)" -> where the reference is. */
export function parseLocation(loc: string): { line: number; col?: number; part: "declaration" | "implementation" } | undefined {
  const m = /Line\s+(\d+)(?:,\s*Column\s+(\d+))?\s*\((Decl|Impl)\)/i.exec(loc);
  if (!m) return undefined;
  return { line: Number(m[1]), ...(m[2] ? { col: Number(m[2]) } : {}), part: /^decl/i.test(m[3]!) ? "declaration" : "implementation" };
}

const word = (name: string) => new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`, "gi");

/** Replaces the identifier at (or after) each location; locations on one line go right to left. */
export function renameAt(text: string, spots: { line: number; col?: number }[], oldName: string, newName: string): { text: string; done: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let done = 0;
  const sorted = [...spots].sort((a, b) => b.line - a.line || (b.col ?? 0) - (a.col ?? 0));
  const seen = new Set<string>();
  for (const s of sorted) {
    const key = `${s.line}:${s.col ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const l = lines[s.line - 1];
    if (l === undefined) continue;
    const re = word(oldName);
    re.lastIndex = Math.max(0, (s.col ?? 1) - 1);
    const m = re.exec(l);
    if (!m) continue;
    lines[s.line - 1] = l.slice(0, m.index) + newName + l.slice(m.index + m[0].length);
    done++;
  }
  return { text: lines.join(eol), done };
}

export function registerRenameAction(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  reg(
    "rename_symbol",
    {
      description:
        "Rename a variable or a POU everywhere it is used, from CODESYS's cross-references: the declaration, every read, write and call, and instance declarations of a renamed FB. kind 'variable': name is the variable, owner the POU or GVL that declares it (refused when several objects declare the same name). kind 'pou': owner is the POU to rename. Compile afterwards. Graphical bodies that need changes are reported, not changed.",
      inputSchema: z.object({
        kind: z.enum(["variable", "pou"]),
        owner: z.string().describe("POU or GVL that declares the variable, or the POU to rename, e.g. 'FB_Pump'"),
        name: z.string().optional().describe("The variable's current name (kind 'variable')"),
        newName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      }),
    },
    async ({ kind, owner, name, newName }) =>
      run(async () => {
        if (kind === "variable" && !name) throw new Error("Give the variable's name.");
        const b = ctx.bridge;
        const oldName = kind === "pou" ? owner.split("/").pop()! : name!;
        const r = await b.call<{ references: Ref[] }>("lang.xref", { name: oldName, kind: kind === "pou" ? "pou" : "variable" }, { timeoutMs: 300_000 });
        let refs = r.references;
        if (kind === "variable") {
          const decls = refs.filter((x) => /^declaration$/i.test(x.access));
          const owners = [...new Set(decls.map((x) => x.pou.toLowerCase()))];
          if (owners.length > 1) throw new Error(`Several objects declare ${oldName} (${owners.join(", ")}); renaming would be ambiguous. Rename it in ${owner} by hand with write_object, or rename the others first.`);
          if (owners.length === 1 && owners[0] !== owner.split("/").pop()!.toLowerCase()) throw new Error(`${oldName} is declared in ${decls[0]!.pou}, not in ${owner}.`);
        } else {
          // Only the type name's own uses: declarations of instances (Type) and calls of functions or programs.
          refs = refs.filter((x) => x.text.toLowerCase().startsWith(oldName.toLowerCase()));
        }
        const byObj = new Map<string, { declaration: { line: number; col?: number }[]; implementation: { line: number; col?: number }[] }>();
        for (const x of refs) {
          const loc = parseLocation(x.location);
          if (!loc) continue;
          const path = x.pou.replace(/\./g, "/");
          const e = byObj.get(path) ?? { declaration: [], implementation: [] };
          e[loc.part].push({ line: loc.line, ...(loc.col ? { col: loc.col } : {}) });
          byObj.set(path, e);
        }
        if (kind === "pou") {
          const e = byObj.get(owner) ?? { declaration: [], implementation: [] };
          e.declaration.push({ line: 1 });
          byObj.set(owner, e);
        }
        if (!byObj.size) return `Nothing to rename: ${oldName} isn't used.`;
        const objs = (await b.call<{ objects: { path: string; declaration?: string; implementation?: string; error?: string }[] }>("objects.read", { paths: [...byObj.keys()] })).objects;
        const changed: string[] = [];
        const skipped: string[] = [];
        let count = 0;
        for (const o of objs) {
          const spots = byObj.get(o.path) ?? byObj.get([...byObj.keys()].find((k) => k.toLowerCase() === o.path.toLowerCase()) ?? "");
          if (!spots || o.error) {
            skipped.push(`${o.path}${o.error ? ` (${o.error})` : ""}`);
            continue;
          }
          const args: Record<string, string> = { path: o.path };
          if (spots.declaration.length && o.declaration !== undefined) {
            const d = renameAt(o.declaration, spots.declaration, oldName, newName);
            if (d.done) (args.declaration = d.text), (count += d.done);
          }
          if (spots.implementation.length) {
            if (o.implementation === undefined) {
              skipped.push(`${o.path} (graphical body)`);
            } else {
              const im = renameAt(o.implementation, spots.implementation, oldName, newName);
              if (im.done) (args.implementation = im.text), (count += im.done);
            }
          }
          if (args.declaration || args.implementation) {
            await b.call("object.write", { ...args, save: false });
            changed.push(o.path);
          }
        }
        if (kind === "pou") await b.call("object.rename", { path: owner, new_name: newName, save: false });
        await b.call("project.save", {}).catch(() => undefined);
        return [
          `Renamed ${kind === "pou" ? owner : `${owner}.${oldName}`} to ${newName}: ${count} occurrence(s) in ${changed.length} object(s) (${changed.join(", ")}).`,
          skipped.length ? `Not changed (do these by hand): ${skipped.join(", ")}.` : "",
          "Compile to check.",
        ]
          .filter(Boolean)
          .join("\n");
      }),
  );
}
