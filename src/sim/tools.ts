/** Model-facing MCP tools for the truST simulation. */
import type { McpServer } from "@modelcontextprotocol/server";
import { annotationsFor, type ToolAnnotations } from "../annotations.js";
import * as z from "zod/v4";
import { BridgeError, type CodesysBridge } from "../bridge/bridge.js";
import type { TreeNode } from "../codesys/st.js";
import { TrustError } from "./control.js";
import { SimController, SimError, type CodesysSource } from "./controller.js";
import { ExprError } from "./expr.js";
import { MirrorError, type TaskInfo } from "./mirror.js";
import { PlantConfigError } from "./plant.js";
import { ScenarioError } from "./scenarios.js";
import { TuningError } from "./tuning.js";
import { heldMessage, type Driver } from "../driver.js";

/** CODESYS ops the simulation may use. Read-only; nothing that writes or goes online. */
export const SIM_CODESYS_OPS = ["export", "tasks.list", "project.info"] as const;

export function codesysSource(bridge: CodesysBridge, project: () => string | undefined, startWaitMs: number, onExport?: (nodes: TreeNode[]) => void): CodesysSource {
  const call = async <T>(op: (typeof SIM_CODESYS_OPS)[number]): Promise<T> => {
    if (!(await bridge.waitReady(startWaitMs))) throw new SimError("codesys_starting", "CODESYS is still starting; try again shortly (codesys_status shows progress).");
    return bridge.call<T>(op, {}, { timeoutMs: 120_000 });
  };
  return {
    exportSt: async () => {
      const nodes = (await call<{ nodes: TreeNode[] }>("export")).nodes;
      onExport?.(nodes);
      return nodes;
    },
    tasks: async () => (await call<{ tasks: TaskInfo[] }>("tasks.list")).tasks,
    defines: async () => {
      const i = await call<{ defines?: string[]; project_defines?: string[] }>("project.info");
      return { defines: i.defines ?? [], ...(i.project_defines ? { projectDefines: i.project_defines } : {}) };
    },
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
    if (e instanceof ScenarioError) return text(`scenario: ${e.message}`, true);
    if (e instanceof TuningError) return text(`${e.code}: ${e.message}`, true);
    return text(`error: ${(e as Error).message}`, true);
  }
}

const varName = z.string().describe("Variable path as in CODESYS: 'GVL_IO.rLevel', 'PRG_Tank.nTrips', 'PRG_Tank.fbPI.rY'");
const experimentShape = {
  duration_s: z.number().positive().max(86_400),
  speed: z.number().min(1).max(1000).optional().describe("Time scale during the run (default 100)"),
  pv: varName.optional().describe("Process value to analyse"),
  sp: z.object({ var: varName, value: z.union([z.number(), z.string()]), at_s: z.number().min(0).optional() }).optional().describe("Setpoint step"),
  set: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe("Values written at t=0, e.g. {\"PRG_Tank.fbPI._rKp\": 80}"),
  force: z.array(z.object({ var: varName, value: z.union([z.number(), z.string()]), at_s: z.number().min(0).optional(), until_s: z.number().min(0).optional() })).optional(),
  watch: z.array(varName).max(20).optional().describe("Signals to report (alarms, modes, counters)"),
  samples: z.number().int().min(10).max(2000).optional(),
  restart: z.boolean().optional().describe("Fresh start first (default true)"),
};
const value = z.string().describe("Structured Text literal: 0.6, TRUE, 'text', T#2s, E_Mode.AUTO");

