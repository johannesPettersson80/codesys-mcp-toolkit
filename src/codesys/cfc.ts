/**
 * CFC as elements and wires, optionally on pages (CODESYS's page-oriented CFC), with
 * positions: the description create_graphical takes in `cfc: {pages?, elements, wires}`
 * and read_objects gives back, so a chart keeps its layout when it is edited.
 *
 * The PLCopenXML follows what CODESYS V3.5 SP21 imports and exports (learned by import,
 * export back, build and the editor): `<CFC page-oriented="true">`; a page is a
 * vendorElement with `cfcpage` data; every element names its page and area in `cfcpageinfo`
 * (positions count from the page's corner); every wire runs through an unnamed connector
 * that names the source's output; a connection mark is a vendorElement typed
 * sourceConnectionMark / sinkConnectionMark whose one pin carries the mark's name.
 */
import * as z from "zod/v4";
import { CFC_DATA, esc, OPERATORS, wrap } from "./plcopen.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const CFC_AREAS = ["left", "right", "content", "content-left", "content-right"] as const;
export type CfcArea = (typeof CFC_AREAS)[number];
const XML_AREA: Record<CfcArea, string> = { left: "leftmargin", right: "rightmargin", content: "content", "content-left": "contentleft", "content-right": "contentright" };

/** CODESYS's default page (SP21): 72 x 96 grid units, margins 12 wide. */
export const CFC_PAGE = { width: 72, height: 96, margin: 12 };

const grid = z.number().int().min(0);
export const cfcElementSchema = z.object({
  id: z.string().regex(IDENT).describe("Name the wires use for this element"),
  box: z.string().min(1).optional().describe("A box: a function block type (give instance), or a function or operator (AND, ADD, GT, SEL, MOVE, ...)"),
  instance: z.string().regex(IDENT).optional().describe("The function block instance, declared in the declaration"),
  input: z.string().min(1).optional().describe("An input element: the variable or literal it reads, e.g. 'xStart', 'T#2S', '42'"),
  output: z.string().min(1).optional().describe("An output element: the variable it writes"),
  mark: z.string().regex(IDENT).optional().describe("A connection mark: a wire goes into the source mark, wires come out of the sink marks of the same name (also on other pages)"),
  comment: z.string().optional().describe("A comment text"),
  width: grid.optional().describe("Comment width"),
  height: grid.optional().describe("Comment height"),
  page: z.number().int().min(1).optional().describe("Page number, from 1 (with pages)"),
  area: z.enum(CFC_AREAS).optional().describe("With pages: left margin, right margin or content. Default: inputs and sink marks left, outputs and source marks right, the rest content"),
  x: grid.optional().describe("Grid position; on a page it counts from the page's left edge. Left out: placed automatically"),
  y: grid.optional().describe("Grid position; on a page from its top"),
});
export type CfcElement = z.infer<typeof cfcElementSchema>;

export const cfcChartSchema = z.object({
  pages: z
    .array(
      z.object({
        name: z.string().optional(),
        description: z.string().optional(),
        width: z.number().int().min(24).optional().describe(`Default ${CFC_PAGE.width}`),
        height: z.number().int().min(24).optional().describe(`Default ${CFC_PAGE.height}`),
        margin: z.number().int().min(4).optional().describe(`Width of the left and right margins, default ${CFC_PAGE.margin}`),
      }),
    )
    .min(1)
    .optional()
    .describe("Makes it a page-oriented CFC: each page has a left margin for inputs, a right margin for outputs and the content between"),
  elements: z.array(cfcElementSchema).min(1).describe("Boxes, outputs and source marks run in the order listed"),
  wires: z
    .array(
      z.object({
        from: z.string().describe("'xStart' (an input or sink mark), 'tonDelay.Q' (a function block output), 'and1' (a function's result)"),
        to: z.string().describe("'tonDelay.IN' (a box input; a function's are In1, In2, ...), 'out1' (an output or source mark)"),
      }),
    )
    .default([]),
});
export type CfcChart = z.input<typeof cfcChartSchema>;

type Kind = "box" | "input" | "output" | "mark" | "comment";
const KINDS: Kind[] = ["box", "input", "output", "mark", "comment"];

