/**
 * Project outline for the model: what exists, how to call it, and what runs
 * it, without reading every object. Built from the CODESYS export (all ST
 * text in one call) and the task list.
 */
import type { TreeNode } from "./st.js";
import { parseDeclaration, signature, type ParsedDecl, type VarDecl } from "./decl.js";

export interface OutlineTask {
  name: string;
  interval?: string | null;
  interval_unit?: string | null;
  priority?: string | null;
  kind?: string | null;
  pous: string[];
}

const TOP_KINDS = new Set(["pou", "dut", "gvl", "interface"]);
const SECTION_LABEL: Record<string, string> = {
  VAR_INPUT: "in",
  VAR_OUTPUT: "out",
  VAR_IN_OUT: "in_out",
  VAR: "var",
  VAR_TEMP: "temp",
  VAR_STAT: "stat",
  VAR_INST: "inst",
  VAR_GLOBAL: "global",
  VAR_EXTERNAL: "external",
  VAR_CONFIG: "config",
};

function intervalText(t: OutlineTask): string {
  if (!t.interval) return t.kind ?? "";
  return `${t.interval}${t.interval_unit && !/[a-z]/i.test(t.interval) ? ` ${t.interval_unit}` : ""}`;
}

const varText = (v: VarDecl, withComment = true) =>
  `${v.name}${v.at ? ` AT ${v.at}` : ""} : ${v.type}${v.init !== undefined ? ` := ${v.init}` : ""}${withComment && v.comment ? ` // ${v.comment}` : ""}`;

export interface OutlineOptions {
  /** An object or folder path: details for an object, an overview of a folder. */
  path?: string;
  /** Max lines of output (default 400). */
  maxLines?: number;
}

