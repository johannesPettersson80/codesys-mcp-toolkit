/**
 * The mirror: a truST project composed from the CODESYS project's ST.
 *
 * Pure functions: CODESYS export + task list + plant config in, file texts +
 * line map out. Writing to disk lives in mirror-store.ts.
 *
 * Composition rules (spike/trust-fidelity/TRUST-GAPS.md section C):
 * - one file per top-level object; methods, properties (GET/SET) and actions
 *   are nested into their FB or program text;
 * - GVLs are wrapped in NAMESPACE <name> so `GVL.x` works;
 * - `PROPERTY PUBLIC X : T` becomes `PUBLIC PROPERTY X : T`;
 * - methods and properties without an access modifier get an explicit
 *   PUBLIC (the CODESYS default), so truST tools that check under IEC rules,
 *   such as Control Studio's setup, accept them too;
 * - the implicit `EXTENDS __System.IQueryInterface` is removed;
 * - each task becomes a TASK, each called program an instance with the POU's
 *   own name (so `PRG_Tank.nTrips` is the same path in CODESYS and truST);
 * - plant-wired variables get a generated AT address;
 * - a generated program, MCP_SimHarness, runs first in the fastest task. It
 *   counts scans (run_scans stops on it) and simulates [[feedback]] signals.
 */
import { createHash } from "node:crypto";
import type { TreeNode } from "../codesys/st.js";
import type { PlantConfig } from "./plant.js";

export const HARNESS = "MCP_SimHarness";
export const HARNESS_FILE = `src/${HARNESS}.st`;

export interface TaskInfo {
  name: string;
  interval?: string | null;
  interval_unit?: string | null;
  priority?: string | null;
  kind?: string | null;
  pous: string[];
}

/** One mirror line's origin: CODESYS object path, part and 1-based line. */
export interface LineOrigin {
  obj: string;
  part: "decl" | "impl";
  line: number;
}

export interface MirrorFile {
  path: string;
  text: string;
  /** Per mirror line (index = 0-based line): origin, or null for generated lines. */
  map: (LineOrigin | null)[];
}

export interface ComposedTask {
  name: string;
  intervalMs: number;
  priority: number;
  programs: string[];
}

export interface Composition {
  files: MirrorFile[];
  /** Object path -> hash of its ST text (for change detection). */
  hashes: Record<string, string>;
  tasks: ComposedTask[];
  /** The task the harness runs in, and its interval. */
  clockTask: string;
  cycleMs: number;
  /** 0-based line of the harness scan counter (the run_scans breakpoint). */
  harnessLine0: number;
  /** Variable path (lower-case) -> generated AT address. */
  addresses: Map<string, string>;
  /** Human-readable notes: skipped objects, rewrites, warnings. */
  notes: string[];
  warnings: string[];
  /** Enum types whose E.X literals were rewritten to E#X. */
  enums: string[];
  /** POUs marked {attribute 'test'}, run by run_tests and never by a task. */
  tests: { name: string; path: string; kind: "program" | "function_block" }[];
}

export class MirrorError extends Error {}

const SIZE_BYTES: Record<string, number> = { X: 1, B: 1, W: 2, D: 4, L: 8 };
const TYPE_SIZE: Record<string, "X" | "B" | "W" | "D" | "L"> = {
  BOOL: "X",
  BYTE: "B", SINT: "B", USINT: "B",
  WORD: "W", INT: "W", UINT: "W",
  DWORD: "D", DINT: "D", UDINT: "D", REAL: "D",
  LWORD: "L", LINT: "L", ULINT: "L", LREAL: "L",
};

const lines = (s: string | undefined): string[] => (s ? s.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n") : []);

class Out {
  lines: string[] = [];
  map: (LineOrigin | null)[] = [];
  add(text: string | undefined, obj: string, part: "decl" | "impl") {
    lines(text).forEach((l, i) => {
      this.lines.push(l);
      this.map.push({ obj, part, line: i + 1 });
    });
  }
  raw(l: string) {
    this.lines.push(l);
    this.map.push(null);
  }
}

function headerKeyword(decl: string | undefined): string {
  const stripped = (decl ?? "").replace(/\(\*[\s\S]*?\*\)/g, " ").replace(/\/\/[^\n]*/g, " ").replace(/\{[^}]*\}/g, " ");
  const m = /^\s*([A-Za-z_]+)/.exec(stripped);
  return m ? m[1]!.toUpperCase() : "";
}

