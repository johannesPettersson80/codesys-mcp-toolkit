/** truST Control Studio tuning: the draft, the 0.34 workarounds and the flow, against a fake trust-control-studio. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StudioAnswer, TrustRuntime } from "../src/sim/runtime.js";
import {
  checkLoopSignals,
  downsample,
  draftFor,
  loopFromFile,
  loopSlug,
  parseModel,
  parseSearch,
  parseValidation,
  raiseBudget,
  requirementsFor,
  selectedTrial,
  Tuning,
  TuningError,
  type SetupArgs,
} from "../src/sim/tuning.js";
import { tempDir } from "./helpers.js";

const TANK: SetupArgs = {
  name: "LT101 level",
  pv: { symbol: "PRG_Tank.lrLevel", unit: "m", min: 0, max: 2.5 },
  sp: "PRG_Tank.rLevelSP",
  mv: { symbol: "PRG_Tank.lrFlowCmd", unit: "m3/s", min: 0, max: 0.05 },
  mode: { symbol: "PRG_Tank.bManual", true_means: "Manual" },
  manual_output: "PRG_Tank.lrManualFlow",
  coefficients: [
    { symbol: "PRG_Tank.fbPI._rKp", unit: "%/m", values: [25, 50, 100, 150, 200, 300] },
    { symbol: "PRG_Tank.fbPI._rTi", unit: "s", values: [20, 40, 60, 90, 120, 180] },
  ],
  startup_flag: "PRG_Tank.bInitDone",
  experiment_s: 400,
  step: 0.005,
};
const INSTANCES = ["MCP_SimHarness", "PRG_Tank"];

/** The loop file setup writes (trimmed from truST 0.34's output). */
function loopFile(id = "loop:lt101-level"): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id,
    name: "LT101 level",
    controller: {
      instance: "PRG_Tank",
      modeSignal: "PRG_Tank.bManual",
      modeWhenTrue: "Manual",
      manualOutputSignal: "PRG_Tank.lrManualFlow",
      project: {
        axes: [
          { symbol: "PRG_Tank.fbPI._rKp", values: [25, 50, 100, 150, 200, 300] },
          { symbol: "PRG_Tank.fbPI._rTi", values: [20, 40, 60, 90, 120, 180] },
        ],
        maximumCycles: 50000,
        wallBudgetMs: 60000,
      },
    },
    signals: {
      setpoint: { symbol: "PRG_Tank.rLevelSP", unit: "m" },
      processVariable: { symbol: "PRG_Tank.lrLevel", unit: "m", address: "%IL0" },
      manipulatedVariable: { symbol: "PRG_Tank.lrFlowCmd", unit: "m3/s", address: "%QL0" },
    },
    parameterBinding: { parameters: [{ symbol: "PRG_Tank.fbPI._rKp", unit: "%/m" }, { symbol: "PRG_Tank.fbPI._rTi", unit: "s" }] },
  };
}

const IDENTIFY = {
  equation: "G(s) = 71.5675 / (72.9663s + 1)",
  keyNumbers: "Gain 71.5675 m per m3/s, time constant 72.9663 s",
  modelType: "First-order model",
  provisional: true,
  plot: {
    timeSeconds: [0, 1, 2, 3],
    traces: [
      { role: "plant-input", symbol: "PRG_Tank.lrFlowCmd", unit: "m3/s", values: [0.03, 0.035, 0.035, 0.035] },
      { role: "measurement", symbol: "PRG_Tank.lrLevel", unit: "m", values: [1, 1.01, 1.02, 1.03] },
      { role: "prediction", symbol: "PRG_Tank.lrLevel", unit: "m", values: [1, 1.005, 1.015, 1.03] },
    ],
  },
};