export function buildOutline(nodes: TreeNode[], tasks: OutlineTask[], o: OutlineOptions = {}): string {
  const byPath = new Map(nodes.map((n) => [n.path.toLowerCase(), n] as const));
  const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const kids = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    const p = parentOf(n.path).toLowerCase();
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(n);
  }
  const childrenOf = (n: TreeNode, ...kinds: string[]) => (kids.get(n.path.toLowerCase()) ?? []).filter((c) => !kinds.length || kinds.includes(c.kind));
  const isContainer = (p: string) => p === "" || byPath.get(p.toLowerCase())?.kind === "folder";
  const tops = nodes.filter((n) => TOP_KINDS.has(n.kind) && isContainer(parentOf(n.path)));
  const parsed = new Map<string, ParsedDecl>();
  const parse = (n: TreeNode) => {
    let p = parsed.get(n.path);
    if (!p) {
      p = parseDeclaration(n.declaration);
      parsed.set(n.path, p);
    }
    return p;
  };
  const runBy = new Map<string, string[]>();
  for (const t of tasks) for (const pou of t.pous) {
    const k = pou.split(".").pop()!.toLowerCase();
    runBy.set(k, [...(runBy.get(k) ?? []), `${t.name} ${intervalText(t)}`.trim()]);
  }
  const isTest = (n: TreeNode) => parse(n).header.attributes.some((a) => a.toLowerCase() === "test");

  // ---- one object, in detail
  const detail = (n: TreeNode): string[] => {
    const p = parse(n);
    const h = p.header;
    const out: string[] = [];
    const head = [n.path, kindText(n, p)];
    const run = runBy.get(n.name.toLowerCase());
    if (run) head.push(`run by ${run.join(", ")}`);
    out.push(head.join("  "));
    if (n.st === false) out.push("  (graphical body: not ST)");
    if (h.attributes.length) out.push(`  attributes: ${h.attributes.join(", ")}`);
    if (p.dutKind === "enum") out.push(`  members: ${p.enumMembers!.map((m) => (m.value !== undefined ? `${m.name} := ${m.value}` : m.name)).join(", ")}${p.baseType ? `  (base ${p.baseType})` : ""}`);
    if (p.dutKind === "alias") out.push(`  = ${p.baseType}`);
    for (const f of p.fields ?? []) out.push(`  ${varText(f)}`);
    let section = "";
    for (const v of p.vars) {
      if (v.section !== section) {
        section = v.section;
        out.push(`  ${SECTION_LABEL[v.section] ?? v.section}${v.constant ? " constant" : ""}${v.retain ? " retain" : ""}${v.persistent ? " persistent" : ""}:`);
      }
      out.push(`    ${varText(v)}`);
    }
    for (const m of childrenOf(n, "method", "interface_method")) {
      const mp = parse(m);
      const locals = mp.vars.filter((v) => !["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"].includes(v.section)).length;
      out.push(`  method ${[...mp.header.modifiers, ""].join(" ")}${signature(mp, m.name)}${locals ? `  (${locals} local${locals > 1 ? "s" : ""})` : ""}`);
    }
    for (const pr of childrenOf(n, "property")) {
      const pp = parse(pr);
      const acc = childrenOf(pr, "accessor").map((a) => a.name.toLowerCase());
      out.push(`  property ${[...pp.header.modifiers, ""].join(" ")}${pr.name} : ${pp.header.returnType ?? "?"} (${acc.join(", ") || "no accessors"})`);
    }
    for (const a of childrenOf(n, "action")) out.push(`  action ${a.name}${a.st === false ? " [non-ST]" : ""}`);
    const lines = (n.implementation ?? "").replace(/\s+$/, "").split("\n").filter((l) => l.trim()).length;
    if (n.kind === "pou") out.push(`  implementation: ${lines} line(s)`);
    return out;
  };

  // ---- overview line(s) for one object
  const brief = (n: TreeNode): string[] => {
    const p = parse(n);
    const run = runBy.get(n.name.toLowerCase());
    const tags = [kindText(n, p), run ? `[${run.join(", ")}]` : "", n.st === false ? "[non-ST]" : ""].filter(Boolean).join(" ");
    const out = [`${n.path}  ${tags}`];
    if (n.kind === "pou" && !isTest(n)) {
      const ins = p.vars.filter((v) => v.section === "VAR_INPUT" || v.section === "VAR_IN_OUT");
      const outs = p.vars.filter((v) => v.section === "VAR_OUTPUT");
      if (ins.length) out.push(`  in: ${ins.map((v) => varText(v, false)).join("; ")}`);
      if (outs.length) out.push(`  out: ${outs.map((v) => varText(v, false)).join("; ")}`);
      const ms = childrenOf(n, "method").map((m) => signature(parse(m), m.name));
      if (ms.length) out.push(`  methods: ${ms.join("; ")}`);
      const ps = childrenOf(n, "property").map((pr) => {
        const acc = childrenOf(pr, "accessor").map((a) => a.name.toLowerCase());
        return `${pr.name} : ${parse(pr).header.returnType ?? "?"}${acc.length === 1 ? ` (${acc[0]} only)` : ""}`;
      });
      if (ps.length) out.push(`  properties: ${ps.join("; ")}`);
      const as = childrenOf(n, "action").map((a) => a.name);
      if (as.length) out.push(`  actions: ${as.join(", ")}`);
    } else if (n.kind === "interface") {
      const ms = childrenOf(n, "interface_method", "method").map((m) => signature(parse(m), m.name));
      if (ms.length) out.push(`  methods: ${ms.join("; ")}`);
    } else if (n.kind === "dut" && p.fields?.length) {
      out.push(`  fields: ${p.fields.slice(0, 12).map((f) => `${f.name} : ${f.type}`).join("; ")}${p.fields.length > 12 ? `; ... (${p.fields.length})` : ""}`);
    }
    return out;
  };

  const max = o.maxLines ?? 400;
  const clip = (lines: string[], hint: string) => (lines.length > max ? [...lines.slice(0, max), `... ${lines.length - max} more line(s). ${hint}`] : lines);

  if (o.path) {
    const target = byPath.get(o.path.replace(/^\/+/, "").toLowerCase());
    if (!target) {
      const close = nodes.filter((n) => n.name.toLowerCase() === o.path!.split("/").pop()!.toLowerCase()).map((n) => n.path);
      return `No object '${o.path}'.${close.length ? ` Did you mean: ${close.join(", ")}?` : ""}`;
    }
    if (target.kind === "folder") {
      const inside = tops.filter((t) => t.path.toLowerCase().startsWith(target.path.toLowerCase() + "/"));
      return clip([`${target.path}/  (${inside.length} object(s))`, ...inside.flatMap(brief)], "Ask for one object for details.").join("\n");
    }
    const top = TOP_KINDS.has(target.kind) ? target : undefined;
    if (top) return clip(detail(top), "").join("\n");
    // a method, property or action: its own declaration
    const p = parse(target);
    return clip([`${target.path}  ${target.kind}`, ...p.vars.map((v) => `  ${SECTION_LABEL[v.section] ?? v.section}: ${varText(v)}`), ...(p.header.returnType ? [`  returns ${p.header.returnType}`] : [])], "").join("\n");
  }

  const count = (pred: (n: TreeNode) => boolean) => tops.filter(pred).length;
  const tests = tops.filter((n) => n.kind === "pou" && isTest(n));
  const header = [
    `Outline: ${count((n) => n.kind === "pou" && !isTest(n))} POU(s), ${count((n) => n.kind === "gvl")} GVL(s), ${count((n) => n.kind === "dut")} DUT(s), ${count((n) => n.kind === "interface")} interface(s)${tests.length ? `, ${tests.length} test(s)` : ""}.`,
    `Tasks: ${tasks.length ? tasks.map((t) => `${t.name} (${intervalText(t)}${t.priority ? `, prio ${t.priority}` : ""}) -> ${t.pous.join(", ") || "nothing"}`).join("; ") : "none"}`,
  ];
  const order = (n: TreeNode) => (isTest(n) ? 9 : n.kind === "pou" ? (n.sub === "program" ? 0 : n.sub === "function_block" ? 1 : 2) : n.kind === "interface" ? 3 : n.kind === "dut" ? 4 : 5);
  const sorted = [...tops].sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path));
  const body = sorted.filter((n) => !isTest(n)).flatMap(brief);
  if (tests.length) body.push(`tests: ${tests.map((t) => t.path).join(", ")}`);
  return clip([...header, ...body], "Pass path (an object or folder) to narrow it.").join("\n");
}

