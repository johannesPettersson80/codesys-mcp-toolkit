/**
 * Breakpoints and stepping in CODESYS's simulation (watcher/mcp_debug.py).
 * CODESYS addresses statements by position; the low 32 bits of a position are
 * the implementation line plus a per-object offset, so lines map to positions
 * from the first statement's line.
 */
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import type { AppContext } from "../tools.js";
import { currentCodesysSim } from "./simulation.js";

const low = (p: number) => p - Math.floor(p / 2 ** 32) * 2 ** 32;

/** Implementation line (1-based) -> CODESYS position, for every statement. */
export function lineMap(impl: string, positions: number[]): Map<number, number> {
  const lines = impl.split(/\r?\n/);
  const first = lines.findIndex((l) => {
    const t = l.trim();
    return t && !t.startsWith("//") && !t.startsWith("(*");
  });
  const valid = positions.filter((p) => low(p) !== 0xffffffff);
  const out = new Map<number, number>();
  if (first < 0 || !valid.length) return out;
  const base = low(valid[0]!) - (first + 1);
  for (const p of valid) {
    const line = low(p) - base;
    if (line >= 1 && line <= lines.length && !out.has(line)) out.set(line, p);
  }
  return out;
}

const SIZES: Record<string, number> = {
  BOOL: 1, BYTE: 1, SINT: 1, USINT: 1,
  WORD: 2, INT: 2, UINT: 2,
  DWORD: 4, DINT: 4, UDINT: 4, REAL: 4, TIME: 4, TOD: 4, TIME_OF_DAY: 4, DATE: 4, DT: 4, DATE_AND_TIME: 4,
  LWORD: 8, LINT: 8, ULINT: 8, LREAL: 8, LTIME: 8,
};

/** Bytes of an elementary value as the simulation reads it ('REAL#52', 'TRUE', 'T#1s'). */
export function dataSize(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if (/^(TRUE|FALSE)$/i.test(v)) return 1;
  const m = /^([A-Z_]+)#/i.exec(v);
  if (!m) return undefined;
  const t = m[1]!.toUpperCase();
  return SIZES[t] ?? (t === "T" ? 4 : t === "LT" ? 8 : t === "D" ? 4 : undefined);
}

interface Positions {
  path: string;
  positions: number[];
  implementation: string;
}

