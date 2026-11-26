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

/**
 * "Line 3, Column 22 (Impl)" -> where the reference is. A GVL's declaration comes as just
 * "Line 2" (CODESYS SP21): no part means the declaration, a GVL has nothing else.
 */
export function parseLocation(loc: string): { line: number; col?: number; part: "declaration" | "implementation" } | undefined {
  const m = /Line\s+(\d+)(?:,\s*Column\s+(\d+))?(?:\s*\((Decl|Impl)\))?/i.exec(loc);
  if (!m) return undefined;
  return { line: Number(m[1]), ...(m[2] ? { col: Number(m[2]) } : {}), part: m[3] && /^impl/i.test(m[3]) ? "implementation" : "declaration" };
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

interface TreeNode {
  path: string;
  name: string;
  kind: string;
}

/**
 * How CODESYS's cross-references name objects (`FB_A`, `FB_A.Method`, `GVL_IO`: no folders, the
 * declaration's spelling) -> the object's path in the project tree. Keys are lower case.
 */
export class ObjectIndex {
  readonly byKey = new Map<string, TreeNode[]>();
  readonly keyOf = new Map<string, string>();
  constructor(readonly nodes: TreeNode[]) {
    const folders = new Set(nodes.filter((n) => n.kind === "folder").map((n) => n.path.toLowerCase()));
    for (const n of nodes) {
      if (n.kind === "folder") continue;
      const segs = n.path.split("/");
      const key = segs
        .filter((_, i) => i === segs.length - 1 || !folders.has(segs.slice(0, i + 1).join("/").toLowerCase()))
        .join(".")
        .toLowerCase();
      this.byKey.set(key, [...(this.byKey.get(key) ?? []), n]);
      this.keyOf.set(n.path.toLowerCase(), key);
    }
  }
  /** A cross-reference's POU name, or a name the user gave ('FB_A', 'folder1/fb_a', 'FB_A.Method'). */
  find(name: string): TreeNode | undefined {
    const exact = this.nodes.find((n) => n.path.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    return this.byKey.get(name.replace(/\//g, ".").toLowerCase())?.[0] ?? this.byKey.get(name.split("/").pop()!.toLowerCase())?.[0];
  }
  key(n: TreeNode): string {
    return this.keyOf.get(n.path.toLowerCase())!;
  }
}

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * What stands in front of a use of `name` in an ST text: nothing (`iX`), an instance or object
 * (`fbA.iX`, `GVL_IO.fbA.iX`: `chain` is what comes before the name), or a call it is a named
 * argument of (`fbA(iX := 1)`, possibly over several lines: `chain` is the callee).
 */
export function useContext(text: string, line: number, col: number | undefined, name: string): { how: "plain" | "member" | "argument"; chain?: string } | undefined {
  const lines = text.split(/\r?\n/);
  const l = lines[line - 1];
  if (l === undefined) return undefined;
  const re = word(name);
  re.lastIndex = Math.max(0, (col ?? 1) - 1);
  const m = re.exec(l);
  if (!m) return undefined;
  const before = l.slice(0, m.index);
  const member = new RegExp(`(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*\\.\\s*$`).exec(before);
  if (member) return { how: "member", chain: member[1]!.replace(/\s+/g, "") };
  // Through an array element or a call result (afb[i].iX, GetFb().iX): a member, but of what can't be read here.
  if (/[\])]\s*\.\s*$/.test(before)) return { how: "member" };
  if (/^\s*(:=|=>)/.test(l.slice(m.index + m[0].length))) {
    // Inside a call? Walk back to the unmatched '(' (a ';' first means it's a statement).
    const offset = lines.slice(0, line - 1).reduce((s, x) => s + x.length + 1, 0) + m.index;
    const flat = lines.join("\n");
    let depth = 0;
    for (let i = offset - 1; i >= 0; i--) {
      const ch = flat[i];
      if (ch === ")") depth++;
      else if (ch === "(") {
        if (depth === 0) {
          const callee = new RegExp(`(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*$`).exec(flat.slice(0, i));
          return { how: "argument", ...(callee ? { chain: callee[1]!.replace(/\s+/g, "") } : {}) };
        }
        depth--;
      } else if (ch === ";" && depth === 0) break;
    }
  }
  return { how: "plain" };
}

/** The type a declaration text gives a variable ('fbA : FB_A;', 'a, fbA : Lib.FB_A := ...'), its last name part, lower case. */
export function declaredType(declaration: string, variable: string): string | undefined {
  const re = new RegExp(`(?<![A-Za-z0-9_.])${variable}\\s*(?:,\\s*${IDENT}\\s*)*:\\s*(?:(?:POINTER|REFERENCE)\\s+TO\\s+)?(${IDENT}(?:\\.${IDENT})*)`, "i");
  const m = re.exec(declaration.replace(/\(\*[\s\S]*?\*\)|\/\/[^\n]*/g, " "));
  return m ? m[1]!.split(".").pop()!.toLowerCase() : undefined;
}

interface Spot {
  line: number;
  col?: number;
}
interface ReadObject {
  path: string;
  declaration?: string;
  implementation?: string;
  error?: string;
}

export function registerRenameAction(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  reg(
    "rename_symbol",
    {
      description:
        "Rename a variable or a POU everywhere it is used, from CODESYS's cross-references: the declaration, every read, write and call, instance declarations of a renamed FB, and I/O channels in the device tree mapped to it. Works for objects in folders. kind 'variable': name is the variable, owner the POU or GVL that declares it; when other objects declare a variable of the same name, only the owner's is renamed (its own uses, and uses through an instance of it). kind 'pou': owner is the POU to rename. An error when something couldn't be changed. Compile afterwards. Graphical bodies that need changes are reported, not changed.",
      inputSchema: z.object({
        kind: z.enum(["variable", "pou"]),
        owner: z.string().describe("POU or GVL that declares the variable, or the POU to rename, e.g. 'FB_Pump' or 'Folder1/FB_Pump'"),
        name: z.string().optional().describe("The variable's current name (kind 'variable')"),
        newName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      }),
    },
    async ({ kind, owner, name, newName }) =>
      run(async () => {
        if (kind === "variable" && !name) throw new Error("Give the variable's name.");
        const b = ctx.bridge;
        const tree = await b.call<{ nodes: TreeNode[]; application?: string | null }>("tree", {});
        const index = new ObjectIndex(tree.nodes);
        const ownerNode = index.find(owner);
        if (!ownerNode) throw new Error(`There is no object '${owner}' in the application (get_project_tree lists them).`);
        const ownerKey = index.key(ownerNode);
        const ownerName = ownerNode.name;
        const oldName = kind === "pou" ? ownerName : name!;
        const r = await b.call<{ references: Ref[] }>("lang.xref", { name: oldName, kind: kind === "pou" ? "pou" : "variable" }, { timeoutMs: 300_000 });
        let refs = r.references;
        if (!refs.length) throw new Error(`No references to ${oldName}${kind === "variable" ? ` (declared in ${owner}?)` : ""}: check the name, and that the application compiles.`);
        const isIo = (x: Ref) => /^IoConfig/i.test(x.pou);
        const ioRefs = refs.filter(isIo).length;
        refs = refs.filter((x) => !isIo(x));
        const inOwner = (key: string) => key === ownerKey || key.startsWith(`${ownerKey}.`);
        const keyOfRef = (x: Ref) => {
          const n = index.find(x.pou);
          return n ? index.key(n) : x.pou.toLowerCase();
        };

        // The objects to read: where the references are (and, to tell variables of the same name apart, their parents and the GVLs).
        let shared = false;
        if (kind === "variable") {
          const declKeys = [...new Set(refs.filter((x) => /^declaration$/i.test(x.access)).map(keyOfRef))];
          if (!declKeys.includes(ownerKey)) throw new Error(`${oldName} is not declared in ${owner}${declKeys.length ? ` (it is in ${declKeys.join(", ")})` : ""}.`);
          shared = declKeys.length > 1;
        } else {
          // Only the type name's own uses: declarations of instances (Type) and calls of functions or programs.
          refs = refs.filter((x) => x.text.toLowerCase().startsWith(oldName.toLowerCase()));
        }
        const pathOf = (x: Ref) => index.find(x.pou)?.path;
        const wanted = new Set<string>();
        for (const x of refs) {
          const p = pathOf(x);
          if (p) wanted.add(p);
        }
        wanted.add(ownerNode.path);
        if (shared) {
          for (const p of [...wanted]) if (p.includes("/")) wanted.add(p.split("/").slice(0, -1).join("/"));
          for (const n of tree.nodes) if (n.kind === "gvl") wanted.add(n.path);
        }
        const objs = (await b.call<{ objects: ReadObject[] }>("objects.read", { paths: [...wanted] })).objects;
        const textOf = new Map(objs.map((o) => [o.path.toLowerCase(), o] as const));
        const objectByKey = (key: string) => {
          const n = index.byKey.get(key)?.[0];
          return n ? textOf.get(n.path.toLowerCase()) : undefined;
        };

        // With variables of the same name elsewhere: keep the owner's uses only.
        const unclear: string[] = [];
        if (shared) {
          const gvls = tree.nodes.filter((n) => n.kind === "gvl").map((n) => n.name.toLowerCase());
          const ownerType = ownerName.toLowerCase();
          /** Whether a chain in front of the name ('fbA', 'GVL_IO.fbA', 'GVL_IO') leads to the owner; undefined when that can't be told. */
          const leadsToOwner = (chain: string, key: string): boolean | undefined => {
            const parts = chain.split(".");
            if (parts.length === 1 && parts[0]!.toLowerCase() === ownerType) return true; // GVL_IO.x, PRG_A.x
            const lookIn: (ReadObject | undefined)[] = [];
            let variable = parts[parts.length - 1]!;
            if (parts.length === 1) {
              lookIn.push(objectByKey(key), objectByKey(key.split(".").slice(0, -1).join(".")), ...gvls.map((g) => objectByKey(g)));
            } else if (parts.length === 2) {
              lookIn.push(objectByKey(parts[0]!.toLowerCase()));
            } else return undefined;
            for (const o of lookIn) {
              const t = o?.declaration ? declaredType(o.declaration, variable) : undefined;
              if (t) return t === ownerType;
            }
            // A qualifier naming another object (GVL_Other.x, PRG_B.x) isn't the owner.
            if (parts.length === 1 && index.byKey.has(parts[0]!.toLowerCase())) return false;
            return undefined;
          };
          const declarers = new Set(refs.filter((x) => /^declaration$/i.test(x.access)).map(keyOfRef));
          refs = refs.filter((x) => {
            const key = keyOfRef(x);
            if (inOwner(key)) return true;
            const loc = parseLocation(x.location);
            const o = objectByKey(key);
            const text = loc && o ? (loc.part === "declaration" ? o.declaration : o.implementation) : undefined;
            const use = loc && text !== undefined ? useContext(text, loc.line, loc.col, oldName) : undefined;
            if (!use) {
              unclear.push(`${x.pou} ${x.location} ${x.text}`.trim());
              return false;
            }
            if (use.how === "plain") {
              // Unqualified: the object's own variable, or (for a GVL owner) the owner's, unless the object declares one itself.
              return ownerNode.kind === "gvl" && !declarers.has(key) && !declarers.has(key.split(".")[0]!);
            }
            const yes = use.chain ? leadsToOwner(use.chain, key) : undefined;
            if (yes === undefined) unclear.push(`${x.pou} ${x.location}: ${x.text}`);
            return yes === true;
          });
          if (unclear.length)
            throw new Error(
              `Other objects declare ${oldName} too, and these uses can't be told apart (nothing was changed):\n${unclear.map((u) => `- ${u}`).join("\n")}\nRename ${owner}.${oldName} by hand with write_object, or rename the others first.`,
            );
        }

        const byObj = new Map<string, { declaration: Spot[]; implementation: Spot[] }>();
        const skipped: string[] = [];
        for (const x of refs) {
          const loc = parseLocation(x.location);
          if (!loc) continue;
          const path = pathOf(x);
          if (!path) {
            skipped.push(`${x.pou} (not found in the project tree)`);
            continue;
          }
          const e = byObj.get(path) ?? { declaration: [], implementation: [] };
          e[loc.part].push({ line: loc.line, ...(loc.col ? { col: loc.col } : {}) });
          byObj.set(path, e);
        }
        if (kind === "pou") {
          const e = byObj.get(ownerNode.path) ?? { declaration: [], implementation: [] };
          e.declaration.push({ line: 1 });
          byObj.set(ownerNode.path, e);
        }
        const missing = [...byObj.keys()].filter((p) => !textOf.has(p.toLowerCase()));
        if (missing.length) for (const o of (await b.call<{ objects: ReadObject[] }>("objects.read", { paths: missing })).objects) textOf.set(o.path.toLowerCase(), o);

        const changed: string[] = [];
        let count = 0;
        for (const [path, spots] of byObj) {
          const o = textOf.get(path.toLowerCase());
          if (!o || o.error) {
            skipped.push(`${path}${o?.error ? ` (${o.error})` : ""}`);
            continue;
          }
          const args: Record<string, string> = { path: o.path };
          if (spots.declaration.length && o.declaration !== undefined) {
            const d = renameAt(o.declaration, spots.declaration, oldName, newName);
            if (d.done) (args.declaration = d.text), (count += d.done);
          }
          if (spots.implementation.length) {
            if (o.implementation === undefined) skipped.push(`${o.path} (graphical body)`);
            else {
              const im = renameAt(o.implementation, spots.implementation, oldName, newName);
              if (im.done) (args.implementation = im.text), (count += im.done);
            }
          }
          if (args.declaration || args.implementation) {
            await b.call("object.write", { ...args, save: false });
            changed.push(o.path);
          }
        }
        if (kind === "pou") await b.call("object.rename", { path: ownerNode.path, new_name: newName, save: false });

        // I/O channels mapped to the renamed variable (or program/GVL): their mapping strings name it.
        let io = "";
        if (ioRefs) {
          const app = tree.application ?? "Application";
          const pairs: { from: string; to: string }[] = [];
          if (kind === "pou") pairs.push({ from: `${app}.${oldName}`, to: `${app}.${newName}` });
          else if (ownerNode.kind === "gvl" || ownerNode.kind === "pou") {
            pairs.push({ from: `${app}.${ownerName}.${oldName}`, to: `${app}.${ownerName}.${newName}` });
            // Members of the owner's instances in programs and GVLs (Application.PLC_PRG.fbA.iX).
            const inst = await b.call<{ references: Ref[] }>("lang.xref", { name: ownerName, kind: "pou", build: false }, { timeoutMs: 300_000 }).catch(() => ({ references: [] as Ref[] }));
            for (const x of inst.references) {
              const loc = parseLocation(x.location);
              const n = index.find(x.pou);
              if (!loc || loc.part !== "declaration" || !n) continue;
              const o = textOf.get(n.path.toLowerCase()) ?? (await b.call<{ objects: ReadObject[] }>("objects.read", { paths: [n.path] })).objects[0];
              const l = o?.declaration?.split(/\r?\n/)[loc.line - 1] ?? "";
              const m = new RegExp(`^\\s*(${IDENT}(?:\\s*,\\s*${IDENT})*)\\s*:`).exec(l);
              for (const v of m ? m[1]!.split(",").map((s) => s.trim()) : []) pairs.push({ from: `${app}.${n.name}.${v}.${oldName}`, to: `${app}.${n.name}.${v}.${newName}` });
            }
          }
          const re = await b.call<{ changed: { device: string; key: string; from: string; to: string }[] }>("devices.remap", { pairs, save: false }, { timeoutMs: 300_000 });
          const devices = new Set(re.changed.map((c) => c.device));
          io = re.changed.length
            ? `Remapped ${re.changed.length} I/O channel(s) on ${devices.size} device(s): ${re.changed.slice(0, 8).map((c) => `${c.device} ${c.from} -> ${c.to}`).join("; ")}${re.changed.length > 8 ? "; ..." : ""}.`
            : `The I/O configuration uses ${oldName} (${ioRefs} reference(s)), but no channel mapping matched: check the device tree (get_devices), or the next build fails.`;
          if (!re.changed.length) skipped.push("I/O mapping in the device tree");
        }
        await b.call("project.save", {}).catch(() => undefined);
        const text = [
          `Renamed ${kind === "pou" ? ownerNode.path : `${ownerNode.path}.${oldName}`} to ${newName}: ${count} occurrence(s) in ${changed.length} object(s) (${changed.join(", ")}).`,
          io,
          skipped.length ? `Not changed (do these by hand): ${skipped.join(", ")}.` : "",
          "Compile to check.",
        ]
          .filter(Boolean)
          .join("\n");
        // An error when something was left, so a batch stops.
        if (skipped.length || (count === 0 && kind === "variable")) throw new Error(count === 0 ? `Nothing was renamed.\n${text}` : text);
        return text;
      }),
  );
}