export interface CfcNode {
  e: CfcElement;
  kind: Kind;
  fb: boolean;
  /** Box input pins in order (a function's In1..In<n>), and output pins (a function's result is ""). */
  ins: string[];
  outs: string[];
  dir?: "source" | "sink";
  page?: number;
  area?: CfcArea;
  x: number;
  y: number;
}
export interface CfcWire {
  from: CfcNode;
  fromPin: string;
  to: CfcNode;
  toPin: string;
}
export interface CfcPlan {
  pages?: { name: string; description: string; width: number; height: number; margin: number }[];
  nodes: CfcNode[];
  wires: CfcWire[];
}

const fnPin = (p: string) => /^in(\d+)$/i.exec(p)?.[1];

/** Checks a chart and resolves it: kinds, pins, mark directions, pages and positions. Throws with every problem found. */
export function planCfc(chart: CfcChart): CfcPlan {
  const problems: string[] = [];
  const pages = chart.pages?.map((p) => ({ name: p.name ?? "", description: p.description ?? "", width: p.width ?? CFC_PAGE.width, height: p.height ?? CFC_PAGE.height, margin: p.margin ?? CFC_PAGE.margin }));
  const nodes: CfcNode[] = [];
  const byId = new Map<string, CfcNode>();
  for (const e of chart.elements) {
    const kinds = KINDS.filter((k) => e[k] !== undefined);
    if (kinds.length !== 1) {
      problems.push(`element ${e.id} must be exactly one of box, input, output, mark or comment${kinds.length ? ` (it has ${kinds.join(" and ")})` : ""}`);
      continue;
    }
    if (byId.has(e.id.toLowerCase())) problems.push(`element id ${e.id} is used twice`);
    const kind = kinds[0]!;
    if (e.instance && kind !== "box") problems.push(`element ${e.id}: only a box has an instance`);
    if (!pages && (e.page !== undefined || e.area !== undefined)) problems.push(`element ${e.id} names a page or area, but the chart has no pages`);
    if (pages && e.page !== undefined && e.page > pages.length) problems.push(`element ${e.id} is on page ${e.page}, but there are ${pages.length} page${pages.length === 1 ? "" : "s"}`);
    const n: CfcNode = { e, kind, fb: kind === "box" && !!e.instance, ins: [], outs: [], x: -1, y: -1 };
    if (pages) {
      n.page = e.page ?? 1;
      n.area = e.area ?? (kind === "input" ? "left" : kind === "output" ? "right" : "content");
    }
    nodes.push(n);
    byId.set(e.id.toLowerCase(), n);
  }

  const wires: CfcWire[] = [];
  const end = (s: string, side: "from" | "to"): { n: CfcNode; pin: string } | undefined => {
    const dot = s.indexOf(".");
    const id = (dot < 0 ? s : s.slice(0, dot)).trim();
    let pin = dot < 0 ? "" : s.slice(dot + 1).trim();
    const n = byId.get(id.toLowerCase());
    if (!n) {
      problems.push(`wire ${side} '${s}': there is no element ${id}`);
      return undefined;
    }
    if (n.kind === "comment") {
      problems.push(`wire ${side} '${s}': a comment has no pins`);
      return undefined;
    }
    if (n.kind === "box") {
      if (side === "from") {
        if (!n.fb) pin = ""; // a function or operator has one result
        else pin ||= "Q";
      } else {
        if (!pin) {
          problems.push(`wire to '${s}': name the box input, e.g. '${id}.${n.fb ? "IN" : "In1"}'`);
          return undefined;
        }
        if (!n.fb) {
          const k = fnPin(pin);
          if (!k) {
            problems.push(`wire to '${s}': a function's inputs are In1, In2, ...`);
            return undefined;
          }
          pin = `In${k}`;
        }
      }
    } else if (pin) {
      problems.push(`wire ${side} '${s}': ${n.kind === "mark" ? "a connection mark" : `an ${n.kind}`} has no named pins; write '${id}'`);
      return undefined;
    }
    if (n.kind === "input" && side === "to") problems.push(`wire to '${s}': an input element only gives a value`);
    if (n.kind === "output" && side === "from") problems.push(`wire from '${s}': an output element only takes a value`);
    return { n, pin };
  };
  for (const w of chart.wires ?? []) {
    const f = end(w.from, "from");
    const t = end(w.to, "to");
    if (f && t) wires.push({ from: f.n, fromPin: f.pin, to: t.n, toPin: t.pin });
  }

  // One driver per input pin, output element and source mark.
  const driven = new Map<string, number>();
  for (const w of wires) {
    const key = `${w.to.e.id.toLowerCase()}.${w.toPin}`;
    driven.set(key, (driven.get(key) ?? 0) + 1);
  }
  for (const [key, count] of driven) if (count > 1) problems.push(`${key.replace(/\.$/, "")} has ${count} wires going into it; an input takes one`);

  for (const n of nodes) {
    const into = wires.filter((w) => w.to === n);
    const outOf = wires.filter((w) => w.from === n);
    if (n.kind === "output" && into.length === 0) problems.push(`output ${n.e.id} (${n.e.output}) has no wire going into it`);
    if (n.kind === "mark") {
      if (into.length === 1 && outOf.length === 0) n.dir = "source";
      else if (into.length === 0 && outOf.length > 0) n.dir = "sink";
      else problems.push(`connection mark ${n.e.id} needs either one wire going in (a source) or wires going out (a sink)`);
      if (pages && n.e.area === undefined) n.area = n.dir === "sink" ? "left" : "right";
    }
    if (n.kind === "box") {
      if (n.fb) {
        n.ins = [...new Set(into.map((w) => w.toPin))];
        n.outs = [...new Set(outOf.map((w) => w.fromPin))];
        if (!n.outs.length) n.outs = ["Q"];
      } else {
        const ks = into.map((w) => Number(fnPin(w.toPin)));
        const max = Math.max(0, ...ks);
        for (let k = 1; k <= max; k++) if (!ks.includes(k)) problems.push(`${n.e.id}.In${k} has no wire; a function's inputs In1..In${max} all need one`);
        n.ins = Array.from({ length: max }, (_, k) => `In${k + 1}`);
        n.outs = [""];
        if (!max) problems.push(`box ${n.e.id} (${n.e.box}) has no inputs wired${/^[A-Z]/.test(n.e.box!) && !OPERATORS.has(n.e.box!.toUpperCase()) ? "; a function block needs an instance" : ""}`);
      }
    }
  }
  const sources = new Map<string, number>();
  for (const n of nodes) if (n.dir === "source") sources.set(n.e.mark!.toLowerCase(), (sources.get(n.e.mark!.toLowerCase()) ?? 0) + 1);
  for (const [name, count] of sources) if (count > 1) problems.push(`connection mark ${name} has ${count} sources; it can have one`);
  for (const n of nodes) if (n.dir === "sink" && !sources.has(n.e.mark!.toLowerCase())) problems.push(`connection mark ${n.e.id} (${n.e.mark}) has no source mark of that name`);

  if (problems.length) throw new Error(`The CFC description has problems:\n- ${problems.join("\n- ")}`);
  layout(nodes, wires, pages);
  return { ...(pages ? { pages } : {}), nodes, wires };
}

