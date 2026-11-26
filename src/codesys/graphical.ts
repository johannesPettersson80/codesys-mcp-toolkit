/**
 * Ladder, FBD and SFC from a structured description, as PLCopenXML that
 * CODESYS imports (the rules were learned live: a connection lists every
 * source; SFC actions need relPosition before reference; every localId is
 * unique; transition conditions are connected inVariables; step outputs use
 * formalParameter "sfc"). The declaration is written as ST after the import.
 */
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import type { AppContext } from "../tools.js";
import { cfcChartSchema, cfcChartXml, planCfc } from "./cfc.js";
import { esc, OPERATORS, wrap } from "./plcopen.js";

/** A boolean expression for ladder: a variable ("xStart", "NOT xStop") or and/or of others. */
export type Logic = string | { and: Logic[] } | { or: Logic[] };
const logic: z.ZodType<Logic> = z.lazy(() => z.union([z.string().min(1), z.object({ and: z.array(logic).min(1) }), z.object({ or: z.array(logic).min(1) })]));

/** An FBD expression: a variable or literal, a function block, or a function such as AND, ADD, GT. */
export type Fbd = string | { fn: string; args: Fbd[] } | { fb: string; instance: string; inputs?: Record<string, Fbd>; output?: string };
const fbd: z.ZodType<Fbd> = z.lazy(() =>
  z.union([
    z.string().min(1),
    z.object({ fn: z.string().min(1), args: z.array(fbd).min(1) }),
    z.object({ fb: z.string().min(1), instance: z.string().min(1), inputs: z.record(z.string(), fbd).optional(), output: z.string().optional() }),
  ]),
);

export const ladderSchema = z.object({
  rungs: z
    .array(
      z.object({
        when: logic.describe("Contacts: 'xStart', 'NOT xStop', {and: [...]} in series, {or: [...]} in parallel"),
        then: z.array(z.object({ coil: z.string(), kind: z.enum(["coil", "set", "reset", "negated"]).default("coil") })).min(1),
      }),
    )
    .min(1),
});

export const fbdSchema = z.object({
  networks: z
    .array(
      z.object({
        assign: z.record(z.string(), z.string()).optional().describe("For a function block: its outputs to variables, e.g. {Q: 'xLamp', ET: 'tElapsed'}"),
        to: z.string().optional().describe("Variable the expression's result is written to"),
        expr: fbd.describe("e.g. {fn: 'AND', args: ['xA', 'xB']} or {fb: 'TON', instance: 'tonDelay', inputs: {IN: 'xIn', PT: 'T#2S'}, output: 'Q'}"),
      }),
    )
    .min(1),
});

/** CODESYS's PLCopenXML: an SFC element's attributes, and the step's entry and exit action (as CODESYS V3.5 SP21 exports them). */
export const SFC_ELEMENT = "http://www.3s-software.com/plcopenxml/sfc/element";
export const SFC_ENTRY = "a6b08bd8-b696-47e3-9cbf-7408b61c9ff8";
export const SFC_EXIT = "a2621e18-7de3-4ea6-ae6d-89e9e0b7befd";

const sfcAction = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), qualifier: z.enum(["N", "S", "R", "P", "P0", "P1"]).default("N"), st: z.string() });
export type SfcAction = z.infer<typeof sfcAction>;

/**
 * An SFC as IEC draws it, top to bottom: steps and transitions alternate; an
 * alternative branch (one path is taken) follows a step and each of its paths
 * starts with a transition; a parallel branch (all paths run) follows a
 * transition and each path starts with a step; a jump ends a path.
 */
export type SfcElement =
  | { step: string; initial?: boolean; actions?: SfcAction[]; entry?: string; exit?: string }
  | { when: string }
  | { alternative: SfcElement[][] }
  | { parallel: SfcElement[][] }
  | { jump: string };
