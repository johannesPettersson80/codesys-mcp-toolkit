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
  const where = (s: { state: string; at?: { path?: string; position: number; instance?: string; positions?: number[]; implementation?: string } }) => {
    if (!/halt/i.test(s.state)) return `Simulation: ${s.state}.`;
    const at = s.at;
    if (!at?.path) return `Simulation: ${s.state} (position unknown).`;
    const map = lineMap(at.implementation ?? "", at.positions ?? []);
    const line = [...map].find(([, p]) => p === at.position)?.[0];
    const code = line ? (at.implementation ?? "").split(/\r?\n/)[line - 1]?.trim() : undefined;
    const end = low(at.position) === 0xffffffff ? " at its end (RETURN)" : "";
    return `Halted in ${at.path}${line ? ` at line ${line}: ${code}` : end} (instance ${at.instance}). Read values with codesys_sim_read, then debug_step or debug_continue.`;
  };

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