/**
 * Where a box's first pin is below its y (CODESYS SP21's editor): a function block has its
 * instance name and then its type above the pins (y + 2), a function or operator only its
 * name (y + 1).
 */
const firstPin = (n: CfcNode) => (n.fb ? 2 : 1);
/** Box height in grid units. */
const boxHeight = (n: CfcNode) => firstPin(n) + Math.max(n.ins.length, n.outs.length, 1);
/** Grid units between a signal placed next to a box and the box. */
const GAP = 3;
/** A grid unit in the CFC editor at 100 %, in pixels. */
const UNIT_PX = 16;
/**
 * Advance widths of Segoe UI 8.25 pt (the CFC editor's font) for ASCII 32..126, in tenths of a
 * pixel, measured with WinForms' TextRenderer, which draws the editor.
 */
const SEGOE = [32, 32, 42, 72, 62, 92, 47, 32, 32, 32, 52, 82, 32, 42, 32, 42, 62, 62, 62, 62, 62, 62, 62, 62, 62, 62, 32, 32, 82, 82, 82, 52, 112, 72, 72, 72, 82, 62, 62, 82, 82, 32, 42, 62, 52, 102, 82, 92, 62, 82, 72, 62, 52, 82, 72, 112, 62, 52, 62, 32, 42, 32, 82, 52, 32, 62, 72, 52, 72, 62, 42, 72, 72, 32, 32, 62, 32, 92, 72, 72, 72, 72, 42, 52, 42, 72, 52, 92, 52, 52, 52, 32, 32, 32, 82];
const textPx = (s: string) => [...s].reduce((w, ch) => {
  const c = ch.codePointAt(0)!;
  return w + (c >= 32 && c <= 126 ? SEGOE[c - 32]! / 10 : c >= 0x2e80 ? 12 : 7);
}, 0);
/**
 * The width CODESYS SP21 draws an input, output or mark at: its text plus a frame of about
 * 37 px, rounded up to whole grid units (fitted to the editor's own boxes: 'a' 3, 'xStart' 5,
 * 'T#250MS' 6, 'xEmergencyStop' 8, 'rTemperatureSetpoint' 10).
 */
