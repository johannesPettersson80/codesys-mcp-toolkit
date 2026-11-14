/**
 * Ladder, FBD and SFC bodies read back as the description create_graphical
 * takes, so the model can understand a graphical POU and edit it (change the
 * description, create it again with replace). Works on the PLCopenXML CODESYS
 * exports (checked against SP22's own export) and on create_graphical's.
 *
 * LD: every coil's power flow is followed back to the rail: contacts in series
 * become {and}, parallel paths {or}. FBD: each output variable (or output
 * written straight on a block) is followed back through blocks to the inputs.
 * SFC: steps, their actions and the transition to the next step. What has no
 * place in the description (function boxes in LD, SFC branches) is reported.
 */
import type { Fbd, Logic } from "./graphical.js";

interface El {
  name: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
}

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unesc = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, e: string) => (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]!));

/** A small XML reader for well-formed PLCopenXML: elements, attributes, text, CDATA. */
export function parseXml(xml: string): El {
  const root: El = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of xml.matchAll(re)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[6] !== undefined) top.text += unesc(m[6]);
    else if (m[3]) {
      if (m[2]) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs: Record<string, string> = {};
      for (const a of m[4]!.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!.replace(/^.*:/, "")] = unesc(a[2] ?? a[3] ?? "");
      const el: El = { name: m[3].replace(/^.*:/, ""), attrs, children: [], text: "" };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  return root;
}

const kids = (e: El | undefined, name: string) => (e?.children ?? []).filter((c) => c.name === name);
const kid = (e: El | undefined, name: string) => (e?.children ?? []).find((c) => c.name === name);
const find = (e: El, name: string): El | undefined => (e.name === name ? e : e.children.reduce<El | undefined>((f, c) => f ?? find(c, name), undefined));
const allText = (e: El | undefined): string => (e ? e.text + e.children.map(allText).join("") : "");
/** The connections of an element's (first) connectionPointIn. */
const inputsOf = (e: El | undefined): { ref: string; param?: string }[] => kids(kid(e, "connectionPointIn"), "connection").map((c) => ({ ref: c.attrs.refLocalId!, ...(c.attrs.formalParameter ? { param: c.attrs.formalParameter } : {}) }));

export type GraphicalDescription =
  | { kind: "ladder"; spec: { rungs: { when: Logic; then: { coil: string; kind: "coil" | "set" | "reset" | "negated" }[] }[] }; notes: string[] }
  | { kind: "fbd"; spec: { networks: { expr: Fbd; to?: string; assign?: Record<string, string> }[] }; notes: string[] }
  | { kind: "sfc"; spec: { steps: { name: string; initial?: boolean; actions?: { name: string; qualifier: string; st: string }[]; next: string; when: string }[] }; notes: string[] };

/** A graphical POU's PLCopenXML as create_graphical's description; undefined when the body isn't LD, FBD or SFC. */
export function describeGraphical(xml: string): GraphicalDescription | undefined {
  const doc = parseXml(xml);
  const pou = find(doc, "pou");
  const body = kid(pou, "body") ?? find(doc, "body");
  if (!body) return undefined;
  const ld = kid(body, "LD");
  if (ld) return readLadder(ld);
  const fbd = kid(body, "FBD");
  if (fbd) return readFbd(fbd);
  const sfc = kid(body, "SFC");
  if (sfc) return readSfc(sfc, pou);
  return undefined;
}