const trials = TANK.coefficients[0]!.values.flatMap((kp) =>
  TANK.coefficients[1]!.values.map((ti) => ({ attempted: true, bounds: kp === 25 ? "notMet" : "met", parameters: { "PRG_Tank.fbPI._rKp": kp, "PRG_Tank.fbPI._rTi": ti }, score: 1 / (kp * (200 - ti)) })),
);
const TUNE = { kind: "searchAnswer", scoreUnit: "m²·s", selected: 30, status: "completed", trials };

const VALIDATE = {
  status: "Fail",
  failure: { cause: "implementation", message: "First output after Auto entry: 0–0.03 m3/s is outside the declared 0.0295–0.0305 m3/s." },
  plot: { unit: "m", current: { name: "Current", timeSeconds: [0, 1, 2], values: [0.98, 1.0, 1.1] }, tuned: { name: "Tuned", timeSeconds: [0, 1, 2], values: [0.98, 1.15, 1.18] } },
  table: [
    { title: "Model agreement", measured: "6.03 %", limit: "≤ 15 %", verdict: "Pass" },
    { title: "Candidate · Maximum settling time · Measurement (m)", measured: "20.25 s", limit: "≤ 300 s", verdict: "Pass" },
    { title: "Candidate overall", measured: "—", limit: "—", verdict: "Fail" },
  ],
};

describe("tuning: draft and checks", () => {
  it("slugs loop names the way truST does", () => {
    expect(loopSlug("LT101 level")).toBe("lt101-level");
    expect(loopSlug("  FIC 200 / Flow ")).toBe("fic-200-flow");
  });

  it("builds the setup draft that worked on 0.34", () => {
    expect(draftFor(TANK, "PRG_Tank")).toEqual({
      structure: "search",
      name: "LT101 level",
      action: "direct",
      family: "robust",
      instance: "PRG_Tank",
      processVariable: { symbol: "PRG_Tank.lrLevel", unit: "m", minimum: 0, maximum: 2.5 },
      setpoint: { symbol: "PRG_Tank.rLevelSP" },
      manipulatedVariable: { symbol: "PRG_Tank.lrFlowCmd", unit: "m3/s", minimum: 0, maximum: 0.05 },
      mode: { symbol: "PRG_Tank.bManual", whenTrue: "Manual" },
      manualOutput: "PRG_Tank.lrManualFlow",
      coefficients: [
        { symbol: "PRG_Tank.fbPI._rKp", unit: "%/m", values: "25, 50, 100, 150, 200, 300" },
        { symbol: "PRG_Tank.fbPI._rTi", unit: "s", values: "20, 40, 60, 90, 120, 180" },
      ],
      startupFlag: "PRG_Tank.bInitDone",
      experimentDurationSeconds: 400,
      experimentStep: 0.005,
    });
    expect(draftFor({ ...TANK, step: undefined }, "PRG_Tank").experimentStep).toBe(0.005); // 10 % of the 0.05 span
  });

  it("scales default requirements with the ranges, including the Auto-entry tolerance (S11)", () => {
    expect(requirementsFor(TANK)).toEqual({
      referenceChange: 0.2,
      maximumError: 0.1,
      settlingBand: 0.025,
      settlingTimeSeconds: 300,
      durationSeconds: 600,
      maximumOvershootPercent: 10,
      transferTolerance: 0.0005,
    });
    expect(requirementsFor({ ...TANK, requirements: { settling_time_s: 120, transfer_tolerance: 0.001 } })).toMatchObject({ settlingTimeSeconds: 120, transferTolerance: 0.001 });
  });

  it("accepts signals of one program", () => {
    expect(checkLoopSignals(TANK, INSTANCES)).toBe("PRG_Tank");
  });

  it("refuses GVL signals with what to change (S9)", () => {
    const gvl = { ...TANK, pv: { ...TANK.pv, symbol: "GVL_IO.lrLT101_Level" }, sp: "GVL_Par.rLevelSP" };
    let err: TuningError | undefined;
    try {
      checkLoopSignals(gvl, INSTANCES);
    } catch (e) {
      err = e as TuningError;
    }
    expect(err?.code).toBe("loop_signals");
    expect(err?.message).toContain("GVL_IO.lrLT101_Level");
    expect(err?.message).toContain("setpoint (sp) GVL_Par.rLevelSP");
    expect(err?.message).toContain("AT %IL0");
    expect(err?.message).toContain("ask the user");
  });

  it("refuses signals spread over two programs, and the simulation harness", () => {
    expect(() => checkLoopSignals({ ...TANK, sp: "PRG_Other.rSP" }, [...INSTANCES, "PRG_Other"])).toThrow(/setpoint \(sp\) PRG_Other\.rSP/);
    expect(() => checkLoopSignals({ ...TANK, sp: "MCP_SimHarness.x" }, INSTANCES)).toThrow(TuningError);
  });

  it("raises the search budget once (S6)", () => {
    const j = loopFile();
    expect(raiseBudget(j)).toBe(true);
    expect((j.controller as { project: Record<string, number> }).project).toMatchObject({ maximumCycles: 10_000_000, wallBudgetMs: 3_600_000 });
    expect(raiseBudget(j)).toBe(false);
  });

  it("downsamples long series and keeps the last point", () => {
    const t = Array.from({ length: 1000 }, (_, i) => i);
    const d = downsample(t, t, 100);
    expect(d.t.length).toBeLessThanOrEqual(101);
    expect(d.t.at(-1)).toBe(999);
    expect(d.v.length).toBe(d.t.length);
  });
});

