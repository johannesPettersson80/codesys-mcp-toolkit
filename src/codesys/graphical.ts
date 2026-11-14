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

export const sfcSchema = z.object({
  steps: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        initial: z.boolean().optional(),
        actions: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), qualifier: z.enum(["N", "S", "R", "P", "P0", "P1"]).default("N"), st: z.string() })).optional(),
        next: z.string().describe("Step this one goes to"),
        when: z.string().describe("Transition condition in ST, e.g. 'xStart AND NOT xFault'"),
      }),
    )
    .min(2),
});

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function wrap(name: string, pouType: "program" | "functionBlock", body: string, actions = "", addData = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<project xmlns="http://www.plcopen.org/xml/tc6_0200">
  <fileHeader companyName="codesys-mcp-toolkit" productName="codesys-mcp-toolkit" productVersion="2" creationDateTime="2026-01-01T00:00:00" />
  <contentHeader name="${esc(name)}"><coordinateInfo><fbd><scaling x="1" y="1" /></fbd><ld><scaling x="1" y="1" /></ld><sfc><scaling x="1" y="1" /></sfc></coordinateInfo></contentHeader>
  <types><dataTypes /><pous>
    <pou name="${esc(name)}" pouType="${pouType}">
      <interface />
      ${actions}<body>${body}</body>${addData}
    </pou>
  </pous></types>
  <instances><configurations /></instances>
</project>`;
}

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

export function sfcXml(name: string, pouType: "program" | "functionBlock", spec: z.infer<typeof sfcSchema>): string {
  const steps = spec.steps;
  const names = new Set(steps.map((s) => s.name));
  for (const s of steps) if (!names.has(s.next)) throw new Error(`step ${s.name} goes to '${s.next}', which isn't a step`);
  if (!steps.some((s) => s.initial)) steps[0]!.initial = true;
  let id = 0;
  const parts: string[] = [];
  const actionDefs: string[] = [];
  let y = 0;
  let prev: number | undefined;
  steps.forEach((s, k) => {
    const st = ++id;
    parts.push(`<step localId="${st}"${s.initial ? ' initialStep="true"' : ""} name="${esc(s.name)}"><position x="0" y="${y}" /><connectionPointIn>${prev ? `<connection refLocalId="${prev}" />` : ""}</connectionPointIn><connectionPointOut formalParameter="sfc" /></step>`);
    if (s.actions?.length) {
      const blk = ++id;
      const acts = s.actions.map((a) => {
        actionDefs.push(`<action name="${esc(a.name)}"><body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">${esc(a.st)}</xhtml></ST></body></action>`);
        return `<action localId="${++id}" qualifier="${a.qualifier}"><relPosition x="0" y="0" /><reference name="${esc(a.name)}" /><connectionPointOut /></action>`;
      });
      parts.push(`<actionBlock localId="${blk}"><position x="150" y="${y}" /><connectionPointIn><connection refLocalId="${st}" /></connectionPointIn>${acts.join("")}</actionBlock>`);
    }
    y += 40;
    const cond = ++id;
    parts.push(`<inVariable localId="${cond}"><position x="0" y="${y}" /><connectionPointOut /><expression>${esc(s.when)}</expression></inVariable>`);
    const tr = ++id;
    parts.push(`<transition localId="${tr}"><position x="0" y="${y}" /><connectionPointIn><connection refLocalId="${st}" formalParameter="sfc" /></connectionPointIn><connectionPointOut /><condition><connectionPointIn><connection refLocalId="${cond}" /></connectionPointIn></condition></transition>`);
    y += 40;
    const following = steps[k + 1];
    if (following && following.name === s.next) prev = tr;
    else {
      parts.push(`<jumpStep localId="${++id}" targetName="${esc(s.next)}"><position x="0" y="${y}" /><connectionPointIn><connection refLocalId="${tr}" /></connectionPointIn></jumpStep>`);
      y += 40;
      prev = undefined;
    }
  });
  const sfcSettings = `<addData><data name="http://www.3s-software.com/plcopenxml/sfcsettings" handleUnknown="implementation"><SFCSettings><LibTitle>IecSfc</LibTitle><LibCompany>System</LibCompany><LibVersion>4.4.0.0</LibVersion><LibNamespace>IecSfc</LibNamespace><CalcActiveTransOnly>false</CalcActiveTransOnly><UseDefaults>false</UseDefaults></SFCSettings></data></addData>`;
  return wrap(name, pouType, `<SFC>${parts.join("\n")}</SFC>`, actionDefs.length ? `<actions>${actionDefs.join("")}</actions>\n      ` : "", sfcSettings);
}

