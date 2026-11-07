/**
 * Loop tuning with truST's Control Studio, end to end against a real
 * trust-runtime and trust-control-studio (truST 0.34 or later), with the
 * CODESYS side faked: a tank whose loop signals live in PRG_Tank (TRUST-GAPS S9).
 * Skipped unless trust-runtime, its toolchain and trust-control-studio are found.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SimController } from "../src/sim/controller.js";
import { findControlStudio, findTrustRuntime } from "../src/sim/runtime.js";
import { tankTasks, TUNING_PLANT, tuningTankNodes } from "./fixtures/tank.js";
import { tempDir } from "./helpers.js";

const exe = findTrustRuntime();
const ready = (() => {
  if (!exe || !findControlStudio(exe)) return false;
  try {
    return JSON.parse(execFileSync(exe, ["toolchain", "status", "--json"], { encoding: "utf8" })).installed === true;
  } catch {
    return false;
  }
})();

const T = 600_000;

describe.skipIf(!ready)("tuning with truST Control Studio", () => {
  const root = tempDir("cmcp-tune-trust-");
  const project = join(root, "Tank.project");
  writeFileSync(join(root, "Tank.plant.toml"), TUNING_PLANT);
  const sim = new SimController({ exportSt: async () => tuningTankNodes(), tasks: async () => tankTasks(), projectPath: () => project }, { mirrorRoot: join(root, "mirrors"), git: false });
  afterAll(async () => {
    await sim.stop();
  }, 30_000);

  it("refuses GVL loop signals with what to change", async () => {
    await expect(
      sim.tuning.setup({
        name: "LT101 level",
        pv: { symbol: "GVL_IO.lrLT101_Level", min: 0, max: 2.5 },
        sp: "PRG_Tank.rLevelSP",
        mv: { symbol: "PRG_Tank.lrFlowCmd", min: 0, max: 0.05 },
        mode: { symbol: "PRG_Tank.bManual", true_means: "Manual" },
        manual_output: "PRG_Tank.lrManualFlow",
        coefficients: [{ symbol: "PRG_Tank.fbPI._rKp", values: [50, 100] }],
      }),
    ).rejects.toThrow(/one PROGRAM.*GVL_IO\.lrLT101_Level/s);
  }, T);

  it("sets up, identifies, searches and validates the level loop", async () => {
    const setup = await sim.tuning.setup({
      name: "LT101 level",
      pv: { symbol: "PRG_Tank.lrLevel", unit: "m", min: 0, max: 2.5 },
      sp: "PRG_Tank.rLevelSP",
      mv: { symbol: "PRG_Tank.lrFlowCmd", unit: "m3/s", min: 0, max: 0.05 },
      mode: { symbol: "PRG_Tank.bManual", true_means: "Manual" },
      manual_output: "PRG_Tank.lrManualFlow",
      coefficients: [
        { symbol: "PRG_Tank.fbPI._rKp", unit: "%/m", values: [25, 50, 100, 200, 300] },
        { symbol: "PRG_Tank.fbPI._rTi", unit: "s", values: [20, 60, 120] },
      ],
      startup_flag: "PRG_Tank.bInitDone",
      experiment_s: 400,
      step: 0.005,
    });
    expect(setup).toContain("Loop loop:lt101-level");

    let t = Date.now();
    const ms = () => `${((Date.now() - t) / 1000).toFixed(0)} s`;
    const id = await sim.tuning.identify("loop:lt101-level", { settle_s: 120, method: process.env.TUNE_METHOD /* "step": the manual step, flaky on 0.34 (S13) */ });
    expect(id).toMatch(/G\(s\) = /);
    const model = sim.tuning.panelLoops()[0]!.model!;
    const gain = Number(/= ([\d.]+) \//.exec(model.equation)?.[1]);
    expect(gain).toBeGreaterThan(40); // the tank's ~72 m per m3/s at 1 m
    expect(gain).toBeLessThan(110);
    expect(await sim.status()).toMatch(/paused/);

    const tId = ms();
    t = Date.now();
    const search = await sim.tuning.search("loop:lt101-level");
    expect(search).toMatch(/Selected: /);

    const tSearch = ms();
    t = Date.now();
    const val = await sim.tuning.validate("loop:lt101-level");
    expect(val).toMatch(/Model agreement/);
    const loop = sim.tuning.panelLoops()[0]!;
    expect(loop.validation!.rows.length).toBeGreaterThan(3);
    expect(loop.validation!.traces.map((t) => t.role)).toEqual(["current", "tuned"]);
    console.log(`identify ${tId}, search ${tSearch}, validate ${ms()}\n${id}\n${search}\n${val}`);
  }, T);
});