function readLadder(ld: El): GraphicalDescription {
  const notes = new Set<string>();
  const byId = new Map(ld.children.filter((c) => c.attrs.localId !== undefined).map((c) => [c.attrs.localId!, c] as const));
  const memo = new Map<string, Logic | null>();
  const and = (parts: (Logic | null)[]): Logic | null => {
    const flat = parts.flatMap((p) => (p === null ? [] : typeof p === "object" && "and" in p ? p.and : [p]));
    return flat.length === 0 ? null : flat.length === 1 ? flat[0]! : { and: flat };
  };
  /** The condition at an element's output (null = straight from the rail, always TRUE). */
  const flow = (ref: string, seen = new Set<string>()): Logic | null => {
    if (memo.has(ref)) return memo.get(ref)!;
    const e = byId.get(ref);
    if (!e || seen.has(ref)) return null;
    seen.add(ref);
    let out: Logic | null;
    if (e.name === "leftPowerRail") out = null;
    else if (e.name === "contact" || e.name === "coil") {
      const left = into(e, seen);
      if (e.name === "coil") out = left; // power passes through a coil to the next one
      else out = and([left, `${e.attrs.negated === "true" ? "NOT " : ""}${allText(kid(e, "variable")).trim()}`]);
    } else {
      notes.add(`${e.name}${e.attrs.typeName ? ` ${e.attrs.typeName}` : ""} elements (function boxes in a rung) aren't part of the description; read_objects shows the XML`);
      out = into(e, seen);
    }
    memo.set(ref, out);
    return out;
  };
  const into = (e: El, seen: Set<string>): Logic | null => {
    const ins = inputsOf(e).map((c) => flow(c.ref, seen));
    if (ins.length <= 1) return ins[0] ?? null;
    if (ins.some((x) => x === null)) return null; // a path straight from the rail: always TRUE
    return { or: ins as Logic[] };
  };
  const rungs: { when: Logic; then: { coil: string; kind: "coil" | "set" | "reset" | "negated" }[] }[] = [];
  for (const c of ld.children.filter((x) => x.name === "coil")) {
    const when = into(c, new Set()) ?? "TRUE";
    const kind = c.attrs.storage === "set" ? "set" : c.attrs.storage === "reset" ? "reset" : c.attrs.negated === "true" ? "negated" : "coil";
    const coil = { coil: allText(kid(c, "variable")).trim(), kind } as const;
    const last = rungs[rungs.length - 1];
    if (last && JSON.stringify(last.when) === JSON.stringify(when)) last.then.push(coil);
    else rungs.push({ when, then: [coil] });
  }
  return { kind: "ladder", spec: { rungs }, notes: [...notes] };
}

function readFbd(fbd: El): GraphicalDescription {
  const notes = new Set<string>();
  const byId = new Map(fbd.children.filter((c) => c.attrs.localId !== undefined).map((c) => [c.attrs.localId!, c] as const));
  const consumed = new Set<string>();
  const build = (ref: string, param?: string): Fbd => {
    const e = byId.get(ref);
    if (!e) return "?";
    consumed.add(ref);
    if (e.name === "inVariable" || e.name === "inOutVariable") return allText(kid(e, "expression")).trim();
    if (e.name !== "block") {
      notes.add(`${e.name} elements aren't part of the description`);
      return "?";
    }
    const ins = kids(kid(e, "inputVariables"), "variable").map((v) => ({ name: v.attrs.formalParameter!, src: inputsOf(v)[0] }));
    const arg = (x: { src?: { ref: string; param?: string } }) => (x.src ? build(x.src.ref, x.src.param) : "?");
    if (!e.attrs.instanceName) return { fn: e.attrs.typeName!, args: ins.map(arg) };
    return { fb: e.attrs.typeName!, instance: e.attrs.instanceName, inputs: Object.fromEntries(ins.filter((x) => x.src).map((x) => [x.name, arg(x)])), output: param ?? "Q" };
  };
  type Net = { expr: Fbd; to?: string; assign?: Record<string, string> };
  const nets: Net[] = [];
  const fbNets = new Map<string, { block: El; outs: Record<string, string> }>();
  const order: (string | Net)[] = [];
  for (const e of fbd.children) {
    if (e.name === "outVariable" || e.name === "inOutVariable") {
      const src = inputsOf(e)[0];
      if (!src) continue;
      const target = allText(kid(e, "expression")).trim();
      const s = byId.get(src.ref);
      if (s?.name === "block" && s.attrs.instanceName) {
        const n = fbNets.get(src.ref) ?? { block: s, outs: {} };
        n.outs[src.param ?? "Q"] = target;
        if (!fbNets.has(src.ref)) (fbNets.set(src.ref, n), order.push(src.ref));
      } else order.push({ expr: build(src.ref, src.param), to: target });
    } else if (e.name === "block" && e.attrs.instanceName) {
      // Outputs written straight on the block (CODESYS's "output assignment").
      for (const v of kids(kid(e, "outputVariables"), "variable")) {
        const target = allText(kid(kid(v, "connectionPointOut"), "expression")).trim();
        if (!target) continue;
        const n = fbNets.get(e.attrs.localId!) ?? { block: e, outs: {} };
        n.outs[v.attrs.formalParameter!] = target;
        if (!fbNets.has(e.attrs.localId!)) (fbNets.set(e.attrs.localId!, n), order.push(e.attrs.localId!));
      }
    }
  }
  for (const o of order) {
    if (typeof o !== "string") {
      nets.push(o);
      continue;
    }
    const n = fbNets.get(o)!;
    const output = "Q" in n.outs ? "Q" : Object.keys(n.outs)[0]!;
    const { [output]: to, ...assign } = n.outs;
    const expr = build(o, output);
    nets.push({ expr, ...(to ? { to } : {}), ...(Object.keys(assign).length ? { assign } : {}) });
  }
  // Function block calls whose outputs nothing uses.
  for (const e of fbd.children) if (e.name === "block" && e.attrs.instanceName && !consumed.has(e.attrs.localId!) && !fbNets.has(e.attrs.localId!)) nets.push({ expr: build(e.attrs.localId!) });
  return { kind: "fbd", spec: { networks: nets }, notes: [...notes] };
}

