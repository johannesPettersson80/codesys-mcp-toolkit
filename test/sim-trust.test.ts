/**
 * The simulation against a real trust-runtime, with the CODESYS side faked
 * (the tank fixture). Runs when trust-runtime is found (TRUST_RUNTIME or PATH)
 * and its toolchain is installed; skipped otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimController } from "../src/sim/controller.js";
import { findTrustRuntime } from "../src/sim/runtime.js";
import { LINES, PRG_TANK_IMPL, TANK_PLANT, tankNodes, tankTasks, tankTestNodes } from "./fixtures/tank.js";
import { tempDir } from "./helpers.js";

const exe = findTrustRuntime();
const toolchain = (() => {
  if (!exe) return false;
  try {
    return JSON.parse(execFileSync(exe, ["toolchain", "status", "--json"], { encoding: "utf8" })).installed === true;
  } catch {
    return false;
  }
})();

const T = 120_000;

describe.skipIf(!exe || !toolchain)("simulation in truST", () => {
  const root = tempDir("cmcp-trust-");
  const project = join(root, "Tank.project");
  let nodes = tankNodes();
  const sim = new SimController({ exportSt: async () => nodes, tasks: async () => tankTasks(), projectPath: () => project }, { mirrorRoot: join(root, "mirrors") });

  beforeAll(() => writeFileSync(join(root, "Tank.plant.toml"), TANK_PLANT));
  afterAll(async () => {
    await sim.stop();
  }, 30_000);

  it("syncs, builds and starts paused at a scan start", async () => {
    const r = await sim.start({ timeScale: 50 });
    expect(r).toMatch(/paused at the start of scan \d+/);
    expect(r).toMatch(/Plant: T101 \(gravity_tank\), 2 feedback signal/);
    expect(r).toMatch(/Warning: Not simulated \(graphical, not ST\): SEQ_Fill/);
    expect(await sim.status()).toMatch(/paused/);
  }, T);

  it("runs an exact number of scans with the plant and feedback in lockstep", async () => {
    const before = await sim.scan();
    expect(await sim.runScans(100)).toMatch(/^Ran 100 scan\(s\) \(1\.00 s simulated\)/);
    expect(await sim.scan()).toBe(before + 100);
    expect(await sim.readVars(["GVL_IO.xXV101_Opened"])).toBe("GVL_IO.xXV101_Opened = FALSE");
    await sim.runFor(2.5);
    const v = await sim.readVars(["GVL_IO.xXV101_Opened", "GVL_IO.xP101_Running", "PRG_Tank.sStatus", "GVL_Par.eMode"]);
    expect(v).toContain("GVL_IO.xXV101_Opened = TRUE");
    expect(v).toContain("PRG_Tank.sStatus = 'OK'");
    expect(v).toContain("GVL_Par.eMode = E_TankMode.AUTO");
  }, T);

  it("gives the panel a snapshot and a trend without disturbing the run", async () => {
    const s = await sim.panelState();
    expect(s.status).toBe("paused");
    expect(s.scan).toBeGreaterThan(300);
    expect(s.location?.harness).toBe(true);
    const lvl = s.signals.find((x) => x.name === "GVL_IO.lrLT101_Level")!;
    expect(lvl.value).toMatch(/^\d\.\d+/);
    expect(s.signals.find((x) => x.name === "GVL_IO.xXV101_Opened")!.value).toBe("TRUE");
    const t = sim.trend(-1, -1);
    expect(t.points.length).toBeGreaterThanOrEqual(3);
    expect(t.points.at(-1)!.values["GVL_IO.xXV101_Opened"]).toBe(1);
    // reading the snapshot must not change where the simulation is
    expect((await sim.panelState()).scan).toBe(s.scan);
  }, T);

  it("holds still while paused", async () => {
    const a = await sim.readVars(["GVL_IO.lrLT101_Level"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await sim.readVars(["GVL_IO.lrLT101_Level"])).toBe(a);
  }, T);

  it("stops at a breakpoint when a forced sensor trips the interlock, and steps into a method", async () => {
    expect(await sim.setBreakpoint("PRG_Tank", LINES.trip)).toMatch(/^Breakpoint #1 at PRG_Tank line 11\.$/);
    expect(await sim.forceVar("GVL_IO.lrLT101_Level", "2.5")).toMatch(/\(%IL0\) forced to 2\.5/);
    const stop = await sim.cont(30_000);
    expect(stop).toMatch(/Stopped \(breakpoint #1\) at PRG_Tank line 11/);
    expect((await sim.panelState()).location).toEqual({ reason: "breakpoint", harness: false, obj: "PRG_Tank", part: "impl", line: 11, breakpoint: 1 });
    expect(stop).toMatch(/>\s+11 \|\s+nTrips := nTrips \+ 1;/);
    expect(stop).toMatch(/Locals: .*nTrips = 0/);
    expect(await sim.step("step_over")).toMatch(/at PRG_Tank line 12[\s\S]*nTrips = 1/);
    await sim.step("step_over");
    const into = await sim.step("step_in");
    expect(into).toMatch(/at FB_PI\/Reset line 1/);
    expect(into).toMatch(/Call stack: FB_PI\/Reset line 1 <- PRG_Tank line 13/);
    expect(await sim.step("step_out")).toMatch(/at PRG_Tank line 16/);
    await sim.unforceVar("GVL_IO.lrLT101_Level");
    await sim.clearBreakpoint({ all: true });
    expect(await sim.readVars(["PRG_Tank.nTrips", "GVL_Par.eMode"])).toBe("PRG_Tank.nTrips = 1\nGVL_Par.eMode = E_TankMode.INTERLOCKED");
  }, T);

  it("writes variables, including CODESYS enum literals", async () => {
    await sim.writeVar("GVL_Par.eMode", "E_TankMode.AUTO");
    await sim.writeVar("PRG_Tank.sStatus", "'Nivå'");
    await sim.runScans(1);
    expect(await sim.readVars(["GVL_Par.eMode"])).toBe("GVL_Par.eMode = E_TankMode.AUTO");
  }, T);

  it("runs repeatable experiments and compares them", async () => {
    const spec = { name: "level step", duration_s: 300, pv: "GVL_IO.lrLT101_Level", sp: { var: "GVL_Par.rLevelSP", value: 0.6, at_s: 5 }, watch: ["PRG_Tank.nTrips"], samples: 60 };
    const a = await sim.runExperiment(spec);
    expect(a).toMatch(/Experiment "level step": 300 s simulated/);
    expect(a).toMatch(/rise time \(10-90%\) s: [\d.]+/);
    expect(a).toMatch(/PRG_Tank\.nTrips: start 0; no change/);
    const b = await sim.runExperiment({ ...spec, set: { "PRG_Tank.fbPI._rKp": 150, "PRG_Tank.bInit": "FALSE" } });
    expect(b).toMatch(/Compared with #1 level step/);
    const iae = (s: string) => Number(/IAE: ([\d.]+)/.exec(s)![1]);
    expect(iae(b)).toBeLessThan(iae(a));
    expect(sim.experimentLog()).toMatch(/#2 level step/);
    // the experiment fed the panel's trend, from a fresh epoch, over the whole run
    const t = sim.trend(-1, -1);
    expect(t.points.at(-1)!.t - t.points[0]!.t).toBeGreaterThan(290);
    expect(t.points.some((p) => typeof p.values["GVL_IO.lrLT101_Level"] === "number")).toBe(true);
    expect((await sim.panelState()).experiments.map((e) => e.name)).toEqual(["level step", "level step"]);
    expect(readFileSync(join(sim.mirrorFolder(), "experiments.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  }, T);

  it("stops at a conditional breakpoint only when the condition holds", async () => {
    await sim.setBreakpoint("PRG_Tank", LINES.piCall, "GVL_IO.lrLT101_Level > 0.3 AND GVL_Par.eMode = E_TankMode.AUTO");
    const stop = await sim.cont(60_000);
    expect(stop).toMatch(/Stopped \(breakpoint #\d+ \(GVL_IO\.lrLT101_Level > 0\.3/);
    const level = Number(/= ([\d.]+)/.exec(await sim.readVars(["GVL_IO.lrLT101_Level"]))![1]);
    expect(level).toBeGreaterThan(0.3);
    await sim.clearBreakpoint({ all: true });
  }, T);

  it("restarts with a changed plant parameter", async () => {
    const drop = async () => {
      // valve stays closed for the first 2 s, so the tank only drains: a bigger area drains slower
      const lvl = async () => Number(/= ([\d.]+)/.exec(await sim.readVars(["GVL_IO.lrLT101_Level"]))![1]);
      const a = await lvl();
      await sim.runFor(1.5);
      return a - (await lvl());
    };
    await sim.start({ sync: false });
    const narrow = await drop();
    expect(await sim.setPlantParam("T101", "area_m2", 2.0)).toMatch(/restarted/);
    expect(readFileSync(join(sim.mirrorFolder(), "simulation.toml"), "utf8")).toMatch(/area_m2 = 2/);
    expect(await sim.status()).toMatch(/override.*T101\.area_m2=2/);
    const wide = await drop();
    expect(wide).toBeGreaterThan(0);
    expect(wide).toBeLessThan(narrow * 0.7);
  }, T);

  it("maps a truST build error back to the CODESYS object and line", async () => {
    nodes = tankNodes().map((n) => (n.path === "PRG_Tank" ? { ...n, implementation: PRG_TANK_IMPL.replace("nTrips := nTrips + 1;", "nTrips := nTrips + ;") } : n));
    await expect(sim.start()).rejects.toThrow(new RegExp(`truST could not build the mirror:\\nPRG_Tank \\(implementation line ${LINES.trip}\\): expected expression`));
    nodes = tankNodes();
  }, T);
});

describe.skipIf(!exe || !toolchain)("unit tests in truST ({attribute 'test'} programs)", () => {
  const root = tempDir("cmcp-tests-");
  let failing = true;
  const sim = new SimController(
    { exportSt: async () => [...tankNodes(), ...tankTestNodes({ failing })], tasks: async () => tankTasks(), projectPath: () => join(root, "Tank.project") },
    { mirrorRoot: join(root, "mirrors"), git: false },
  );
  beforeAll(() => writeFileSync(join(root, "Tank.plant.toml"), TANK_PLANT));
  afterAll(async () => {
    await sim.stop();
  }, 30_000);

  it("runs the tests and reports results by CODESYS object", async () => {
    const r = await sim.runTests();
    expect(r.run?.ran, r.text).toBe(true);
    expect(r.text).toMatch(/^Tests: 3 passed, 1 failed \(4 total/);
    expect(r.text).toMatch(/FAIL Tests\/T_Deliberately_Failing: ASSERT_EQUAL failed: expected 1, actual 2/);
    expect(r.text).toMatch(/pass Tests\/T_PI_Proportional/);
    expect(r.text).toMatch(/pass Tests\/T_Mode_DefaultsToAuto/);
    expect(r.ok).toBe(false);
    expect((await sim.panelState()).tests).toMatchObject({ total: 4, passed: 3, failed: 1, failing: ["Tests/T_Deliberately_Failing"] });
  }, T);

  it("filters by name and goes green when the failure is fixed", async () => {
    expect((await sim.runTests({ filter: "pi_" })).text).toMatch(/^Tests: 2 passed, 0 failed \(2 total/);
    failing = false;
    const r = await sim.runTests();
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/^Tests: 3 passed, 0 failed/);
  }, T);

  it("keeps tests out of the simulation, which still builds and runs", async () => {
    const r = await sim.start({ timeScale: 50 });
    expect(r).toMatch(/paused at the start of scan/);
    expect(readFileSync(join(sim.mirrorFolder(), "src", "Configuration.st"), "utf8")).not.toMatch(/T_PI/);
  }, T);
});