describe("tuning: parsing truST's answers", () => {
  it("reads a loop file", () => {
    const l = loopFromFile(loopFile());
    expect(l).toMatchObject({ id: "loop:lt101-level", name: "LT101 level", signals: { pv: "PRG_Tank.lrLevel", sp: "PRG_Tank.rLevelSP", mv: "PRG_Tank.lrFlowCmd", mode: "PRG_Tank.bManual", pvUnit: "m" } });
    expect(l.coefficients[0]).toEqual({ symbol: "PRG_Tank.fbPI._rKp", values: [25, 50, 100, 150, 200, 300], unit: "%/m" });
  });

  it("reads the model, search and validation", () => {
    const m = parseModel(IDENTIFY);
    expect(m).toMatchObject({ equation: IDENTIFY.equation, provisional: true, type: "First-order model" });
    expect(m.traces.map((t) => t.role)).toEqual(["plant-input", "measurement", "prediction"]);
    expect(m.traces[1]!.v).toEqual([1, 1.01, 1.02, 1.03]);

    const loop = { ...loopFromFile(loopFile()), search: parseSearch(TUNE) };
    expect(loop.search.trials).toHaveLength(36);
    expect(loop.search.trials.filter((t) => t.met)).toHaveLength(30);
    expect(selectedTrial(loop)).toEqual({ parameters: { "PRG_Tank.fbPI._rKp": 300, "PRG_Tank.fbPI._rTi": 20 }, edges: ["PRG_Tank.fbPI._rKp", "PRG_Tank.fbPI._rTi"] });

    const v = parseValidation(VALIDATE);
    expect(v.status).toBe("Fail");
    expect(v.rows[1]).toEqual({ title: "Candidate · Maximum settling time · Measurement (m)", measured: "20.25 s", limit: "≤ 300 s", verdict: "Pass" });
    expect(v.traces.map((t) => [t.role, t.unit])).toEqual([
      ["current", "m"],
      ["tuned", "m"],
    ]);
    expect(v.failure).toContain("Auto entry");
  });
});