function readSfc(sfc: El, pou: El | undefined): GraphicalDescription {
  const notes = new Set<string>();
  const byId = new Map(sfc.children.filter((c) => c.attrs.localId !== undefined).map((c) => [c.attrs.localId!, c] as const));
  const bodies = new Map(kids(kid(pou, "actions"), "action").map((a) => [a.attrs.name!, allText(find(a, "xhtml") ?? find(a, "ST")).trim()] as const));
  for (const e of sfc.children) if (/Divergence|Convergence/.test(e.name)) notes.add(`${e.name} (a branch): the description holds one sequence; read_objects shows the XML`);
  const after = (ref: string) => sfc.children.filter((c) => inputsOf(c).some((i) => i.ref === ref));
  const steps = sfc.children
    .filter((c) => c.name === "step")
    .map((s) => {
      const id = s.attrs.localId!;
      const acts = after(id)
        .filter((c) => c.name === "actionBlock")
        .flatMap((b) => kids(b, "action").map((a) => {
          const name = kid(a, "reference")?.attrs.name ?? "";
          const inline = allText(find(a, "xhtml")).trim();
          return { name, qualifier: a.attrs.qualifier ?? "N", st: bodies.get(name) ?? inline };
        }));
      const tr = after(id).find((c) => c.name === "transition");
      let when = "";
      let next = "";
      if (tr) {
        const cond = kid(tr, "condition");
        const src = inputsOf(cond)[0];
        when = src ? allText(kid(byId.get(src.ref), "expression")).trim() : allText(find(cond ?? tr, "xhtml")).trim() || (kid(cond, "reference")?.attrs.name ?? "");
        const to = after(tr.attrs.localId!)[0];
        next = to?.name === "step" ? to.attrs.name! : to?.name === "jumpStep" ? to.attrs.targetName! : "";
        if (!to || !next) notes.add(`the transition after step ${s.attrs.name} leads into a branch`);
      }
      return { name: s.attrs.name!, ...(s.attrs.initialStep === "true" ? { initial: true } : {}), ...(acts.length ? { actions: acts } : {}), next, when };
    });
  return { kind: "sfc", spec: { steps }, notes: [...notes] };
}
