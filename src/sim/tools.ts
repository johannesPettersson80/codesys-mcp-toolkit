/** Model-facing MCP tools for the truST simulation. */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BridgeError, type CodesysBridge } from "../bridge/bridge.js";
import type { TreeNode } from "../codesys/st.js";
import { TrustError } from "./control.js";
import { SimController, SimError, type CodesysSource } from "./controller.js";
import { ExprError } from "./expr.js";
import { MirrorError, type TaskInfo } from "./mirror.js";
import { PlantConfigError } from "./plant.js";

/** CODESYS ops the simulation may use. Read-only; nothing that writes or goes online. */
export const SIM_CODESYS_OPS = ["export", "tasks.list"] as const;

export function codesysSource(bridge: CodesysBridge, project: () => string | undefined, startWaitMs: number): CodesysSource {
  const call = async <T>(op: (typeof SIM_CODESYS_OPS)[number]): Promise<T> => {
    if (!(await bridge.waitReady(startWaitMs))) throw new SimError("codesys_starting", "CODESYS is still starting; try again shortly (codesys_status shows progress).");
    return bridge.call<T>(op, {}, { timeoutMs: 120_000 });
  };
  return {
    exportSt: async () => (await call<{ nodes: TreeNode[] }>("export")).nodes,
    tasks: async () => (await call<{ tasks: TaskInfo[] }>("tasks.list")).tasks,
    projectPath: project,
  };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    if (e instanceof SimError || e instanceof TrustError || e instanceof BridgeError) return text(`${e.code}: ${e.message}`, true);
    if (e instanceof MirrorError || e instanceof PlantConfigError) return text(`mirror: ${e.message}`, true);
    if (e instanceof ExprError) return text(`condition: ${e.message}`, true);
    return text(`error: ${(e as Error).message}`, true);
  }
}

const varName = z.string().describe("Variable path as in CODESYS: 'GVL_IO.rLevel', 'PRG_Tank.nTrips', 'PRG_Tank.fbPI.rY'");
const value = z.string().describe("Structured Text literal: 0.6, TRUE, 'text', T#2s, E_Mode.AUTO");