const ENTRY_DOC = "ST that runs once when the step becomes active (CODESYS's step entry action; IEC's P1 qualifier, which CODESYS doesn't have, is turned into this)";
const EXIT_DOC = "ST that runs once when the step is left (CODESYS's step exit action; IEC's P0 qualifier is turned into this)";
const sfcElement: z.ZodType<SfcElement> = z.lazy(() =>
  z.union([
    z.object({ step: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), initial: z.boolean().optional(), actions: z.array(sfcAction).optional(), entry: z.string().optional().describe(ENTRY_DOC), exit: z.string().optional().describe(EXIT_DOC) }),
    z.object({ when: z.string().min(1) }),
    z.object({ alternative: z.array(z.array(sfcElement).min(1)).min(2) }),
    z.object({ parallel: z.array(z.array(sfcElement).min(1)).min(2) }),
    z.object({ jump: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }),
  ]),
);

export const sfcSchema = z.object({
  steps: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        initial: z.boolean().optional(),
        actions: z.array(sfcAction).optional(),
        entry: z.string().optional().describe(ENTRY_DOC),
        exit: z.string().optional().describe(EXIT_DOC),
        next: z.string().describe("Step this one goes to"),
        when: z.string().describe("Transition condition in ST, e.g. 'xStart AND NOT xFault'. CODESYS checks it in the same cycle the step becomes active, before a value its entry action sets (a tare, a timer start) is there: base it on a flag the step sets, not on that value"),
      }),
    )
    .min(2)
    .optional(),
  chart: z
    .array(sfcElement)
    .min(2)
    .optional()
    .describe("With branches: [{step}, {when}, {alternative: [[{when}, {step}, {when}], [{when}, {jump}]]}, {parallel: [[{step}], [{step}]]}, ...]"),
});


export function ladderXml(name: string, pouType: "program" | "functionBlock", spec: z.infer<typeof ladderSchema>): string {
  let id = 0;
  const parts: string[] = [];
  spec.rungs.forEach((rung, n) => {
    const y = n * 100;
    const rail = ++id;
    parts.push(`<leftPowerRail localId="${rail}"><position x="0" y="${y}" /><connectionPointOut formalParameter="none" /></leftPowerRail>`);
    const build = (e: Logic, inputs: number[]): number[] => {
      if (typeof e === "string") {
        const neg = /^\s*NOT\s+/i.test(e);
        const v = e.replace(/^\s*NOT\s+/i, "").trim();
        const c = ++id;
        parts.push(`<contact localId="${c}" negated="${neg}"><position x="0" y="${y}" /><connectionPointIn>${inputs.map((i) => `<connection refLocalId="${i}" />`).join("")}</connectionPointIn><connectionPointOut /><variable>${esc(v)}</variable></contact>`);
        return [c];
      }
      if ("and" in e) return e.and.reduce<number[]>((cur, x) => build(x, cur), inputs);
      return e.or.flatMap((x) => build(x, inputs));
    };
    const outs = build(rung.when, [rail]);
    const coils = rung.then.map((t) => {
      const c = ++id;
      const storage = t.kind === "set" ? ' storage="set"' : t.kind === "reset" ? ' storage="reset"' : "";
      parts.push(`<coil localId="${c}" negated="${t.kind === "negated"}"${storage}><position x="0" y="${y}" /><connectionPointIn>${outs.map((i) => `<connection refLocalId="${i}" />`).join("")}</connectionPointIn><connectionPointOut /><variable>${esc(t.coil)}</variable></coil>`);
      return c;
    });
    parts.push(`<rightPowerRail localId="${++id}"><position x="0" y="${y}" /><connectionPointIn>${coils.map((i) => `<connection refLocalId="${i}" />`).join("")}</connectionPointIn></rightPowerRail>`);
  });
  return wrap(name, pouType, `<LD>${parts.join("\n")}</LD>`);
}