export function registerDebugActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const b = ctx.bridge;
  const needSim = () => {
    if (!currentCodesysSim(ctx)) throw new Error("The simulation isn't running: call codesys_sim_start first. Breakpoints only work in CODESYS's simulation.");
  };
  const where = (s: { state: string; at?: { path?: string; position: number; instance?: string; positions?: number[]; implementation?: string }; call_stack?: { pou?: string; instance?: string; error?: string }[] }) => {
    if (!/halt/i.test(s.state)) return `Simulation: ${s.state}.`;
    const at = s.at;
    const stack = (s.call_stack ?? []).filter((e) => e.pou || e.instance);
    const stackText = stack.length > 1 ? `\nCall stack (innermost first): ${stack.map((e) => e.instance || e.pou).join(" <- ")}` : "";
    if (!at?.path) return `Simulation: ${s.state} (position unknown).${stackText}`;
    const map = lineMap(at.implementation ?? "", at.positions ?? []);
    const line = [...map].find(([, p]) => p === at.position)?.[0];
    const code = line ? (at.implementation ?? "").split(/\r?\n/)[line - 1]?.trim() : undefined;
    const end = low(at.position) === 0xffffffff ? " at its end (RETURN)" : "";
    return `Halted in ${at.path}${line ? ` at line ${line}: ${code}` : end} (instance ${at.instance}). Read values with codesys_sim_read, then debug_step or debug_continue.${stackText}`;
  };

  reg(
    "breakpoint_on_change",
    {
      description: "A data breakpoint in the running simulation: halt right after a statement writes a variable (optionally only when a condition holds, e.g. 'PLC_PRG.nCount > 10'; CODESYS checks the condition on every write, which slows the simulation down). debug_status then shows where it halted and the call stack. Elementary variables only (1-8 bytes).",
      inputSchema: z.object({
        variable: z.string().describe("e.g. 'PLC_PRG.rSetpoint'"),
        condition: z.string().optional(),
        size: z.number().int().min(1).max(8).optional().describe("Bytes to watch; found from the variable's type when left out"),
      }),
    },
    async ({ variable, condition, size }) =>
      run(async () => {
        needSim();
        let bytes = size;
        if (!bytes) {
          const r = await b.call<{ values: Record<string, string | undefined>; errors?: Record<string, string> }>("sim.read", { names: [variable] }, { timeoutMs: 10_000 });
          if (r.errors?.[variable]) throw new Error(`${variable}: ${r.errors[variable]}`);
          bytes = dataSize(r.values?.[variable]);
          if (!bytes) throw new Error(`Can't tell the size of ${variable} (${r.values?.[variable]}): a data breakpoint watches 1-8 bytes of an elementary variable. Give size, or pick a variable of an elementary type.`);
        }
        const r = await b.call<{ enabled?: boolean }>("debug.set_data", { expression: variable, size: bytes, ...(condition ? { condition } : {}) });
        if (r.enabled === false) throw new Error(`CODESYS created the data breakpoint on ${variable} but didn't enable it: this target may not support data breakpoints.`);
        return `Data breakpoint on ${variable}${condition ? ` when ${condition}` : ""}: the simulation halts right after the statement that writes it (debug_status shows where). breakpoint_clear removes it.`;
      }),
  );

  // A watch list the model keeps: one read of every expression, with what changed since the last read.
  const watched: string[] = [];
  let last: Record<string, string | undefined> = {};
  reg(
    "watch",
    {
      description:
        "A watch list in the running simulation: add or remove expressions, then read them all at once; each read marks what changed since the previous one. samples > 1 reads several times (every ms) and reports min, max and changes per expression, e.g. to see a value move over a second.",
      inputSchema: z.object({
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
        clear: z.boolean().optional(),
        samples: z.number().int().min(1).max(50).default(1),
        every: z.number().int().min(20).max(5000).default(200).describe("ms between samples"),
      }),
    },
    async ({ add, remove, clear, samples, every }) =>
      run(async () => {
        if (clear) watched.splice(0), (last = {});
        for (const a of add ?? []) if (!watched.includes(a)) watched.push(a);
        for (const r of remove ?? []) {
          const i = watched.indexOf(r);
          if (i >= 0) watched.splice(i, 1);
        }
        if (!watched.length) return "The watch list is empty: add expressions, e.g. {add: ['PLC_PRG.nCount']}.";
        needSim();
        const reads: Record<string, string | undefined>[] = [];
        let errors: Record<string, string> = {};
        for (let k = 0; k < samples; k++) {
          if (k) await new Promise((r) => setTimeout(r, every));
          const r = await b.call<{ values: Record<string, string | undefined>; errors?: Record<string, string> }>("sim.read", { names: watched }, { timeoutMs: 10_000 });
          reads.push(r.values ?? {});
          errors = r.errors ?? {};
        }
        const now = reads[reads.length - 1]!;
        const lines = watched.map((w) => {
          if (errors[w]) return `  ${w}: ${errors[w]}`;
          const series = reads.map((r) => r[w]);
          const changed = last[w] !== undefined && last[w] !== now[w] ? `  (was ${last[w]})` : "";
          if (samples === 1) return `  ${w} = ${now[w]}${changed}`;
          const nums = series.map((v) => Number(String(v).replace(/^[A-Z_]+#/i, ""))).filter((n) => Number.isFinite(n));
          const changes = series.filter((v, i) => i && v !== series[i - 1]).length;
          return `  ${w} = ${now[w]}  [${nums.length === samples ? `min ${Math.min(...nums)}, max ${Math.max(...nums)}, ` : ""}${changes} change(s) in ${samples} reads]${changed}`;
        });
        last = { ...now };
        return [`Watch (${watched.length}):`, ...lines].join("\n");
      }),
  );

  reg(
    "breakpoint_set",
    {
      description: "Set a breakpoint in the running simulation at a line of a POU's implementation. The simulation halts there; debug_status shows where, codesys_sim_read reads values, debug_step steps, debug_continue goes on. For a function block give the instance, e.g. 'PLC_PRG.fbPump'.",
      inputSchema: z.object({
        path: z.string().describe("POU, e.g. 'FB_Pump' or 'PLC_PRG'"),
        line: z.number().int().min(1).describe("Line of the implementation (1 = first line)"),
        instance: z.string().optional().describe("Instance path for a function block, e.g. 'PLC_PRG.fbPump' (a program is its own instance)"),
      }),
    },
    async ({ path, line, instance }) =>
      run(async () => {
        needSim();
        const p = await b.call<Positions>("debug.positions", { path });
        const map = lineMap(p.implementation, p.positions);
        const lines = [...map.keys()].sort((x, y) => x - y);
        const at = lines.find((l) => l >= line);
        if (at === undefined) throw new Error(`No statement at or after line ${line} of ${p.path}. Statement lines: ${lines.join(", ")}.`);
        const inst = instance ?? p.path.split("/").pop()!;
        await b.call("debug.set", { path, position: map.get(at), instance: inst });
        const code = p.implementation.split(/\r?\n/)[at - 1]?.trim();
        return `Breakpoint at ${p.path} line ${at}${at !== line ? ` (the first statement at or after line ${line})` : ""}: ${code} (instance ${inst}).`;
      }),
  );
  reg(
    "breakpoint_clear",
    { description: "Remove all breakpoints (the simulation then keeps running after debug_continue).", inputSchema: z.object({}) },
    async () =>
      run(async () => {
        needSim();
        const r = await b.call<{ cleared: string[] }>("debug.clear", {});
        return r.cleared.length ? `Removed ${r.cleared.length} breakpoint(s).` : "There were no breakpoints.";
      }),
  );
  reg(
    "debug_status",
    { description: "Whether the simulation is running or halted at a breakpoint, and where (POU, line, code).", inputSchema: z.object({}) },
    async () =>
      run(async () => {
        needSim();
        return where(await b.call("debug.status", {}));
      }),
  );
  reg(
    "debug_step",
    {
      description: "Step while halted: over (next statement), into (into a called POU), out (back to the caller).",
      inputSchema: z.object({ kind: z.enum(["over", "into", "out"]).default("over") }),
    },
    async ({ kind }) =>
      run(async () => {
        needSim();
        return where(await b.call("debug.step", { kind }));
      }),
  );
  reg(
    "debug_continue",
    { description: "Continue running after a halt (it halts again at the next breakpoint hit).", inputSchema: z.object({}) },
    async () =>
      run(async () => {
        needSim();
        const r = await b.call<{ state: string }>("debug.continue", {});
        return `Simulation: ${r.state}.`;
      }),
  );
}