const LEADING = String.raw`((?:\s|\{[^}]*\}|//[^\n]*(?:\n|$)|\(\*[\s\S]*?\*\))*)`;

/** True when a POU declaration carries `{attribute 'test'}` before its header. */
export function isTestPou(decl: string | undefined): boolean {
  const lead = new RegExp(`^${LEADING}`).exec(decl ?? "")?.[1] ?? "";
  return /\{\s*attribute\s+'test'\s*\}/i.test(lead);
}

/**
 * `{attribute 'test'} PROGRAM X` -> `{attribute 'test'} TEST_PROGRAM X` (and
 * FUNCTION_BLOCK -> TEST_FUNCTION_BLOCK), the form truST 0.33 runs as a test.
 * truST will accept the attribute itself under the CODESYS profile; until
 * then the mirror rewrites the header.
 */
export function toTestHeader(decl: string): string {
  return decl.replace(new RegExp(`^${LEADING}(PROGRAM|FUNCTION_BLOCK)\\b`, "i"), (_m, lead: string, kw: string) => `${lead}TEST_${kw.toUpperCase()}`);
}

const isEmptyVar = (decl: string | undefined) => /^\s*(VAR\s+END_VAR\s*)?$/i.test(decl ?? "");

/** `PROPERTY PUBLIC X : T` -> `PUBLIC PROPERTY X : T` (truST order); no access modifier -> PUBLIC (CODESYS's default). */
export function propertyHeader(decl: string): string {
  const moved = decl.replace(/^(\s*)PROPERTY\s+((?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)+)/i, (_m, ws: string, mods: string) => `${ws}${mods.trim()} PROPERTY `);
  return moved.replace(/^(\s*)((?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL)\s+)*)PROPERTY\b/i, (m, ws: string, mods: string) =>
    /\b(PUBLIC|PRIVATE|PROTECTED|INTERNAL)\b/i.test(mods) ? m : `${ws}PUBLIC ${mods}PROPERTY`,
  );
}

/** `METHOD X` -> `METHOD PUBLIC X` when the method has no access modifier (CODESYS's default is PUBLIC). */
export function methodHeader(decl: string): string {
  return decl.replace(/^((?:\s*\{[^}]*\}\s*)*\s*)METHOD\s+((?:(?:PUBLIC|PRIVATE|PROTECTED|INTERNAL|ABSTRACT|FINAL|OVERRIDE)\s+)*)/i, (m, lead: string, mods: string) =>
    /\b(PUBLIC|PRIVATE|PROTECTED|INTERNAL)\b/i.test(mods) ? m : `${lead}METHOD PUBLIC ${mods}`,
  );
}

export function stripQueryInterface(decl: string): string {
  return decl
    .replace(/(EXTENDS\s+)__System\.IQueryInterface\s*,\s*/i, "$1")
    .replace(/\s*,\s*__System\.IQueryInterface\b/i, "")
    .replace(/\s+EXTENDS\s+__System\.IQueryInterface\b/i, "");
}

/** Member names of an enum DUT declaration (`TYPE E : (A := 0, B) INT; END_TYPE`). */
export function enumMembers(decl: string): { name: string; members: string[] } | undefined {
  const clean = decl.replace(/\(\*[\s\S]*?\*\)/g, " ").replace(/\/\/[^\n]*/g, " ").replace(/\{[^}]*\}/g, " ");
  const m = /\bTYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\(([\s\S]*?)\)/i.exec(clean);
  if (!m) return undefined;
  const members = m[2]!
    .split(",")
    .map((s) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(s)?.[1])
    .filter((x): x is string => !!x);
  return members.length ? { name: m[1]!, members } : undefined;
}

/**
 * Rewrite CODESYS enum literals `E.X` to `E#X` (truST 0.33 rejects `E.X`,
 * TRUST-GAPS A1). Only enums defined in the project, and never inside
 * strings, comments or pragmas. Line structure is kept.
 */