export function fbdXml(name: string, pouType: "program" | "functionBlock", spec: z.infer<typeof fbdSchema>): string {
  let id = 0;
  const parts: string[] = [];
  spec.networks.forEach((net, n) => {
    const y = n * 200;
    let x = 0;
    /** Emits the expression; returns its output connection. */
    const build = (e: Fbd): { id: number; param?: string } => {
      if (typeof e === "string") {
        const v = ++id;
        parts.push(`<inVariable localId="${v}"><position x="${x}" y="${y}" /><connectionPointOut /><expression>${esc(e)}</expression></inVariable>`);
        return { id: v };
      }
      if ("fn" in e) {
        const ins = e.args.map(build);
        const b = ++id;
        x += 100;
        const fn = e.fn.toUpperCase();
        parts.push(`<block localId="${b}" typeName="${esc(fn)}"><position x="${x}" y="${y}" /><inputVariables>${ins.map((i, k) => `<variable formalParameter="In${k + 1}"><connectionPointIn><connection refLocalId="${i.id}"${i.param ? ` formalParameter="${esc(i.param)}"` : ""} /></connectionPointIn></variable>`).join("")}</inputVariables><inOutVariables /><outputVariables><variable formalParameter="Out1"><connectionPointOut /></variable></outputVariables></block>`);
        return { id: b, param: "Out1" };
      }
      const ins = Object.entries(e.inputs ?? {}).map(([k, v]) => [k, build(v)] as const);
      const b = ++id;
      x += 100;
      const outs = [...new Set([e.output ?? "Q", ...Object.keys(net.assign ?? {})])];
      parts.push(`<block localId="${b}" typeName="${esc(e.fb)}" instanceName="${esc(e.instance)}"><position x="${x}" y="${y}" /><inputVariables>${ins.map(([k, i]) => `<variable formalParameter="${esc(k)}"><connectionPointIn><connection refLocalId="${i.id}"${i.param ? ` formalParameter="${esc(i.param)}"` : ""} /></connectionPointIn></variable>`).join("")}</inputVariables><inOutVariables /><outputVariables>${outs.map((o) => `<variable formalParameter="${esc(o)}"><connectionPointOut /></variable>`).join("")}</outputVariables></block>`);
      return { id: b, param: e.output ?? "Q" };
    };
    const out = build(net.expr);
    const targets: [string | undefined, string][] = [];
    if (net.to) targets.push([out.param, net.to]);
    for (const [param, v] of Object.entries(net.assign ?? {})) targets.push([param, v]);
    for (const [param, v] of targets) {
      x += 100;
      parts.push(`<outVariable localId="${++id}"><position x="${x}" y="${y}" /><connectionPointIn><connection refLocalId="${out.id}"${param ? ` formalParameter="${esc(param)}"` : ""} /></connectionPointIn><expression>${esc(v)}</expression></outVariable>`);
    }
  });
  return wrap(name, pouType, `<FBD>${parts.join("\n")}</FBD>`);
}

/**
 * CFC from the same description as FBD. CODESYS stores CFC as an empty ST body
 * with the elements in addData; every line runs through an unnamed connector
 * that names the source's output (an input variable's output is its own text),
 * and each box carries its call type and execution order (taken from CODESYS's
 * own export; without the connectors its import drops the lines).
 */