export const signalWidth = (text: string) => Math.ceil((textPx(text) + 37) / UNIT_PX);
const textWidth = (n: CfcNode) => signalWidth(n.e.input ?? n.e.output ?? n.e.mark ?? "");
const longestPx = (pins: string[]) => Math.max(0, ...pins.map(textPx));
/** A box's width: its type name, or its widest input and output pin side by side (a TON is 4). */
const boxWidth = (n: CfcNode) => Math.max(4, Math.ceil((Math.max(textPx(n.e.box ?? ""), longestPx(n.ins) + longestPx(n.outs) + UNIT_PX) + 24) / UNIT_PX));
/** The grid row of a pin. */
const pinRow = (n: CfcNode, pin: string, side: "in" | "out") => (n.kind === "box" ? n.y + firstPin(n) + Math.max(0, (side === "in" ? n.ins : n.outs).indexOf(pin)) : n.y);

/**
 * Places what has no position: per page, boxes in columns by how many boxes feed them,
 * inputs and sink marks at the left level with the pin they feed, outputs and source marks
 * at the right level with their source, comments below.
 */
function layout(nodes: CfcNode[], wires: CfcWire[], pages: CfcPlan["pages"]): void {
  const groups = new Map<number, CfcNode[]>();
  for (const n of nodes) groups.set(n.page ?? 0, [...(groups.get(n.page ?? 0) ?? []), n]);
  for (const [page, group] of groups) {
    const p = page ? pages![page - 1]! : undefined;
    const left = p ? p.margin : 12;
    // Depth: boxes in the longest chain of boxes before it on this page (feedback ignored).
    const depth = new Map<CfcNode, number>();
    const visiting = new Set<CfcNode>();
    const depthOf = (n: CfcNode): number => {
      if (depth.has(n)) return depth.get(n)!;
      visiting.add(n);
      let d = 0;
      for (const w of wires) if (w.to === n && w.from.kind === "box" && w.from.page === n.page && !visiting.has(w.from)) d = Math.max(d, depthOf(w.from) + 1);
      visiting.delete(n);
      depth.set(n, d);
      return d;
    };
    const boxes = group.filter((n) => n.kind === "box");
    for (const b of boxes) depthOf(b);
    const maxDepth = Math.max(0, ...boxes.map((b) => depth.get(b)!));
    // Columns 18 apart, closer on a page so they fit its content area (a box is about 8 wide).
    const COL = p ? Math.max(10, Math.min(18, Math.floor((p.width - 2 * p.margin - 12) / Math.max(1, maxDepth)))) : 18;
    const colX = (d: number) => left + 4 + d * COL;
    const cursor = new Map<number, number>();
    const top = 4;
    // Column by column, so a box can line its input up with the box output feeding it.
    for (const b of [...boxes].sort((a, c) => depth.get(a)! - depth.get(c)!)) {
      const d = depth.get(b)!;
      b.x = b.e.x ?? colX(d);
      if (b.e.y === undefined) {
        const feed = wires.find((w) => w.to === b && w.from.kind === "box" && w.from.y >= 0 && w.from !== b);
        const want = feed ? pinRow(feed.from, feed.fromPin, "out") - firstPin(b) - Math.max(0, b.ins.indexOf(feed.toPin)) : top;
        b.y = Math.max(cursor.get(d) ?? top, want, top);
        // A wire from the left margin runs along its pin's row: keep that row clear of the boxes before this one.
        const fromMargin = b.ins.filter((pin) => wires.some((w) => w.to === b && w.toPin === pin && (w.from.kind === "input" || w.from.dir === "sink") && w.from.page === b.page));
        const before = boxes.filter((o) => o !== b && o.y >= 0 && depth.get(o)! < d);
        const blocked = () => fromMargin.some((pin) => before.some((o) => { const r = pinRow(b, pin, "in"); return r >= o.y && r < o.y + boxHeight(o); }));
        for (let k = 0; k < 60 && blocked(); k++) b.y++;
        cursor.set(d, b.y + boxHeight(b) + 2);
      } else b.y = b.e.y;
    }
    const used = new Map<string, Set<number>>();
    const freeRow = (col: string, want: number) => {
      const rows = used.get(col) ?? new Set<number>();
      used.set(col, rows);
      let y = Math.max(0, want);
      while (rows.has(y)) y++;
      rows.add(y);
      return y;
    };
    for (const n of group) if (n.kind !== "box" && n.e.y !== undefined) freeRow(n.kind === "input" || n.dir === "sink" ? "L" : "R", n.e.y);
    const inX = p ? 2 : 0;
    const outX = p ? p.width - p.margin + 2 : Math.max(colX(maxDepth + 1), ...boxes.map((b) => b.x + 14));
    let nextRow = top;
    // In a margin a signal stays at the margin; elsewhere (no pages, or the content area) it sits next to its box.
    const inMargin = (n: CfcNode) => n.area === "left" || n.area === "right";
    // Left: inputs and sink marks, level with the first pin they feed.
    for (const n of group.filter((n) => n.kind === "input" || n.dir === "sink")) {
      const w = wires.find((w) => w.from === n && w.to.y >= 0);
      const near = w && w.to.kind === "box" && !inMargin(n) ? Math.max(0, w.to.x - GAP - textWidth(n)) : undefined;
      n.x = n.e.x ?? near ?? inX;
      n.y = n.e.y ?? freeRow(near === undefined ? "L" : `L${w!.to.e.id}`, w ? pinRow(w.to, w.toPin, "in") : nextRow);
      nextRow = Math.max(nextRow, n.y + 2);
    }
    // Right: outputs and source marks, level with their source.
    for (const n of group.filter((n) => n.kind === "output" || n.dir === "source")) {
      const w = wires.find((w) => w.to === n);
      const near = w && w.from.kind === "box" && !inMargin(n) ? w.from.x + boxWidth(w.from) + GAP : undefined;
      n.x = n.e.x ?? near ?? outX;
      n.y = n.e.y ?? freeRow(near === undefined ? "R" : `R${w!.from.e.id}`, w && w.from.y >= 0 ? pinRow(w.from, w.fromPin, "out") : nextRow);
    }
    const bottom = Math.max(top, ...group.filter((n) => n.y >= 0).map((n) => n.y + (n.kind === "box" ? boxHeight(n) : 1)));
    let commentY = bottom + 2;
    for (const n of group.filter((n) => n.kind === "comment")) {
      n.x = n.e.x ?? left + 2;
      if (n.e.y === undefined) {
        n.y = commentY;
        commentY += (n.e.height ?? 2) + 1;
      } else n.y = n.e.y;
    }
  }
}