export function registerSimTools(server: McpServer, sim: SimController, driver?: Driver): void {
  /** Tools that change the simulation are held while the user has paused Claude (panel). */
  const HELD = new Set(["sim_start", "sim_stop", "run_scans", "run_for", "set_breakpoint", "clear_breakpoint", "continue", "step_over", "step_in", "step_out", "write_var", "force_var", "unforce_var", "set_plant_param", "run_experiment", "run_scenarios", "save_scenario", "tune_setup", "tune_run"]);
  const reg = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) =>
    server.registerTool(
      name,
      { ...(config as object), annotations: annotationsFor(name, (config as { annotations?: ToolAnnotations }).annotations) } as never,
      (async (...a: unknown[]) => {
        if (HELD.has(name) && driver?.held) return text(heldMessage(driver, name), true);
        driver?.note(name); // the panel picks its view from what Claude does
        return cb(...a);
      }) as never,
    )) as unknown as McpServer["registerTool"];
  reg(
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

  reg(
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

  reg("sim_stop", { description: "Stop the simulation and its trust-runtime process.", inputSchema: z.object({}) }, async () => run(() => sim.stop()));

  reg(
    "sim_status",
    { description: "Simulation state: running or paused, where, scan and simulated time, breakpoints, forces, plant overrides.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => run(() => sim.status()),
  );

  reg(
    "run_scans",
    {
      description: "Run exactly n PLC scans in simulated time, then pause. Stops early at a breakpoint (and shows where).",
      inputSchema: z.object({ n: z.number().int().min(1).max(10_000_000) }),
    },
    async ({ n }) => run(() => sim.runScans(n)),
  );

  reg(
    "run_for",
    {
      description: "Run for a span of simulated time, then pause. Optional speed sets the time scale (simulated seconds per wall second). Stops early at a breakpoint.",
      inputSchema: z.object({ seconds: z.number().positive(), speed: z.number().min(1).max(1000).optional() }),
    },
    async ({ seconds, speed }) => run(() => sim.runFor(seconds, speed)),
  );

  reg(
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

  reg(
    "clear_breakpoint",
    {
      description: "Clear breakpoints by id, by object (and line), or all.",
      inputSchema: z.object({ id: z.number().int().optional(), path: z.string().optional(), line: z.number().int().optional(), all: z.boolean().optional() }),
    },
    async ({ id, path, line, all }) => run(() => sim.clearBreakpoint({ id, obj: path, line, all })),
  );

  reg(
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
    reg(name, { description: desc + " Needs a paused simulation.", inputSchema: z.object({}) }, async () => run(() => sim.step(name)));
  }

  reg(
    "read_vars",
    {
      description: "Read simulation variables (globals, program variables, FB instance members).",
      inputSchema: z.object({ names: z.array(varName).min(1).max(100) }),
      annotations: { readOnlyHint: true },
    },
    async ({ names }) => run(() => sim.readVars(names)),
  );

  reg(
    "write_var",
    { description: "Write a value once (the program may overwrite it). Applied at the start of the next scan.", inputSchema: z.object({ name: varName, value }) },
    async ({ name, value: v }) => run(() => sim.writeVar(name, v)),
  );

  reg(
    "force_var",
    { description: "Force a variable to a value until unforce_var (e.g. a sensor fault).", inputSchema: z.object({ name: varName, value }) },
    async ({ name, value: v }) => run(() => sim.forceVar(name, v)),
  );

  reg("unforce_var", { description: "Release a forced variable.", inputSchema: z.object({ name: varName }) }, async ({ name }) => run(() => sim.unforceVar(name)));

  reg(
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

  reg(
    "run_experiment",
    {
      description:
        "Run a repeatable experiment from a cold restart: apply settings, step a setpoint and/or force faults at given times, run for duration_s simulated seconds, and return a summary (overshoot, rise and settling time, steady-state error, IAE, watched signals), compared with the previous run of the same name. Breakpoints are ignored during the run.",
      inputSchema: z.object({ name: z.string().optional().describe("Name for comparing runs, e.g. 'level step'"), ...experimentShape }),
    },
    async (spec) => run(() => sim.runExperiment(spec)),
  );

  reg(
    "save_scenario",
    {
      description:
        "Save an experiment plus expectations as a named scenario in <Project>.scenarios.toml next to the project, to rerun after every change with run_scenarios. Expectations: metrics (overshoot_pct, rise_time_s, settling_time_s, steady_state_error, iae, pv_min, pv_max, pv_final) take {min, max, abs_max, equals}; watched variables take {final, min, max} over the run, e.g. {\"PRG_Tank.nTrips\": {\"final\": 0}}. Saving an existing name replaces it; delete: true removes it.",
      inputSchema: z.object({
        name: z.string().min(1),
        ...experimentShape,
        expect: z.record(z.string(), z.object({ min: z.number().optional(), max: z.number().optional(), abs_max: z.number().optional(), equals: z.union([z.number(), z.string()]).optional(), final: z.union([z.number(), z.string()]).optional() })).optional(),
        delete: z.boolean().optional(),
      }),
    },
    async ({ delete: del, ...s }) => run(() => sim.saveScenario(s, { delete: del })),
  );

  reg(
    "run_scenarios",
    {
      description:
        "Run the saved scenarios (all, or those whose name contains filter) from fresh starts and check their expectations: PASS/FAIL per scenario with the failing checks. Starts the simulation if it isn't running. Use after changing code to catch regressions.",
      inputSchema: z.object({ filter: z.string().optional() }),
    },
    async ({ filter }) => {
      try {
        const r = await sim.runScenarios({ filter });
        return text(r.text);
      } catch (e) {
        return run(async () => {
          throw e;
        });
      }
    },
  );

  reg(
    "run_tests",
    {
      description: [
        "Run the project's unit tests in truST and report pass/fail per test, by CODESYS object. Syncs the mirror from CODESYS first.",
        "A test is a PROGRAM (or FUNCTION_BLOCK) in the CODESYS project whose declaration starts with {attribute 'test'}; nothing calls it, so CODESYS doesn't compile it.",
        "Assertions: ASSERT_EQUAL(EXPECTED := .., ACTUAL := ..), ASSERT_NOT_EQUAL, ASSERT_NEAR(EXPECTED, ACTUAL, DELTA), ASSERT_TRUE(IN := ..), ASSERT_FALSE, ASSERT_GREATER, ASSERT_LESS, ASSERT_GREATER_OR_EQUAL, ASSERT_LESS_OR_EQUAL.",
        "Each test runs once from a cold start, and time does not advance inside it, so test logic, not timers; use run_experiment or run_scans for time-dependent behaviour.",
      ].join(" "),
      inputSchema: z.object({
        filter: z.string().optional().describe("Only tests whose name contains this (case-insensitive)"),
        sync: z.boolean().optional().describe("Re-export from CODESYS first (default true)"),
      }),
    },
    async ({ filter, sync }) => {
      try {
        const r = await sim.runTests({ filter, sync });
        return text(r.text, !r.ok && !r.run?.ran);
      } catch (e) {
        return run(async () => {
          throw e;
        });
      }
    },
  );

  reg(
    "experiment_log",
    { description: "List the experiments run in this session with their metrics.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
    async () => run(async () => sim.experimentLog()),
  );

  // ---------------------------------------------------------------- tuning (truST Control Studio)

  const range = z.object({
    symbol: varName,
    unit: z.string().optional(),
    min: z.number().describe("Lowest value of the signal's range"),
    max: z.number().describe("Highest value of the signal's range"),
  });
  reg(
    "tune_setup",
    {
      description: [
        "Set up a control loop for tuning with truST's Control Studio (simulation only; nothing is written to CODESYS or a controller).",
        "Control Studio identifies the plant (by default with a setpoint step in Auto), then searches the program's own controller coefficients (e.g. FB_PI._rKp and _rTi) against the fitted model and validates the best candidate with the actual ST.",
        "Requirements of truST 0.34 on the program: every signal named here must be a variable of ONE PROGRAM instance, not a GVL member (the measurement and output mapped to I/O there, e.g. `lrLevel AT %IL0 : LREAL;`);",
        "a BOOL mode (Manual/Auto) with a REAL/LREAL manual output that drives the output in Manual; ideally a bumpless controller (tracks the manual output in Manual);",
        "and if the program sets the coefficients at startup, a BOOL done-flag (`IF NOT bInitDone THEN fbPI.Kp := ...; bInitDone := TRUE; END_IF`) named as startup_flag.",
        "If the program lacks these, explain what is missing and ask the user before restructuring. Starts the simulation if needed.",
      ].join(" "),
      inputSchema: z.object({
        name: z.string().min(1).describe("Loop name, e.g. 'LT101 level' (id becomes loop:lt101-level)"),
        pv: range.describe("Measurement: an input the program only reads"),
        sp: varName.describe("Setpoint variable"),
        mv: range.describe("Controller output (manipulated variable) with its range"),
        mode: z.object({ symbol: varName, true_means: z.enum(["Manual", "Auto"]) }).describe("BOOL mode switch"),
        manual_output: varName.describe("REAL/LREAL that drives the output in Manual"),
        coefficients: z
          .array(z.object({ symbol: varName, values: z.array(z.number()).min(2).max(12), unit: z.string().optional() }))
          .min(1)
          .max(4)
          .describe("Coefficients to search and the values to try, e.g. {symbol:'PRG_Tank.fbPI._rKp', values:[25,50,100,200,400]}. Up to 4; the search tries every combination."),
        startup_flag: varName.optional().describe("BOOL done-flag the program sets after writing its coefficients at startup"),
        action: z.enum(["direct", "reverse"]).optional().describe("direct (default): more output raises the measurement"),
        step: z.number().positive().optional().describe("Identification step of the output (default 10% of its range). Keep it small enough that the plant stays clear of trips and limits."),
        experiment_s: z.number().positive().max(86_400).optional().describe("How long the identification step runs, in simulated seconds (default 300); about 4-5 time constants of the plant"),
        requirements: z
          .object({
            reference_change: z.number().optional(),
            maximum_error: z.number().optional(),
            settling_band: z.number().optional(),
            settling_time_s: z.number().optional(),
            duration_s: z.number().optional(),
            maximum_overshoot_pct: z.number().optional(),
            transfer_tolerance: z.number().optional().describe("Allowed output jump at the Manual-to-Auto hand-back"),
          })
          .optional()
          .describe("What a good response is; defaults scale with the pv/mv ranges"),
        replace: z.boolean().optional().describe("Set an existing loop up again (drops its results)"),
      }),
    },
    async (a) => run(() => sim.tuning.setup(a)),
  );

  reg(
    "tune_run",
    {
      description: [
        "Run a step of truST's Control Studio tuning on a loop from tune_setup:",
        "'identify' runs the simulation freely and steps the setpoint in Auto (method 'setpoint-step', the default, repeatable on truST 0.34) or the output in Manual (method 'step') to fit a plant model; it needs the loop settled in Auto and waits and retries while it settles;",
        "'search' tries every coefficient combination against the model and selects the best that meets the requirements;",
        "'validate' runs the actual ST in isolated simulations, current settings vs the candidate, and checks each requirement;",
        "'cancel' ends a journaled operation that blocks the loop.",
        "Results show in the panel's Tuning view. The gains are a proposal: change them in CODESYS with write_object to keep them.",
      ].join(" "),
      inputSchema: z.object({
        loop: z.string().describe("Loop id or name, e.g. 'loop:lt101-level'"),
        step: z.enum(["identify", "search", "validate", "cancel"]),
        method: z.enum(["setpoint-step", "step", "automatic"]).optional().describe("identify: setpoint-step (default) or step (the output in Manual)"),
        speed: z.number().min(1).max(100).optional().describe("identify: time scale while free-running (default 20)"),
        settle_s: z.number().min(0).max(3600).optional().describe("identify: simulated seconds to let the loop settle first (default 60)"),
      }),
    },
    async ({ loop, step, method, speed, settle_s }) =>
      run(() =>
        step === "identify" ? sim.tuning.identify(loop, { method, speed, settle_s })
        : step === "search" ? sim.tuning.search(loop)
        : step === "validate" ? sim.tuning.validate(loop)
        : sim.tuning.cancel(loop),
      ),
  );

  reg(
    "tune_status",
    { description: "Tuning loops (truST Control Studio) with their model, search and validation results from this session.", inputSchema: z.object({ loop: z.string().optional() }), annotations: { readOnlyHint: true } },
    async ({ loop }) => run(() => sim.tuning.status(loop)),
  );
}