export function cfcXml(name: string, pouType: "program" | "functionBlock", spec: z.infer<typeof fbdSchema>): string {
  let id = 0;
  let order = 0;
  const parts: string[] = [];
  const callType = (b: string) => `<addData><data name="http://www.3s-software.com/plcopenxml/cfccalltype" handleUnknown="implementation"><CallType xmlns="">${b}</CallType></data></addData>`;
  /** A connector from a source output; returns the connector's id, which the consumer connects to. */
  const line = (src: number, param: string) => {
    const c = ++id;
    parts.push(`<connector localId="${c}" name=""><position x="0" y="0" /><connectionPointIn><connection refLocalId="${src}" formalParameter="${esc(param)}" /></connectionPointIn></connector>`);
    return c;
  };
  spec.networks.forEach((net, n) => {
    const y = n * 12;
    let x = 0;
    const build = (e: Fbd): { id: number; param: string } => {
      if (typeof e === "string") {
        const v = ++id;
        parts.push(`<inVariable localId="${v}"><position x="${x}" y="${y}" /><connectionPointOut><expression /></connectionPointOut><expression>${esc(e)}</expression></inVariable>`);
        return { id: v, param: e };
      }
      const isFn = "fn" in e;
      const ins: [string, { id: number; param: string }][] = isFn ? e.args.map((a, k) => [`In${k + 1}`, build(a)]) : Object.entries(e.inputs ?? {}).map(([k, v]) => [k, build(v)]);
      const conns = ins.map(([k, s]) => [k, line(s.id, s.param)] as const);
      const b = ++id;
      x += 10;
      // A function's or operator's result is the output with no name (checked on SP22).
      const outs = isFn ? [""] : [...new Set([e.output ?? "Q", ...Object.keys(net.assign ?? {})])];
      const op = isFn && OPERATORS.has(e.fn.toUpperCase());
      const type = isFn ? (op ? e.fn.toUpperCase() : e.fn) : e.fb;
      const kind = isFn ? (op ? "operator" : "function") : "functionblock";
      const inst = isFn ? "" : ` instanceName="${esc(e.instance)}"`;
      parts.push(
        `<block localId="${b}" executionOrderId="${order++}" typeName="${esc(type)}"${inst}><position x="${x}" y="${y}" />` +
          `<inputVariables>${conns.map(([k, c], i) => `<variable formalParameter="${esc(k)}"><connectionPointIn><relPosition x="0" y="${i}" /><connection refLocalId="${c}" /></connectionPointIn></variable>`).join("")}</inputVariables><inOutVariables />` +
          `<outputVariables>${outs.map((o, i) => `<variable formalParameter="${esc(o)}"><connectionPointOut><relPosition x="0" y="${i}" /><expression /></connectionPointOut></variable>`).join("")}</outputVariables>${callType(kind)}</block>`,
      );
      return { id: b, param: isFn ? "" : (e.output ?? "Q") };
    };
    const out = build(net.expr);
    const targets: [string, string][] = [];
    if (net.to) targets.push([out.param, net.to]);
    for (const [param, v] of Object.entries(net.assign ?? {})) targets.push([param, v]);
    for (const [param, v] of targets) {
      const c = line(out.id, param);
      x += 10;
      parts.push(`<outVariable localId="${++id}" executionOrderId="${order++}"><position x="${x}" y="${y}" /><connectionPointIn><connection refLocalId="${c}" /></connectionPointIn><expression>${esc(v)}</expression></outVariable>`);
    }
  });
  const body = `<ST><xhtml xmlns="http://www.w3.org/1999/xhtml" /></ST><addData><data name="http://www.3s-software.com/plcopenxml/cfc" handleUnknown="implementation"><CFC>${parts.join("\n")}</CFC></data></addData>`;
  return wrap(name, pouType, body);
}

/** The steps format (one sequence, the last step jumps back) as a chart. */
export function stepsToChart(steps: NonNullable<z.infer<typeof sfcSchema>["steps"]>): SfcElement[] {
  const chart: SfcElement[] = [];
  steps.forEach((s, k) => {
    chart.push({ step: s.name, ...(s.initial ? { initial: true } : {}), ...(s.actions?.length ? { actions: s.actions } : {}), ...(s.entry !== undefined ? { entry: s.entry } : {}), ...(s.exit !== undefined ? { exit: s.exit } : {}) }, { when: s.when });
    if (k === steps.length - 1) chart.push({ jump: s.next });
  });
  return chart;
}

export function chartOf(spec: z.infer<typeof sfcSchema>): SfcElement[] {
  if (spec.chart && spec.steps) throw new Error("Give sfc.steps or sfc.chart, not both.");
  if (spec.chart) return spec.chart;
  if (spec.steps) return stepsToChart(spec.steps);
  throw new Error("Give sfc.steps (one sequence) or sfc.chart (with branches).");
}

const stepNames = (seq: SfcElement[]): string[] =>
  seq.flatMap((e) => ("step" in e ? [e.step] : "alternative" in e ? e.alternative.flatMap(stepNames) : "parallel" in e ? e.parallel.flatMap(stepNames) : []));

type Ends = "start" | "par-start" | "alt-start" | "step" | "transition" | "jump";