/** The chart as PLCopenXML for CODESYS's import (a page-oriented CFC when it has pages). */
export function cfcChartXml(name: string, pouType: "program" | "functionBlock", chart: CfcChart | CfcPlan): string {
  const plan = "nodes" in chart ? chart : planCfc(chart);
  const parts: string[] = [];
  const pageCount = plan.pages?.length ?? 0;
  plan.pages?.forEach((p, k) =>
    parts.push(
      `<vendorElement localId="${k}"><position x="0" y="0" /><alternativeText><xhtml xmlns="http://www.w3.org/1999/xhtml">page</xhtml></alternativeText><addData><data name="${CFC_DATA.page}" handleUnknown="implementation"><page name="${esc(p.name)}" description="${esc(p.description)}" marginwidth="${p.margin}" width="${p.width}" height="${p.height}" index="${k}" xmlns="" /></data></addData></vendorElement>`,
    ),
  );
  const idOf = new Map<CfcNode, number>();
  plan.nodes.forEach((n, k) => idOf.set(n, pageCount + k));
  let next = pageCount + plan.nodes.length;
  // One unnamed connector per wire, naming the source's output (an input's is its own text, a sink mark's its name).
  const connector = new Map<CfcWire, number>();
  for (const w of plan.wires) {
    const id = next++;
    connector.set(w, id);
    const param = w.from.kind === "input" ? w.from.e.input! : w.from.kind === "mark" ? w.from.e.mark! : w.fromPin;
    parts.push(`<connector localId="${id}" name=""><position x="0" y="0" /><connectionPointIn><connection refLocalId="${idOf.get(w.from)}" formalParameter="${esc(param)}" /></connectionPointIn></connector>`);
  }
  const into = (n: CfcNode, pin = "") => plan.wires.find((w) => w.to === n && w.toPin === pin);
  const ref = (w: CfcWire | undefined) => (w ? `<connection refLocalId="${connector.get(w)}" />` : "");
  const info = (n: CfcNode, more = "") => {
    const pi = n.page ? `<data name="${CFC_DATA.pageInfo}" handleUnknown="implementation"><pageInfo pageId="${n.page - 1}" pageArea="${XML_AREA[n.area!]}" xmlns="" /></data>` : "";
    return pi || more ? `<addData>${pi}${more}</addData>` : "";
  };
  const elementType = (t: string) => `<data name="${CFC_DATA.elementType}" handleUnknown="implementation"><ElementType xmlns="">${t}</ElementType></data>`;
  let order = 0;
  for (const n of plan.nodes) {
    const id = idOf.get(n)!;
    const at = `<position x="${n.x}" y="${n.y}" />`;
    const e = n.e;
    if (n.kind === "input") parts.push(`<inVariable localId="${id}">${at}<connectionPointOut><expression /></connectionPointOut><expression>${esc(e.input!)}</expression>${info(n)}</inVariable>`);
    else if (n.kind === "output") parts.push(`<outVariable localId="${id}" executionOrderId="${order++}">${at}<connectionPointIn>${ref(into(n))}</connectionPointIn><expression>${esc(e.output!)}</expression>${info(n)}</outVariable>`);
    else if (n.kind === "comment") {
      // As wide as its text, but inside the content area: CODESYS hatches a comment red that reaches into a margin.
      const page = n.page ? plan.pages![n.page - 1]! : undefined;
      const room = page && n.area === "content" ? page.width - page.margin - n.x - 1 : Infinity;
      const width = e.width ?? Math.max(6, Math.min(room, Math.ceil(textPx(e.comment!) / UNIT_PX) + 2));
      parts.push(`<comment localId="${id}" height="${e.height ?? 2}" width="${width}">${at}<content><xhtml xmlns="http://www.w3.org/1999/xhtml">${esc(e.comment!)}</xhtml></content>${info(n)}</comment>`);
    }
    else if (n.kind === "mark") {
      const nameText = `<alternativeText><xhtml xmlns="http://www.w3.org/1999/xhtml">${esc(e.mark!)}</xhtml></alternativeText>`;
      if (n.dir === "source")
        parts.push(`<vendorElement localId="${id}" executionOrderId="${order++}">${at}${nameText}<inputVariables><variable formalParameter="${esc(e.mark!)}"><connectionPointIn><relPosition x="0" y="0" />${ref(into(n))}</connectionPointIn></variable></inputVariables><inOutVariables /><outputVariables />${info(n, elementType("sourceConnectionMark"))}</vendorElement>`);
      else parts.push(`<vendorElement localId="${id}">${at}${nameText}<inputVariables /><inOutVariables /><outputVariables><variable formalParameter="${esc(e.mark!)}"><connectionPointOut><relPosition x="0" y="0" /><expression /></connectionPointOut></variable></outputVariables>${info(n, elementType("sinkConnectionMark"))}</vendorElement>`);
    } else {
      const op = !n.fb && OPERATORS.has(e.box!.toUpperCase());
      const type = op ? e.box!.toUpperCase() : e.box!;
      const kind = n.fb ? "functionblock" : op ? "operator" : "function";
      const callType = `<data name="${CFC_DATA.callType}" handleUnknown="implementation"><CallType xmlns="">${kind}</CallType></data>`;
      parts.push(
        `<block localId="${id}" executionOrderId="${order++}" typeName="${esc(type)}"${n.fb ? ` instanceName="${esc(e.instance!)}"` : ""}>${at}` +
          `<inputVariables>${n.ins.map((pin, i) => `<variable formalParameter="${esc(pin)}"><connectionPointIn><relPosition x="0" y="${i}" />${ref(into(n, pin))}</connectionPointIn></variable>`).join("")}</inputVariables><inOutVariables />` +
          `<outputVariables>${n.outs.map((pin, i) => `<variable formalParameter="${esc(pin)}"><connectionPointOut><relPosition x="0" y="${i}" /><expression /></connectionPointOut></variable>`).join("")}</outputVariables>${info(n, callType)}</block>`,
      );
    }
  }
  const head = plan.pages ? `<CFC page-oriented="true">` : "<CFC>";
  const body = `<ST><xhtml xmlns="http://www.w3.org/1999/xhtml" /></ST><addData><data name="${CFC_DATA.body}" handleUnknown="implementation">${head}${parts.join("\n")}</CFC></data></addData>`;
  return wrap(name, pouType, body);
}