/**
 * The SFCs this generator makes are one sequence: each step goes to the next one
 * listed, and the last step jumps back (to any step). Branches aren't supported yet.
 */
export function sfcProblems(spec: z.infer<typeof sfcSchema>): string[] {
  const out: string[] = [];
  const names = new Set(spec.steps.map((s) => s.name));
  if (names.size !== spec.steps.length) out.push("step names must be unique");
  spec.steps.forEach((s, k) => {
    const following = spec.steps[k + 1];
    if (!names.has(s.next)) out.push(`step ${s.name} goes to '${s.next}', which isn't a step`);
    else if (following && s.next !== following.name) out.push(`step ${s.name} must go to the next step listed (${following.name}); only the last step can jump back. Branches aren't supported yet: write the sequence in ST instead.`);
  });
  return out;
}

export function registerGraphicalActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  reg(
    "create_graphical",
    {
      description:
        "Create a ladder (LD), function block diagram (FBD) or sequential function chart (SFC) program or function block from a structured description; CODESYS draws it. " +
        "ladder: {rungs: [{when: 'xStart' | 'NOT xStop' | {and: [...]} (series) | {or: [...]} (parallel), then: [{coil: 'xMotor', kind: 'coil'|'set'|'reset'|'negated'}]}]}. " +
        "fbd: {networks: [{expr: 'xA' | {fn: 'AND', args: [...]} | {fb: 'TON', instance: 'tonDelay', inputs: {IN: ..., PT: 'T#2S'}, output: 'Q'}, to: 'xOut', assign: {ET: 'tEt'}}]}. " +
        "sfc: {steps: [{name, initial?, actions?: [{name, qualifier: 'N'|'S'|'R'|'P', st: 'ST code'}], next: 'NextStep', when: 'ST condition'}]}, one sequence: each step goes to the next listed, the last jumps back. " +
        "declaration is the POU's ST declaration (PROGRAM or FUNCTION_BLOCK with its variables, FB instances included). Compile afterwards.",
      inputSchema: z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        declaration: z.string().describe("e.g. 'PROGRAM LD_Motor\nVAR\n    xStart, xStop, xMotor : BOOL;\nEND_VAR'"),
        ladder: ladderSchema.optional(),
        fbd: fbdSchema.optional(),
        sfc: sfcSchema.optional(),
        parent: z.string().optional().describe("Folder or object to create it under (default: the application)"),
      }),
    },
    async (a) =>
      run(async () => {
        const kinds = [a.ladder && "ladder", a.fbd && "fbd", a.sfc && "sfc"].filter(Boolean);
        if (kinds.length !== 1) throw new Error("Give exactly one of ladder, fbd or sfc.");
        const head = /^\s*(?:\{[^}]*\}\s*)*(PROGRAM|FUNCTION_BLOCK)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(a.declaration);
        if (!head) throw new Error("The declaration must start with PROGRAM or FUNCTION_BLOCK and the name.");
        if (head[2]!.toLowerCase() !== a.name.toLowerCase()) throw new Error(`The declaration names ${head[2]}, not ${a.name}.`);
        const pouType = head[1]!.toUpperCase() === "PROGRAM" ? "program" : "functionBlock";
        if (a.sfc) {
          const p = sfcProblems(a.sfc);
          if (p.length) throw new Error(p.join("\n"));
        }
        const xml = a.ladder ? ladderXml(a.name, pouType, a.ladder) : a.fbd ? fbdXml(a.name, pouType, a.fbd) : sfcXml(a.name, pouType, a.sfc!);
        const r = await ctx.bridge.call<{ added: string[] }>("object.import_xml", { parent: a.parent, xml, save: false }, { timeoutMs: 120_000 });
        const path = r.added[0]!;
        await ctx.bridge.call("object.write", { path, declaration: a.declaration, save: ctx.autosave });
        return `Created ${path} in ${kinds[0] === "ladder" ? "ladder (LD)" : kinds[0] === "fbd" ? "FBD" : "SFC"}${a.sfc ? ` with ${a.sfc.steps.length} steps` : ""}. Compile to check it, and call it from a task (configure_task) or another POU.`;
      }),
  );
}