/** What is wrong with a chart: steps and transitions must alternate, branches start and end right. */
export function chartProblems(chart: SfcElement[]): string[] {
  const out: string[] = [];
  const names = stepNames(chart);
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n.toLowerCase())) out.push(`step ${n} appears twice; step names must be unique`);
    seen.add(n.toLowerCase());
  }
  const check = (seq: SfcElement[], prev: Ends, where: string): Ends => {
    for (const e of seq) {
      const at = `${where}${"step" in e ? ` at step ${e.step}` : ""}`;
      if (prev === "jump") {
        out.push(`${where}: nothing can follow a jump`);
        return "jump";
      }
      if ("step" in e) {
        if (prev === "step") out.push(`${at}: two steps in a row need a {when} between them`);
        else if (prev === "alt-start") out.push(`${at}: each path of an alternative branch starts with a {when}`);
        prev = "step";
      } else if ("when" in e) {
        if (prev === "transition") out.push(`${where}: two transitions in a row ('${e.when}') need a step between them`);
        else if (prev === "start" || prev === "par-start") out.push(`${where}: '${e.when}' must follow a step`);
        prev = "transition";
      } else if ("jump" in e) {
        if (!seen.has(e.jump.toLowerCase())) out.push(`${where}: jump to '${e.jump}', which isn't a step`);
        if (prev !== "transition" && prev !== "alt-start") out.push(`${where}: a jump must follow a {when}`);
        prev = "jump";
      } else if ("alternative" in e) {
        if (prev !== "step") out.push(`${where}: an alternative branch must follow a step (its paths start with their conditions)`);
        const ends = e.alternative.map((b, i) => check(b, "alt-start", `${where} > alternative path ${i + 1}`));
        ends.forEach((end, i) => {
          if (end !== "transition" && end !== "jump") out.push(`${where} > alternative path ${i + 1} must end with a {when} or a {jump}`);
        });
        prev = ends.every((x) => x === "jump") ? "jump" : "transition";
      } else {
        if (prev !== "transition" && prev !== "start") out.push(`${where}: a parallel branch must follow a {when}`);
        const ends = e.parallel.map((b, i) => check(b, "par-start", `${where} > parallel path ${i + 1}`));
        ends.forEach((end, i) => {
          if (end !== "step") out.push(`${where} > parallel path ${i + 1} must end with a step (paths of a parallel branch join before the next {when})`);
        });
        prev = "step";
      }
    }
    return prev;
  };
  if (!chart.length || !("step" in chart[0]!)) out.push("the chart starts with its initial step");
  const end = check(chart, "start", "chart");
  if (end === "step") out.push("the chart ends with a step: add a {when} and a {jump} back");
  return out;
}

