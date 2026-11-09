/**
 * CODESYS's own simulation: runs the active application inside CODESYS, with no
 * controller and nothing extra to install. It uses the real CODESYS compiler
 * and libraries. It can run, read, write, force and take single cycles. It has
 * no breakpoints: CODESYS's scripting offers none, and its breakpoint commands
 * work at an editor cursor, which a session without a window doesn't have.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { AppContext } from "../tools.js";

interface Status {
  running: boolean;
  state?: string;
  operation?: string;
  forced?: string[];
  cycles?: number;
}

export interface CodesysSimState {
  state: string;
  forced: string[];
  cycles: number;
  /** The bridge's restart count when this was recorded: a restart ends the simulation. */
  restarts?: number;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface SimToolDeps {
  reg: McpServer["registerTool"];
  run: (fn: () => Promise<string>) => Promise<ToolResult>;
  /** Compile; the build report when it has errors, otherwise undefined. */
  compileErrors: () => Promise<string | undefined>;
}

/** The simulation the panel should show; undefined when none runs. */
export function currentCodesysSim(ctx: AppContext): CodesysSimState | undefined {
  const s = ctx.codesysSim;
  return s && s.restarts === ctx.bridge.health().restarts ? s : undefined;
}

export function describeSim(s: Status): string {
  if (!s.running) return "CODESYS simulation: not running.";
  return `CODESYS simulation: application ${s.state}.${s.forced?.length ? ` Forced: ${s.forced.join(", ")}.` : ""}`;
}

const names = z.array(z.string()).min(1).describe("Variables as CODESYS expressions relative to the application, e.g. 'PLC_PRG.nCount' or 'GVL_IO.xValve'");
const values = z.record(z.string(), z.string()).describe("Variable to value, with values as Structured Text: { 'PLC_PRG.xStart': 'TRUE', 'PLC_PRG.nSpeed': '5' }");

export function registerCodesysSim(ctx: AppContext, deps: SimToolDeps): void {
  const b = ctx.bridge;
  const { reg, run } = deps;
  const NOTE = "CODESYS's own simulation: no controller is involved.";

  const status = async (op: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<string> => {
    const s = await b.call<Status>(op, args, { timeoutMs });
    ctx.codesysSim = s.running ? { state: s.state ?? "unknown", forced: s.forced ?? [], cycles: s.cycles ?? 0, restarts: b.health().restarts } : undefined;
    return describeSim(s);
  };

  reg(
    "codesys_sim_start",
    {
      description: `Compile, then load the active application into ${NOTE} Uses the real CODESYS compiler and libraries, and needs nothing installed beyond CODESYS. The application is loaded and stopped unless run is true. While the simulation runs the project is locked: compile, write_object and the other changing tools are refused until codesys_sim_stop. It has no breakpoints, and time runs at real speed.`,
      inputSchema: z.object({ run: z.boolean().optional().describe("Start the application straight away (default false)") }),
    },
    async ({ run: start }: { run?: boolean }) =>
      run(async () => {
        const errors = await deps.compileErrors();
        if (errors) throw new Error(`Fix the compile errors before simulating.\n${errors}`);
        return `${await status("sim.start", { run: !!start }, 300_000)} The project is locked until codesys_sim_stop.`;
      }),
  );

  reg(
    "codesys_sim_stop",
    { description: "Stop CODESYS's own simulation, release all forced values and unlock the project.", inputSchema: z.object({}) },
    async () => run(() => status("sim.stop", {}, 120_000)),
  );

  reg(
    "codesys_sim_status",
    { description: "Whether CODESYS's own simulation is running, the application's state and the forced variables.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => run(() => status("sim.status")),
  );

  reg(
    "codesys_sim_control",
    {
      description: "Run, stop or reset the application in CODESYS's own simulation. A reset also releases forced values.",
      inputSchema: z.object({ action: z.enum(["run", "stop", "reset_warm", "reset_cold"]) }),
    },
    async ({ action }: { action: string }) => run(() => status("sim.control", { action })),
  );

  reg(
    "codesys_sim_cycle",
    {
      description: "Run exactly this many task cycles in CODESYS's own simulation, then stay stopped. Stops the application first if it is running. Each cycle takes about 0.1 s. Timers follow the clock, not the cycle count: to let a TON elapse, wait, then run another cycle.",
      inputSchema: z.object({ count: z.number().int().min(1).max(1000).optional().describe("Cycles to run (default 1)") }),
    },
    async ({ count }: { count?: number }) => run(() => status("sim.cycle", { count: count ?? 1 }, Math.max(60_000, (count ?? 1) * 1_000))),
  );

  reg(
    "codesys_sim_read",
    { description: "Read current values from CODESYS's own simulation. A read takes about 0.4 s, so read everything you need in one call.", inputSchema: z.object({ names }), annotations: { readOnlyHint: true } },
    async ({ names: list }: { names: string[] }) =>
      run(async () => {
        const r = await b.call<{ values: Record<string, string>; errors: Record<string, string> }>("sim.read", { names: list });
        return list.map((n) => (n in r.values ? `${n} = ${r.values[n]}` : `${n}: ${r.errors[n] ?? "no value"}`)).join("\n");
      }),
  );

  reg(
    "codesys_sim_write",
    { description: "Write values once in CODESYS's own simulation. If the program assigns the variable, the next cycle overwrites it; use codesys_sim_force to hold a value.", inputSchema: z.object({ values }) },
    async ({ values: v }: { values: Record<string, string> }) => run(() => status("sim.write", { values: v })),
  );

  reg(
    "codesys_sim_force",
    { description: "Force values in CODESYS's own simulation, until codesys_sim_unforce or codesys_sim_stop. Right for inputs. CODESYS re-applies a force between scans, so if the program assigns the variable, code before that assignment sees the forced value and code after it, in the same scan, sees the program's own value.", inputSchema: z.object({ values }) },
    async ({ values: v }: { values: Record<string, string> }) => run(() => status("sim.force", { values: v })),
  );

  reg(
    "codesys_sim_unforce",
    { description: "Release forced values in CODESYS's own simulation: the named ones, or all of them.", inputSchema: z.object({ names: names.optional() }) },
    async ({ names: list }: { names?: string[] }) => run(() => status("sim.unforce", list ? { names: list } : {})),
  );
}