function kindText(n: TreeNode, p: ParsedDecl): string {
  const h = p.header;
  const mods = h.modifiers.length ? `${h.modifiers.join(" ")} ` : "";
  if (n.kind === "pou") {
    if (h.attributes.some((a) => a.toLowerCase() === "test")) return "TEST";
    const kw = h.keyword || (n.sub ?? "").toUpperCase();
    let s = `${mods}${kw}`;
    if (h.returnType) s += ` : ${h.returnType}`;
    if (h.extends?.length) s += ` EXTENDS ${h.extends.join(", ")}`;
    if (h.implements?.length) s += ` IMPLEMENTS ${h.implements.join(", ")}`;
    return s;
  }
  if (n.kind === "interface") {
    const bases = (h.extends ?? []).filter((b) => !/^__System\.IQueryInterface$/i.test(b));
    return `INTERFACE${bases.length ? ` EXTENDS ${bases.join(", ")}` : ""}`;
  }
  if (n.kind === "gvl") {
    const q = h.attributes.some((a) => a.toLowerCase() === "qualified_only");
    return `GVL (${p.vars.length} var${p.vars.length === 1 ? "" : "s"}${q ? ", qualified_only" : ""})`;
  }
  if (n.kind === "dut") {
    if (p.dutKind === "enum") return `ENUM (${p.enumMembers!.map((m) => (m.value !== undefined ? `${m.name}=${m.value}` : m.name)).join(", ")})`;
    if (p.dutKind === "alias") return `ALIAS = ${p.baseType}`;
    return `${(p.dutKind ?? "dut").toUpperCase()}${p.fields ? ` (${p.fields.length} field${p.fields.length === 1 ? "" : "s"})` : ""}`;
  }
  return n.kind;
}

export interface IoEntry {
  owner: string;
  name: string;
  at: string;
  type: string;
  direction: "input" | "output" | "memory";
  comment?: string;
  placeholder: boolean;
}

/** Variables with AT addresses (including the %I* and %Q* placeholders), from GVLs and POUs. */
export function ioList(nodes: TreeNode[]): IoEntry[] {
  const out: IoEntry[] = [];
  for (const n of nodes) {
    if (!["gvl", "pou"].includes(n.kind)) continue;
    for (const v of parseDeclaration(n.declaration).vars) {
      if (!v.at) continue;
      const area = /^%([IQM])/i.exec(v.at)?.[1]?.toUpperCase();
      out.push({
        owner: n.path,
        name: v.name,
        at: v.at,
        type: v.type,
        direction: area === "I" ? "input" : area === "Q" ? "output" : "memory",
        ...(v.comment ? { comment: v.comment } : {}),
        placeholder: /\*$/.test(v.at),
      });
    }
  }
  return out;
}