export function sfcXml(name: string, pouType: "program" | "functionBlock", spec: z.infer<typeof sfcSchema>): string {
  const chart = chartOf(spec);
  const p = chartProblems(chart);
  if (p.length) throw new Error(p.join("\n"));
  const first = chart[0] as { step: string; initial?: boolean };
  const hasInitial = (seq: SfcElement[]): boolean => seq.some((e) => ("step" in e ? !!e.initial : "alternative" in e ? e.alternative.some(hasInitial) : "parallel" in e ? e.parallel.some(hasInitial) : false));
  const initialAll = !hasInitial(chart);
  let id = 0;
  let y = 0;
  const parts: string[] = [];
  const actionDefs: string[] = [];
  type Conn = { id: number; param?: string };
  const conns = (ins: Conn[]) => ins.map((c) => `<connection refLocalId="${c.id}"${c.param ? ` formalParameter="${c.param}"` : ""} />`).join("");
  // A path that ends in a jump still feeds its branch's convergence, through the
  // jumpStep: that is how CODESYS exports it, and its import drops the path otherwise.
  let jumped = false;
  const emit = (seq: SfcElement[], ins: Conn[]): Conn[] => {
    let cur = ins;
    jumped = false;
    for (const e of seq) {
      if ("step" in e) {
        const st = ++id;
        const initial = e.initial || (initialAll && e === first);
        // Entry and exit actions are attributes of the step that name an action of the POU.
        const once = (kind: "entry" | "exit", q: "P1" | "P0", own: string | undefined): string => {
          const pulses = (e.actions ?? []).filter((a) => a.qualifier === q);
          if (own === undefined && !pulses.length) return "";
          const actName = own === undefined && pulses.length === 1 ? pulses[0]!.name : `${e.step}_${kind}`;
          const body = [own, ...pulses.map((a) => a.st)].filter((s) => s !== undefined).join("\n");
          actionDefs.push(`<action name="${esc(actName)}"><body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">${esc(body)}</xhtml></ST></body></action>`);
          return `<attribute guid="${kind === "entry" ? SFC_ENTRY : SFC_EXIT}">${esc(actName)}</attribute>`;
        };
        const attrs = once("entry", "P1", e.entry) + once("exit", "P0", e.exit);
        const stepData = attrs ? `<addData><data name="${SFC_ELEMENT}" handleUnknown="implementation"><attributes xmlns="">${attrs}</attributes></data></addData>` : "";
        parts.push(`<step localId="${st}"${initial ? ' initialStep="true"' : ""} name="${esc(e.step)}"><position x="0" y="${y}" /><connectionPointIn>${conns(cur)}</connectionPointIn><connectionPointOut formalParameter="sfc" />${stepData}</step>`);
        const assoc = (e.actions ?? []).filter((a) => a.qualifier !== "P1" && a.qualifier !== "P0");
        if (assoc.length) {
          const blk = ++id;
          const acts = assoc.map((a) => {
            actionDefs.push(`<action name="${esc(a.name)}"><body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">${esc(a.st)}</xhtml></ST></body></action>`);
            return `<action localId="${++id}" qualifier="${a.qualifier}"><relPosition x="0" y="0" /><reference name="${esc(a.name)}" /><connectionPointOut /></action>`;
          });
          parts.push(`<actionBlock localId="${blk}"><position x="150" y="${y}" /><connectionPointIn><connection refLocalId="${st}" /></connectionPointIn>${acts.join("")}</actionBlock>`);
        }
        y += 40;
        cur = [{ id: st, param: "sfc" }];
      } else if ("when" in e) {
        const cond = ++id;
        parts.push(`<inVariable localId="${cond}"><position x="0" y="${y}" /><connectionPointOut /><expression>${esc(e.when)}</expression></inVariable>`);
        const tr = ++id;
        parts.push(`<transition localId="${tr}"><position x="0" y="${y}" /><connectionPointIn>${conns(cur)}</connectionPointIn><connectionPointOut /><condition><connectionPointIn><connection refLocalId="${cond}" /></connectionPointIn></condition></transition>`);
        y += 40;
        cur = [{ id: tr }];
      } else if ("jump" in e) {
        const j = ++id;
        parts.push(`<jumpStep localId="${j}" targetName="${esc(e.jump)}"><position x="0" y="${y}" /><connectionPointIn>${conns(cur)}</connectionPointIn></jumpStep>`);
        y += 40;
        cur = [{ id: j, param: "sfc" }];
        jumped = true;
      } else {
        const alt = "alternative" in e;
        const paths = alt ? e.alternative : e.parallel;
        const div = ++id;
        const tag = alt ? "selection" : "simultaneous";
        parts.push(`<${tag}Divergence localId="${div}"><position x="0" y="${y}" /><connectionPointIn>${conns(cur)}</connectionPointIn>${paths.map(() => `<connectionPointOut formalParameter="sfc" />`).join("")}</${tag}Divergence>`);
        y += 20;
        // CODESYS tells the paths apart by their order: every output of a divergence is 'sfc'.
        const results = paths.map((path) => ({ out: emit(path, [{ id: div, param: alt ? "sfc" : undefined }]), jumped }));
        const ends = results.map((r) => r.out);
        const conv = ++id;
        parts.push(`<${tag}Convergence localId="${conv}"><position x="0" y="${y}" />${ends.map((c) => `<connectionPointIn>${conns(c.map((x) => ({ ...x, param: "sfc" })))}</connectionPointIn>`).join("")}<connectionPointOut /></${tag}Convergence>`);
        y += 20;
        cur = [{ id: conv }];
        jumped = results.every((r) => r.jumped);
      }
    }
    return cur;
  };
  const tail = emit(chart, []);
  // A chart that ends with a transition goes back to its initial step.
  if (!jumped) parts.push(`<jumpStep localId="${++id}" targetName="${esc(first.step)}"><position x="0" y="${y}" /><connectionPointIn>${conns(tail)}</connectionPointIn></jumpStep>`);
  const sfcSettings = `<addData><data name="http://www.3s-software.com/plcopenxml/sfcsettings" handleUnknown="implementation"><SFCSettings><LibTitle>IecSfc</LibTitle><LibCompany>System</LibCompany><LibVersion>4.4.0.0</LibVersion><LibNamespace>IecSfc</LibNamespace><CalcActiveTransOnly>false</CalcActiveTransOnly><UseDefaults>false</UseDefaults></SFCSettings></data></addData>`;
  return wrap(name, pouType, `<SFC>${parts.join("\n")}</SFC>`, actionDefs.length ? `<actions>${actionDefs.join("")}</actions>\n      ` : "", sfcSettings);
}