export function rewriteEnumLiterals(text: string, enums: Map<string, Set<string>>): string {
  if (!enums.size || !text) return text;
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    let end = -1;
    if (two === "//") end = text.indexOf("\n", i) < 0 ? n : text.indexOf("\n", i);
    else if (two === "(*") end = text.indexOf("*)", i + 2) < 0 ? n : text.indexOf("*)", i + 2) + 2;
    else if (two === "/*") end = text.indexOf("*/", i + 2) < 0 ? n : text.indexOf("*/", i + 2) + 2;
    else if (c === "{") end = text.indexOf("}", i) < 0 ? n : text.indexOf("}", i) + 1;
    else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c) j += text[j] === "$" ? 2 : 1;
      end = Math.min(n, j + 1);
    }
    if (end >= 0) {
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 256));
    if (m && (i === 0 || !/[A-Za-z0-9_.#]/.test(text[i - 1]!))) {
      const word = m[0];
      const members = enums.get(word.toLowerCase());
      const after = /^[ \t]*\.[ \t]*([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i + word.length, i + word.length + 256));
      if (members && after && members.has(after[1]!.toLowerCase())) {
        out += `${word}#${after[1]}`;
        i += word.length + after[0].length;
        continue;
      }
      out += word;
      i += word.length;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse an IEC/CODESYS task interval ("t#10ms", "T#1s500ms", "10" + unit) to ms. */
export function parseIntervalMs(interval?: string | null, unit?: string | null): number | undefined {
  if (!interval) return undefined;
  const s = interval.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const u = (unit ?? "ms").toLowerCase();
    return u === "s" ? n * 1000 : u === "us" ? n / 1000 : u === "ns" ? n / 1e6 : n;
  }
  const body = s.replace(/^(t|time|lt|ltime)#/i, "");
  let ms = 0;
  let matched = false;
  for (const m of body.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|ms|m|s|us|ns)/gi)) {
    matched = true;
    const n = Number(m[1]);
    const f = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 }[m[2]!.toLowerCase() as "d"]!;
    ms += n * f;
  }
  return matched ? ms : undefined;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Byte extent of every AT address in the sources, per area. */
export function usedAddressEnd(texts: string[]): Record<"I" | "Q" | "M", number> {
  const end = { I: 0, Q: 0, M: 0 };
  for (const t of texts) {
    for (const m of t.matchAll(/%([IQM])([XBWDL]?)(\d+)(?:\.\d+)?/gi)) {
      const area = m[1]!.toUpperCase() as "I" | "Q" | "M";
      const size = (m[2] || "X").toUpperCase();
      const n = Number(m[3]);
      const bytes = SIZE_BYTES[size] ?? 1;
      end[area] = Math.max(end[area], size === "X" ? n + 1 : (n + 1) * bytes);
    }
  }
  return end;
}

/** Find `name [AT %...] : TYPE` in a declaration; returns the type name. */
export function declaredType(decl: string, name: string): string | undefined {
  const re = new RegExp(`(^|[\\s;(])${name}\\s*(AT\\s+%[^\\s:]+\\s*)?:\\s*([A-Za-z_][A-Za-z0-9_]*)`, "im");
  const m = re.exec(decl.replace(/\(\*[\s\S]*?\*\)/g, "").replace(/\/\/[^\n]*/g, ""));
  return m ? m[3]!.toUpperCase() : undefined;
}

/** Put `AT <address>` on a variable's declaration (replacing an existing AT). */
export function injectAddress(decl: string, name: string, address: string): string {
  const re = new RegExp(`(^|[\\s;(])(${name})\\s*(AT\\s+%[^\\s:]+\\s*)?:`, "im");
  if (!re.test(decl)) throw new MirrorError(`can't find the declaration of ${name}`);
  return decl.replace(re, (_m, pre: string, n: string) => `${pre}${n} AT ${address} :`);
}

export interface ComposeOptions {
  plant?: PlantConfig;
}

export function composeMirror(nodes: TreeNode[], tasks: TaskInfo[], opts: ComposeOptions = {}): Composition {
  const notes: string[] = [];
  const warnings: string[] = [];
  const byPath = new Map(nodes.map((n) => [n.path, n] as const));
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const p = parentOf(n.path);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(n);
  }
  const childrenOf = (n: TreeNode, ...kinds: string[]) => (kids.get(n.path) ?? []).filter((c) => kinds.includes(c.kind));

  // Top-level ST objects: POUs, DUTs, GVLs, interfaces, at any folder depth,
  // whose parent is a folder or the application (not another POU).
  const isContainer = (p: string) => p === "" || byPath.get(p)?.kind === "folder";
  const tops = nodes.filter((n) => ["pou", "dut", "gvl", "interface"].includes(n.kind) && isContainer(parentOf(n.path)));

  // Declarations may be rewritten (plant addresses), so work on copies.
  const decl = new Map<string, string>();
  for (const n of nodes) {
    const d = n.declaration ?? "";
    // CODESYS placeholder addresses (AT %I*) are mapped in the device tree; the simulation has none.
    const stripped = d.replace(/\s+AT\s+%[IQM]\*/gi, "");
    if (stripped !== d) notes.push(`${n.path}: removed AT %I*/%Q* placeholders`);
    decl.set(n.path, stripped);
  }

  // CODESYS writes enum values as E.X; truST needs E#X (TRUST-GAPS A1).
  const enums = new Map<string, Set<string>>();
  const enumNames: string[] = [];
  for (const n of nodes) {
    if (n.kind !== "dut") continue;
    const e = enumMembers(n.declaration ?? "");
    if (e) {
      enums.set(e.name.toLowerCase(), new Set(e.members.map((m) => m.toLowerCase())));
      enumNames.push(e.name);
    }
  }
  let enumRewrites = 0;
  const st = (s: string | undefined) => {
    const r = rewriteEnumLiterals(s ?? "", enums);
    if (r !== (s ?? "")) enumRewrites++;
    return r;
  };
  for (const [k, v] of decl) decl.set(k, st(v));
  const impl = (x: TreeNode) => st(x.implementation);

  // ---- plant wiring: generated AT addresses
  const addresses = new Map<string, string>();
  const plant = opts.plant;
  if (plant && plant.plants.length) {
    const used = usedAddressEnd([...decl.values()]);
    const next = { I: Math.ceil(used.I / 8) * 8, Q: Math.ceil(used.Q / 8) * 8 };
    const owner = (path: string): TreeNode => {
      const [objName] = path.split(".");
      const o = tops.find((t) => t.name.toLowerCase() === objName!.toLowerCase() && (t.kind === "gvl" || t.sub === "program"));
      if (!o) throw new MirrorError(`plant.toml: ${path}: '${objName}' is not a GVL or program in the project`);
      return o;
    };
    const wire = (path: string, area: "I" | "Q") => {
      const o = owner(path);
      const name = path.split(".")[1]!;
      const d = decl.get(o.path)!;
      const type = declaredType(d, name);
      if (!type) throw new MirrorError(`plant.toml: ${path} is not declared in ${o.name}`);
      const size = TYPE_SIZE[type];
      if (!size) throw new MirrorError(`plant.toml: ${path} is ${type}; plant signals must be BOOL, an integer, REAL or LREAL`);
      let address: string;
      if (size === "X") {
        address = `%${area}X${next[area]}.0`;
        next[area] += 1;
      } else {
        const bytes = SIZE_BYTES[size]!;
        next[area] = Math.ceil(next[area] / bytes) * bytes;
        address = `%${area}${size}${next[area] / bytes}`;
        next[area] += bytes;
      }
      decl.set(o.path, injectAddress(d, name, address));
      addresses.set(path.toLowerCase(), address);
      notes.push(`${path} AT ${address} (plant ${area === "I" ? "feedback" : "command"})`);
    };
    for (const p of plant.plants) {
      p.inputs.forEach((v) => wire(v, "Q"));
      p.outputs.forEach((v) => wire(v, "I"));
    }
  }

  // ---- objects
  const files: MirrorFile[] = [];
  const hashes: Record<string, string> = {};
  const usedNames = new Set<string>();
  const tests: Composition["tests"] = [];
  const nonSt: string[] = [];
  const unqualifiedGvls = tops.filter((t) => t.kind === "gvl" && !/\{\s*attribute\s+'qualified_only'\s*\}/i.test(decl.get(t.path) ?? "")).map((t) => t.name);

  for (const o of tops) {
    if (o.st === false) {
      nonSt.push(o.path);
      continue;
    }
    const out = new Out();
    const d = decl.get(o.path) ?? "";
    hashes[o.path] = hash(JSON.stringify([d, o.implementation ?? "", ...(kids.get(o.path) ?? []).map((c) => [c.path, c.declaration, c.implementation])]));

    if (o.kind === "pou") {
      const kw = headerKeyword(d);
      let end = ({ PROGRAM: "END_PROGRAM", FUNCTION_BLOCK: "END_FUNCTION_BLOCK", FUNCTION: "END_FUNCTION" } as Record<string, string>)[kw];
      if (!end) {
        warnings.push(`${o.path}: unsupported POU header '${kw || "(none)"}'; skipped`);
        continue;
      }
      let header = d;
      if (isTestPou(d) && (kw === "PROGRAM" || kw === "FUNCTION_BLOCK")) {
        header = toTestHeader(d);
        end = `END_TEST_${kw}`;
        tests.push({ name: o.name, path: o.path, kind: kw === "PROGRAM" ? "program" : "function_block" });
      }
      out.add(header, o.path, "decl");
      out.add(impl(o), o.path, "impl");
      for (const m of childrenOf(o, "method")) {
        if (m.st === false) {
          nonSt.push(m.path);
          continue;
        }
        out.raw("");
        out.add(methodHeader(decl.get(m.path) ?? ""), m.path, "decl");
        out.add(impl(m), m.path, "impl");
        out.raw("END_METHOD");
      }
      for (const p of childrenOf(o, "property")) {
        out.raw("");
        out.add(propertyHeader(decl.get(p.path) ?? ""), p.path, "decl");
        const acc = childrenOf(p, "accessor");
        for (const which of ["GET", "SET"]) {
          const a = acc.find((x) => x.name.toUpperCase() === which);
          if (!a) continue;
          out.raw(`    ${which}`);
          const ad = decl.get(a.path);
          if (!isEmptyVar(ad)) out.add(ad, a.path, "decl");
          out.add(impl(a), a.path, "impl");
          out.raw(`    END_${which}`);
        }
        out.raw("END_PROPERTY");
      }
      for (const a of childrenOf(o, "action")) {
        if (a.st === false) {
          nonSt.push(a.path);
          continue;
        }
        out.raw("");
        out.raw(`ACTION ${a.name}:`);
        out.add(impl(a), a.path, "impl");
        out.raw("END_ACTION");
      }
      out.raw(end);
    } else if (o.kind === "interface") {
      const stripped = stripQueryInterface(d);
      if (stripped !== d) notes.push(`${o.path}: removed implicit EXTENDS __System.IQueryInterface`);
      out.add(stripped, o.path, "decl");
      for (const c of kids.get(o.path) ?? []) {
        if (c.kind === "interface_method" || c.kind === "method") {
          out.add(decl.get(c.path), c.path, "decl");
          out.raw("END_METHOD");
        } else if (c.kind === "property") {
          out.add(propertyHeader(decl.get(c.path) ?? ""), c.path, "decl");
          for (const a of childrenOf(c, "accessor")) {
            out.raw(`    ${a.name.toUpperCase()}`);
            out.raw(`    END_${a.name.toUpperCase()}`);
          }
          out.raw("END_PROPERTY");
        }
      }
      out.raw("END_INTERFACE");
    } else if (o.kind === "dut") {
      out.add(d, o.path, "decl");
    } else if (o.kind === "gvl") {
      out.raw(`NAMESPACE ${o.name}`);
      out.add(d, o.path, "decl");
      out.raw("END_NAMESPACE");
    }

    let fname = o.name;
    for (let i = 2; usedNames.has(fname.toLowerCase()); i++) fname = `${o.name}_${i}`;
    usedNames.add(fname.toLowerCase());
    files.push({ path: `src/${fname}.st`, text: out.lines.join("\n") + "\n", map: out.map });
  }
  if (enumRewrites) notes.push(`Rewrote enum literals E.X to E#X in ${enumRewrites} text(s) (truST needs E#X).`);
  if (nonSt.length) warnings.push(`Not simulated (graphical, not ST): ${nonSt.join(", ")}`);
  if (unqualifiedGvls.length) {
    notes.push(`GVLs without {attribute 'qualified_only'} (${unqualifiedGvls.join(", ")}): the simulation needs qualified access (GVL.x).`);
  }

  // ---- tasks and configuration
  const composedTasks: ComposedTask[] = [];
  const testNames = new Set(tests.map((t) => t.name.toLowerCase()));
  const programNames = new Map(
    tops.filter((t) => t.kind === "pou" && t.sub === "program" && t.st !== false && !testNames.has(t.name.toLowerCase())).map((t) => [t.name.toLowerCase(), t.name] as const),
  );
  for (const t of tasks) {
    const kind = (t.kind ?? "cyclic").toLowerCase();
    if (/event|status|extern/.test(kind)) {
      warnings.push(`Task ${t.name} (${t.kind}) is not cyclic; not simulated`);
      continue;
    }
    let ms = parseIntervalMs(t.interval, t.interval_unit);
    if (/freewheel/.test(kind) || !ms) {
      ms = ms || 10;
      if (/freewheel/.test(kind)) notes.push(`Task ${t.name} is freewheeling; simulated as cyclic ${ms} ms`);
    }
    const programs: string[] = [];
    for (const p of t.pous) {
      const base = p.split(".").pop()!;
      const prog = programNames.get(base.toLowerCase());
      if (prog) programs.push(prog);
      else if (testNames.has(base.toLowerCase())) warnings.push(`Task ${t.name} calls the test ${p}; tests only run with run_tests, so it is left out of the simulation`);
      else warnings.push(`Task ${t.name} calls ${p}, which is not an ST program in the mirror; skipped`);
    }
    const prio = Number(t.priority);
    composedTasks.push({ name: t.name.replace(/[^A-Za-z0-9_]/g, "_"), intervalMs: Math.max(1, Math.round(ms)), priority: Number.isFinite(prio) ? prio : 1, programs });
  }
  if (!composedTasks.some((t) => t.programs.length)) {
    throw new MirrorError("No task calls an ST program, so there is nothing to simulate. Check list_tasks.");
  }
  const clock = [...composedTasks].sort((a, b) => a.intervalMs - b.intervalMs)[0]!;

  // ---- harness
  const h = new Out();
  h.raw(`PROGRAM ${HARNESS}`);
  h.raw("VAR");
  h.raw("    nScan : ULINT;");
  plant?.feedback.forEach((_f, i) => {
    h.raw(`    tonFb${i + 1} : TON;`);
    h.raw(`    tofFb${i + 1} : TOF;`);
  });
  h.raw("END_VAR");
  const harnessLine0 = h.lines.length;
  h.raw("nScan := nScan + 1;");
  plant?.feedback.forEach((f, i) => {
    const src = f.invert ? `NOT ${f.follows}` : f.follows;
    const pt = `T#${f.delay_ms}MS`;
    h.raw(`tonFb${i + 1}(IN := ${src}, PT := ${pt});`);
    h.raw(`tofFb${i + 1}(IN := ${src}, PT := ${pt});`);
    h.raw(`IF ${src} THEN ${f.signal} := tonFb${i + 1}.Q; ELSE ${f.signal} := tofFb${i + 1}.Q; END_IF`);
  });
  h.raw("END_PROGRAM");
  files.push({ path: HARNESS_FILE, text: h.lines.join("\n") + "\n", map: h.map });

  const cfg = ["CONFIGURATION Config", "RESOURCE Res ON PLC"];
  for (const t of composedTasks) cfg.push(`    TASK ${t.name} (INTERVAL := T#${t.intervalMs}MS, PRIORITY := ${t.priority});`);
  cfg.push(`    PROGRAM ${HARNESS} WITH ${clock.name} : ${HARNESS};`);
  for (const t of composedTasks) for (const p of t.programs) cfg.push(`    PROGRAM ${p} WITH ${t.name} : ${p};`);
  cfg.push("END_RESOURCE", "END_CONFIGURATION");
  files.push({ path: "src/Configuration.st", text: cfg.join("\n") + "\n", map: cfg.map(() => null) });

  return { files, hashes, tasks: composedTasks, clockTask: clock.name, cycleMs: clock.intervalMs, harnessLine0, addresses, notes, warnings, enums: enumNames, tests };
}