/** A fake host and trust-control-studio: answers by verb, records calls, writes the loop file on setup. */
function fakeTuning(answers: Partial<Record<string, StudioAnswer<unknown>[]>>) {
  const dir = tempDir("cmcp-tune-");
  const calls: { verb: string; args: string[] }[] = [];
  const rpc: { method: string; params: unknown }[] = [];
  const freeRuns: { label: string; speed: number }[] = [];
  const writes: [string, string][] = [];
  const trust = {
    studio: async (_dir: string, verb: string, args: string[] = []) => {
      calls.push({ verb, args });
      const draft = args[args.indexOf("--draft") + 1];
      if (verb === "setup" && args.includes("--draft") && draft) {
        mkdirSync(join(dir, "control-loops"), { recursive: true });
        writeFileSync(join(dir, "control-loops", "lt101-level.json"), JSON.stringify(loopFile()));
        expect(existsSync(draft)).toBe(true);
        return { result: { loops: ["loop:lt101-level"] } };
      }
      const queue = answers[verb];
      return queue?.length ? queue.shift()! : { result: verb === "setup" ? { formModel: { instances: INSTANCES }, loops: [] } : {} };
    },
    studioRpc: async (method: string, params: unknown) => {
      rpc.push({ method, params });
      return {};
    },
  } as unknown as TrustRuntime;
  const journal: string[] = [];
  const tuning = new Tuning({
    ensureStarted: async () => undefined,
    mirrorPath: () => dir,
    trust: () => trust,
    freeRun: async (label, speed, fn) => {
      freeRuns.push({ label, speed });
      return fn();
    },
    writeVar: async (name, value) => void writes.push([name, value]),
    runBusy: (_label, fn) => fn(),
    journal: { add: (_k, t) => void journal.push(t) },
  });
  return { dir, tuning, calls, rpc, freeRuns, journal, writes };
}