/**
 * The steps format is one sequence: each step goes to the next one listed, and
 * the last step jumps back (to any step). Branches use the chart format.
 */
export function sfcProblems(spec: z.infer<typeof sfcSchema>): string[] {
  if (spec.chart) return spec.steps ? ["Give sfc.steps or sfc.chart, not both."] : chartProblems(spec.chart);
  if (!spec.steps) return ["Give sfc.steps (one sequence) or sfc.chart (with branches)."];
  const out: string[] = [];
  const names = new Set(spec.steps.map((s) => s.name));
  if (names.size !== spec.steps.length) out.push("step names must be unique");
  spec.steps.forEach((s, k) => {
    const following = spec.steps![k + 1];
    if (!names.has(s.next)) out.push(`step ${s.name} goes to '${s.next}', which isn't a step`);
    else if (following && s.next !== following.name) out.push(`step ${s.name} must go to the next step listed (${following.name}); only the last step can jump back. For branches use sfc.chart.`);
  });
  return out;
}

export function registerGraphicalActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  reg(
    "create_graphical",
    {
      description:
        "Create a ladder (LD), function block diagram (FBD), continuous function chart (CFC) or sequential function chart (SFC) program or function block from a structured description; CODESYS draws it. " +
        "ladder: {rungs: [{when: 'xStart' | 'NOT xStop' | {and: [...]} (series) | {or: [...]} (parallel), then: [{coil: 'xMotor', kind: 'coil'|'set'|'reset'|'negated'}]}]}. " +
        "fbd: {networks: [{expr: 'xA' | {fn: 'AND', args: [...]} | {fb: 'TON', instance: 'tonDelay', inputs: {IN: ..., PT: 'T#2S'}, output: 'Q'}, to: 'xOut', assign: {ET: 'tEt'}}]}. " +
        "cfc: elements and wires, with positions and optional pages (CODESYS's page-oriented CFC): {pages?: [{name, description?}], elements: [{id: 'xStart', input: 'xStart', page?: 1}, {id: 'tonDelay', box: 'TON', instance: 'tonDelay', x?: 30, y?: 10}, {id: 'and1', box: 'AND'}, {id: 'lamp', output: 'xLamp'}, {id: 'toPage2', mark: 'Delayed'}, {id: 'note', comment: 'text'}], wires: [{from: 'xStart', to: 'tonDelay.IN'}, {from: 'tonDelay.Q', to: 'lamp'}, {from: 'and1', to: 'x.In1'}]}. " +
        "A page has a left margin (inputs), content (boxes) and a right margin (outputs); a connection mark joins pages: one wire into the source mark, wires out of sink marks of the same name. Positions left out are placed automatically; read_objects gives them back. cfc also takes fbd's description. " +
        "sfc: {steps: [{name, initial?, actions?: [{name, qualifier: 'N'|'S'|'R'|'P', st: 'ST code'}], entry?: 'ST run once when the step becomes active', exit?: 'ST run once when it is left', next: 'NextStep', when: 'ST condition'}]}, one sequence: each step goes to the next listed, the last jumps back. CODESYS has no P1/P0 qualifiers: an action with P1 becomes the step's entry action, P0 its exit action. " +
        "sfc with branches: {chart: [...]}, top to bottom: {step: 'Idle', actions?, entry?, exit?},{when: 'xStart'}, {alternative: [[{when: 'xA'}, {step: 'A'}, {when: 'xDoneA'}], [{when: 'NOT xA'}, {jump: 'Idle'}]]} (one path is taken), {parallel: [[{step: 'Fill'}], [{step: 'Heat'}]]} (all paths run, after a {when}; they join before the next {when}), {jump: 'Idle'}. Steps and transitions alternate; a chart ending with a {when} goes back to its first step. " +
        "declaration is the POU's ST declaration (PROGRAM or FUNCTION_BLOCK with its variables, FB instances included). Compile afterwards.",
      inputSchema: z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        declaration: z.string().describe("e.g. 'PROGRAM LD_Motor\nVAR\n    xStart, xStop, xMotor : BOOL;\nEND_VAR'"),
        ladder: ladderSchema.optional(),
        fbd: fbdSchema.optional(),
        cfc: z.union([cfcChartSchema, fbdSchema]).optional(),
        sfc: sfcSchema.optional(),
        // Taken too: DeepSeek's first SFC said kind: 'sfc' next to sfc: {...}, and the call was refused.
        kind: z.string().optional().describe("Optional, the language of the body given: 'ladder' (or 'ld'), 'fbd', 'cfc' or 'sfc'"),
        language: z.string().optional().describe("Same as kind"),
        parent: z.string().optional().describe("Folder or object to create it under (default: the application)"),
        replace: z.boolean().optional().describe("Replace an existing POU of this name (read it with read_objects, edit the description, send it back). The old one is deleted first; revert_object brings it back from a checkpoint"),
      }),
    },
    async (a) =>
      run(async () => {
        const kinds = [a.ladder && "ladder", a.fbd && "fbd", a.cfc && "cfc", a.sfc && "sfc"].filter(Boolean);
        if (kinds.length !== 1) throw new Error("Give exactly one of ladder, fbd, cfc or sfc.");
        const said = (a.kind ?? a.language)?.trim().toLowerCase().replace(/^ld$/, "ladder");
        if (said && said !== kinds[0]) throw new Error(`kind says '${a.kind ?? a.language}' but the body given is ${kinds[0]}.`);
        // Pragmas and comments may come first, as CODESYS allows.
        const head = /^\s*(?:(?:\{[^}]*\}|\(\*[\s\S]*?\*\)|\/\/[^\n]*)\s*)*(PROGRAM|FUNCTION_BLOCK)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(a.declaration);
        if (!head) throw new Error("The declaration must start with PROGRAM or FUNCTION_BLOCK and the name.");
        if (head[2]!.toLowerCase() !== a.name.toLowerCase()) throw new Error(`The declaration names ${head[2]}, not ${a.name}.`);
        const pouType = head[1]!.toUpperCase() === "PROGRAM" ? "program" : "functionBlock";
        if (a.sfc) {
          const p = sfcProblems(a.sfc);
          if (p.length) throw new Error(p.join("\n"));
        }
        const chart = a.cfc && "elements" in a.cfc ? planCfc(a.cfc) : undefined;
        const xml = a.ladder ? ladderXml(a.name, pouType, a.ladder) : a.fbd ? fbdXml(a.name, pouType, a.fbd) : chart ? cfcChartXml(a.name, pouType, chart) : a.cfc ? cfcXml(a.name, pouType, a.cfc as z.infer<typeof fbdSchema>) : sfcXml(a.name, pouType, a.sfc!);
        let replaced = false;
        if (a.replace) {
          try {
            // Its task calls stay: the new POU has the same name (DeepSeek's replaced SFC lost its call).
            await ctx.bridge.call("object.delete", { path: a.parent ? `${a.parent}/${a.name}` : a.name, save: false, keep_calls: true });
            replaced = true;
          } catch (e) {
            if (!/not.?found|no object/i.test(e instanceof Error ? e.message : String(e))) throw e;
          }
        }
        const r = await ctx.bridge.call<{ added: string[]; messages?: { severity: string; text: string }[] }>("object.import_xml", { parent: a.parent, xml, save: false }, { timeoutMs: 120_000 });
        const path = r.added[0]!;
        await ctx.bridge.call("object.write", { path, declaration: a.declaration, save: ctx.autosave });
        const label = kinds[0] === "ladder" ? "ladder (LD)" : kinds[0] === "fbd" ? "FBD" : kinds[0] === "cfc" ? (chart?.pages ? "page-oriented CFC" : "CFC") : "SFC";
        const size = a.sfc
          ? ` with ${a.sfc.steps ? a.sfc.steps.length : stepNames(a.sfc.chart ?? []).length} steps`
          : chart
            ? ` with ${chart.pages ? `${chart.pages.length} page${chart.pages.length === 1 ? "" : "s"}, ` : ""}${chart.nodes.filter((n) => n.kind === "box").length} boxes and ${chart.wires.length} wires`
            : "";
        const imported = r.messages?.length ? `\nCODESYS's import said:\n${r.messages.map((m) => `- ${m.severity}: ${m.text}`).join("\n")}` : "";
        return `${replaced ? "Replaced" : "Created"} ${path} in ${label}${size}.${imported}\nCompile to check it, and call it from a task (configure_task) or another POU.`;
      }),
  );
}