/** Map a CODESYS object line to a mirror file and 0-based line. */
export function toMirror(files: Pick<MirrorFile, "path" | "map">[], obj: string, line: number, part: "decl" | "impl" = "impl"): { path: string; line0: number } | undefined {
  const key = obj.toLowerCase();
  for (const f of files) {
    const i = f.map.findIndex((o) => o !== null && o.obj.toLowerCase() === key && o.part === part && o.line === line);
    if (i >= 0) return { path: f.path, line0: i };
  }
  return undefined;
}

/** Map a mirror file and 0-based line back to its CODESYS origin. */
export function fromMirror(files: Pick<MirrorFile, "path" | "map">[], path: string, line0: number): LineOrigin | undefined {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  const f = files.find((x) => x.path.toLowerCase() === norm || norm.endsWith("/" + x.path.toLowerCase()));
  return f?.map[line0] ?? undefined;
}

/** Line count of an object part in the mirror (to validate breakpoint lines). */
export function partLines(files: Pick<MirrorFile, "map">[], obj: string, part: "decl" | "impl"): number {
  const key = obj.toLowerCase();
  let n = 0;
  for (const f of files) for (const o of f.map) if (o && o.obj.toLowerCase() === key && o.part === part) n = Math.max(n, o.line);
  return n;
}