describe("tuning: the flow against a fake Control Studio", () => {
  it("sets up a loop: draft, budget, requirements through serve", async () => {
    const f = fakeTuning({});
    const text = await f.tuning.setup(TANK);
    expect(f.calls.map((c) => c.verb)).toEqual(["setup", "setup"]);
    const draft = JSON.parse(readFileSync(f.calls[1]!.args[1]!, "utf8"));
    expect(draft.instance).toBe("PRG_Tank");
    const file = JSON.parse(readFileSync(join(f.dir, "control-loops", "lt101-level.json"), "utf8"));
    expect(file.controller.project.maximumCycles).toBe(10_000_000);
    expect(f.rpc).toEqual([{ method: "controlStudio/inputs", params: { projectRoot: f.dir.replace(/\\/g, "/"), runtimeId: "simulator", loopId: "loop:lt101-level", change: requirementsFor(TANK) } }]);
    expect(text).toContain("Loop loop:lt101-level");
    expect(text).toContain("36 candidates");
    expect(f.tuning.version).toBeGreaterThan(0);
  });

  it("refuses to set up an existing loop again unless asked", async () => {
    const f = fakeTuning({});
    await f.tuning.setup(TANK);
    await expect(f.tuning.setup(TANK)).rejects.toThrow(/exists already/);
    mkdirSync(join(f.dir, "control-studio", "loop_lt101-level-1234"), { recursive: true });
    await f.tuning.setup({ ...TANK, replace: true });
    expect(existsSync(join(f.dir, "control-studio", "loop_lt101-level-1234"))).toBe(false);
  });

  it("identifies with the simulation free-running, waiting while the loop settles", async () => {
    const settling = { failure: { cause: "settings", message: "PRG_Tank.lrLevel is still changing by 0.0049 m/min in Auto." } };
    const f = fakeTuning({ identify: [settling, settling, { result: IDENTIFY }] });
    await f.tuning.setup(TANK);
    const text = await f.tuning.identify("loop:lt101-level", { speed: 1000, settle_s: 0 });
    expect(f.freeRuns).toEqual([{ label: "Tuning LT101 level: identifying the plant", speed: 1000 }]);
    expect(f.calls.filter((c) => c.verb === "identify")).toHaveLength(3);
    expect(f.calls.find((c) => c.verb === "identify")!.args).toEqual(["--loop", "loop:lt101-level", "--method", "setpoint-step"]);
    expect(text).toContain("G(s) = 71.5675 / (72.9663s + 1)");
    expect(text).toContain("after 2 wait(s)");
    expect(f.tuning.panelLoops()[0]!.model?.equation).toBe(IDENTIFY.equation);
  });

  it("explains failures, and records them for the panel", async () => {
    const f = fakeTuning({ identify: [{ failure: { message: "Step-response fit: A bounded input step with pre- and post-step data is required." } }] });
    await f.tuning.setup(TANK);
    await expect(f.tuning.identify("lt101-level", { settle_s: 0 })).rejects.toThrow(/setpoint-step/);
    expect(f.tuning.panelLoops()[0]!.error?.step).toBe("identify");
  });

  it("searches and validates, proposing the gains for CODESYS", async () => {
    const f = fakeTuning({ tune: [{ result: TUNE }], validate: [{ result: VALIDATE }] });
    await f.tuning.setup(TANK);
    const s = await f.tuning.search("LT101 level");
    expect(s).toContain("36 candidates");
    expect(s).toContain("PRG_Tank.fbPI._rKp = 300, PRG_Tank.fbPI._rTi = 20");
    expect(s).toContain("edge of the grid");
    const v = await f.tuning.validate("loop:lt101-level");
    expect(v).toContain("Validation: Fail.");
    expect(v).toContain("Model agreement: 6.03 %");
    expect(v).toContain("_rKp = 300");
    expect(v).toContain("write_object");
    const status = await f.tuning.status();
    expect(status).toContain("selected _rKp=300, _rTi=20");
  });

  it("clears a stuck operation's journal when truST can't cancel it (S10)", async () => {
    const f = fakeTuning({ cancel: [{ failure: { message: "first controller output PRG_Tank.lrFlowCmd violates reviewed transfer tolerance." } }] });
    await f.tuning.setup(TANK);
    mkdirSync(join(f.dir, ".control-studio", "control-studio", "op"), { recursive: true });
    const text = await f.tuning.cancel("lt101-level");
    expect(text).toContain("S10");
    expect(existsSync(join(f.dir, ".control-studio", "control-studio"))).toBe(false);
    expect(existsSync(join(f.dir, ".control-studio", "draft-lt101-level.json"))).toBe(true);
  });

  it("recovers from truST refusing a bumpless hand-back in Validate (S16)", async () => {
    const refused = { failure: { cause: "settings", message: "first controller output PRG_Tank.lrFlowCmd violates reviewed transfer tolerance." } };
    const f = fakeTuning({ tune: [{ result: TUNE }], validate: [refused], cancel: [{ failure: { message: "first controller output PRG_Tank.lrFlowCmd violates reviewed transfer tolerance." } }] });
    await f.tuning.setup(TANK);
    await f.tuning.search("lt101-level");
    mkdirSync(join(f.dir, ".control-studio", "control-studio"), { recursive: true });
    let msg = "";
    await f.tuning.validate("lt101-level").catch((e: Error) => (msg = e.message));
    expect(msg).toContain("TRUST-GAPS S16");
    expect(msg).toContain("Do not change the controller code");
    expect(msg).toContain("set PRG_Tank.bManual := FALSE (Auto)");
    expect(msg).toContain('set {"PRG_Tank.fbPI._rKp":300,"PRG_Tank.fbPI._rTi":20}');
    expect(f.writes).toEqual([["PRG_Tank.bManual", "FALSE"]]);
    expect(existsSync(join(f.dir, ".control-studio", "control-studio"))).toBe(false);
    expect(f.tuning.panelLoops()[0]!.error?.step).toBe("validate");
  });

  it("names unknown loops", async () => {
    const f = fakeTuning({});
    await expect(f.tuning.search("nope")).rejects.toThrow(/No tuning loop 'nope'/);
    expect(await f.tuning.status()).toContain("No tuning loops");
  });
});