export function registerSimTools(server: McpServer, sim: SimController): void {
  server.registerTool(
    "sync_mirror",
    {
      description:
        "Export the open project's Structured Text into a truST simulation project (the mirror): one file per POU with methods, properties and actions nested, tasks as a configuration, and the plant from plant.toml. Pass `plant` to save new plant.toml text next to the project first. Returns what changed and anything that can't be simulated.",
      inputSchema: z.object({
        plant: z.string().optional().describe("plant.toml text to save next to the project (see the README for the format)"),
        plantFile: z.string().optional().describe("Use this plant.toml instead of the one next to the project"),
      }),
    },
    async ({ plant, plantFile }) =>
      run(async () => {
        const out: string[] = [];
        if (plant) out.push(`Saved ${await sim.savePlant(plant)}.`);
        const r = await sim.sync(plantFile);
        out.push(`Mirror: ${r.dir}`);
        out.push(`${r.changed.length ? `Changed: ${r.changed.join(", ")}` : "No ST changes since the last sync."}${r.committed ? ` (git ${r.committed})` : ""}`);
        out.push(`Tasks: ${r.manifest.clockTask} ${r.manifest.cycleMs} ms drives the clock.`);
        out.push(r.plantFile ? `Plant: ${r.plantFile}` : "Plant: none (no plant.toml next to the project; the code runs without a process model)");
        for (const n of r.manifest.notes) out.push(`- ${n}`);
        for (const w of r.manifest.warnings) out.push(`Warning: ${w}`);
        if (sim.running && r.changed.length) out.push("The running simulation still has the old code; call sim_start to rebuild and restart.");
        return out.join("\n");
      }),
  );

  server.registerTool(
    "sim_start",
    {
      description:
        "Sync the mirror, build it with truST and start the simulation (simulated I/O only; never a controller). Starts from a cold restart, paused at scan 0. Restarting an already running simulation resets PLC and plant state.",
      inputSchema: z.object({
        speed: z.number().min(1).max(1000).optional().describe("Time scale: simulated seconds per wall second (default 10)"),
        sync: z.boolean().optional().describe("Re-export from CODESYS first (default true)"),
      }),
    },
    async ({ speed, sync }) => run(() => sim.start({ timeScale: speed, sync })),
  );

  server.registerTool("sim_stop", { description: "Stop the simulation and its trust-runtime process.", inputSchema: z.object({}) }, async () => run(() => sim.stop()));

  server.registerTool(
    "sim_status",
    { description: "Simulation state: running or paused, where, scan and simulated time, breakpoints, forces, plant overrides.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => run(() => sim.status()),
  );

  server.registerTool(
    "run_scans",
    {
      description: "Run exactly n PLC scans in simulated time, then pause. Stops early at a breakpoint (and shows where).",
      inputSchema: z.object({ n: z.number().int().min(1).max(10_000_000) }),
    },
    async ({ n }) => run(() => sim.runScans(n)),
  );

  server.registerTool(
    "run_for",
    {
      description: "Run for a span of simulated time, then pause. Optional speed sets the time scale (simulated seconds per wall second). Stops early at a breakpoint.",
      inputSchema: z.object({ seconds: z.number().positive(), speed: z.number().min(1).max(1000).optional() }),
    },
    async ({ seconds, speed }) => run(() => sim.runFor(seconds, speed)),
  );

  server.registerTool(
    "set_breakpoint",
    {
      description:
        "Set a breakpoint on a line of an object's implementation (line numbers as in CODESYS, 1-based). Optional condition is an ST expression, e.g. \"GVL_IO.rLevel > 0.9 AND PRG_Tank.eMode = E_Mode.AUTO\"; the run only stops when it is TRUE.",
      inputSchema: z.object({
        path: z.string().describe("Object path: 'PRG_Tank', 'FB_PI', 'FB_PI/Reset' (method), 'FB_PI/Kp/Set' (accessor)"),
        line: z.number().int().min(1),
        condition: z.string().optional(),
      }),
    },
    async ({ path, line, condition }) => run(() => sim.setBreakpoint(path, line, condition)),
  );

  server.registerTool(
    "clear_breakpoint",
    {
      description: "Clear breakpoints by id, by object (and line), or all.",
      inputSchema: z.object({ id: z.number().int().optional(), path: z.string().optional(), line: z.number().int().optional(), all: z.boolean().optional() }),
    },
    async ({ id, path, line, all }) => run(() => sim.clearBreakpoint({ id, obj: path, line, all })),
  );

  server.registerTool(
    "continue",
    {
      description: "Resume and wait until a breakpoint is hit (or timeout, then pause). Returns the location, source lines and local variables.",
      inputSchema: z.object({ timeoutMs: z.number().int().min(100).max(300_000).optional().describe("Wall-time limit (default 30000)") }),
    },
    async ({ timeoutMs }) => run(() => sim.cont(timeoutMs ?? 30_000)),
  );

  for (const [name, desc] of [
    ["step_over", "Execute the current statement and stop at the next one in the same POU."],
    ["step_in", "Step into the call on the current line (FB, method, function)."],
    ["step_out", "Run to the end of the current POU and stop in its caller."],
  ] as const) {
    server.registerTool(name, { description: desc + " Needs a paused simulation.", inputSchema: z.object({}) }, async () => run(() => sim.step(name)));
  }

  server.registerTool(
    "read_vars",
    {
      description: "Read simulation variables (globals, program variables, FB instance members).",
      inputSchema: z.object({ names: z.array(varName).min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ names }) => run(() => sim.readVars(names)),
  );

  server.registerTool(
    "write_var",
    { description: "Write a value once (the program may overwrite it). Applied at the start of the next scan.", inputSchema: z.object({ name: varName, value }) },
    async ({ name, value: v }) => run(() => sim.writeVar(name, v)),
  );

  server.registerTool(
    "force_var",
    { description: "Force a variable to a value until unforce_var (e.g. a sensor fault).", inputSchema: z.object({ name: varName, value }) },
    async ({ name, value: v }) => run(() => sim.forceVar(name, v)),
  );

  server.registerTool("unforce_var", { description: "Release a forced variable.", inputSchema: z.object({ name: varName }) }, async ({ name }) => run(() => sim.unforceVar(name)));

  server.registerTool(
    "set_plant_param",
    {
      description:
        "Change a plant parameter for this simulation session (plant.toml is not changed), e.g. plant 'T101', param 'area_m2' or 'parameters.outflow_coefficient_m2_sqrt_m_per_s'. truST applies plant changes only on restart, so a running simulation restarts from scan 0.",
      inputSchema: z.object({
        plant: z.string(),
        param: z.string(),
        value: z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]),
      }),
    },
    async ({ plant, param, value: v }) => run(() => sim.setPlantParam(plant, param, v)),
  );

  server.registerTool(
    "run_experiment",
    {
      description:
        "Run a repeatable experiment from a cold restart: apply settings, step a setpoint and/or force faults at given times, run for duration_s simulated seconds, and return a summary (overshoot, rise and settling time, steady-state error, IAE, watched signals), compared with the previous run of the same name. Breakpoints are ignored during the run.",
      inputSchema: z.object({
        name: z.string().optional().describe("Name for comparing runs, e.g. 'level step'"),
        duration_s: z.number().positive().max(86_400),
        speed: z.number().min(1).max(1000).optional().describe("Time scale during the run (default 100)"),
        pv: varName.optional().describe("Process value to analyse"),
        sp: z.object({ var: varName, value: z.union([z.number(), z.string()]), at_s: z.number().min(0).optional() }).optional().describe("Setpoint step"),
        set: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe("Values written at t=0, e.g. {\"PRG_Tank.fbPI._rKp\": 80}"),
        force: z.array(z.object({ var: varName, value: z.union([z.number(), z.string()]), at_s: z.number().min(0).optional(), until_s: z.number().min(0).optional() })).optional(),
        watch: z.array(varName).max(20).optional().describe("Signals to report (alarms, modes, counters)"),
        samples: z.number().int().min(10).max(2000).optional(),
        restart: z.boolean().optional().describe("Cold restart first (default true)"),
      }),
    },
    async (spec) => run(() => sim.runExperiment(spec)),
  );

  server.registerTool(
    "experiment_log",
    { description: "List the experiments run in this session with their metrics.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => run(async () => sim.experimentLog()),
  );
}
