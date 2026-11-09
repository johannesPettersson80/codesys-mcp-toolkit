/**
 * Live acceptance test: real CODESYS + real truST, through the MCP tools.
 * Text-only version of the acceptance demo (steps 1-2, 4-5, 7-8):
 * build the tank project in CODESYS, simulate it against the plant, run a
 * setpoint-step experiment, stop at a conditional breakpoint when the
 * interlock trips, tune the PI gain in simulation, write the gain back to
 * CODESYS and compile.
 *
 *   CODESYS_LIVE=1 TRUST_RUNTIME=<path>\trust-runtime.exe npx vitest run test/live/sim.live.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CodesysBridge } from "../../src/bridge/bridge.js";
import { resolveCodesys } from "../../src/codesys/install.js";
import { createServer } from "../../src/server.js";
import { SimController } from "../../src/sim/controller.js";
import { findTrustRuntime } from "../../src/sim/runtime.js";
import { codesysSource } from "../../src/sim/tools.js";
import type { AppContext } from "../../src/tools.js";
import { LINES, PRG_TANK_IMPL, TANK_PLANT, tankNodes, tankTestNodes } from "../fixtures/tank.js";
import { tempDir, WATCHER } from "../helpers.js";

const LONG = 600_000;
let client: Client;
let ctx: AppContext;
const dir = tempDir("cmcp-simlive-");
const log: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content.map((c) => c.text).join("\n");
  log.push(`> ${name} ${JSON.stringify(args)}\n${text}`);
  return { text, isError: !!r.isError };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.text;
}

const node = (path: string) => tankNodes().find((n) => n.path === path)!;
const iae = (s: string) => Number(/IAE: ([\d.]+)/.exec(s)?.[1]);
const plcPrgDecl = node("PRG_Tank").declaration!.replace("PROGRAM PRG_Tank", "PROGRAM PLC_PRG");
const plant = TANK_PLANT;
const trip = LINES.trip;

describe.skipIf(!findTrustRuntime())("live CODESYS + truST simulation", () => {
  beforeAll(async () => {
    const cs = resolveCodesys(process.env.CODESYS_PATH, process.env.CODESYS_PROFILE);
    const bridge = new CodesysBridge({ command: cs.exe, profile: cs.profile, additionalFolder: cs.install.additionalFolder, watcherSource: WATCHER, sessionRoot: join(dir, "sessions"), log: (m) => log.push(m) });
    ctx = { bridge, autosave: true, workspace: dir, templatesDir: cs.install.templatesDir, codesys: { exe: cs.exe, profile: cs.profile, label: cs.install.label }, startWaitMs: LONG };
    ctx.sim = new SimController(codesysSource(bridge, () => ctx.project?.path, LONG), { mirrorRoot: join(dir, "mirrors"), log: (m) => log.push(m) });
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "simlive", version: "1" });
    await client.connect(b);
    await bridge.start();
  }, LONG);

  afterAll(async () => {
    await ctx?.sim?.stop().catch(() => undefined);
    await client?.close();
    await ctx?.bridge.stop();
    process.stderr.write(`\n---- sim live log (${dir}) ----\n${log.join("\n")}\n`);
  }, 60_000);

  it("1. builds the tank control code in a new CODESYS project and compiles it", async () => {
    await ok("create_project", { path: "Tank.project" });
    const steps: [string, Record<string, unknown>][] = [
      ["create_object", { kind: "dut", dutType: "enum", name: "E_TankMode", declaration: node("E_TankMode").declaration }],
      ["create_object", { kind: "interface", name: "I_Resettable" }],
      ["create_object", { parent: "I_Resettable", kind: "method", name: "Reset", returnType: "BOOL" }],
      ["create_object", { kind: "function_block", name: "FB_PI", declaration: node("FB_PI").declaration, implementation: node("FB_PI").implementation }],
      ["create_object", { parent: "FB_PI", kind: "method", name: "Reset", returnType: "BOOL", implementation: node("FB_PI/Reset").implementation }],
      ["create_object", { parent: "FB_PI", kind: "property", name: "Kp", returnType: "REAL" }],
      ["write_object", { path: "FB_PI/Kp/Get", implementation: node("FB_PI/Kp/Get").implementation }],
      ["write_object", { path: "FB_PI/Kp/Set", implementation: node("FB_PI/Kp/Set").implementation }],
      ["create_object", { parent: "FB_PI", kind: "property", name: "Ti", returnType: "REAL" }],
      ["write_object", { path: "FB_PI/Ti/Get", implementation: node("FB_PI/Ti/Get").implementation }],
      ["write_object", { path: "FB_PI/Ti/Set", implementation: node("FB_PI/Ti/Set").implementation }],
      ["create_object", { kind: "gvl", name: "GVL_IO", declaration: node("GVL_IO").declaration }],
      ["create_object", { kind: "gvl", name: "GVL_Par", declaration: node("GVL_Par").declaration }],
      ["write_object", { path: "PLC_PRG", declaration: plcPrgDecl, implementation: PRG_TANK_IMPL }],
    ];
    for (const [tool, args] of steps) await ok(tool, args);
    expect(await ok("compile")).toMatch(/Build: 0 error\(s\)/);
  }, LONG);

  it("2. syncs the mirror with the plant and starts the simulation", async () => {
    const s = await ok("sync_mirror", { plant });
    expect(s).toMatch(/Changed: .*PLC_PRG/);
    expect(s).toMatch(/GVL_IO\.lrLT101_Level AT %IL0/);
    const r = await ok("sim_start", { speed: 50 });
    expect(r).toMatch(/paused at the start of scan/);
    expect(await ok("run_for", { seconds: 3 })).toMatch(/Ran \d+ scan\(s\) \(3\.00 s simulated\)/);
    expect(await ok("read_vars", { names: ["GVL_IO.xXV101_Opened", "PLC_PRG.sStatus"] })).toMatch(/GVL_IO\.xXV101_Opened = TRUE\nPLC_PRG\.sStatus = 'OK'/);
    // 3. the panel (text side; the UI itself is checked with scripts/dev-host)
    expect(await ok("open_sim_panel")).toMatch(/Panel opened\. Simulation: paused, scan \d+[\s\S]*GVL_IO\.lrLT101_Level = /);
  }, LONG);

  it("unit tests live in the CODESYS project and run in truST", async () => {
    await ok("create_object", { kind: "folder", name: "Tests" });
    for (const t of tankTestNodes({ failing: true }).filter((n) => n.kind === "pou")) {
      await ok("create_object", { parent: "Tests", kind: "program", name: t.name, declaration: t.declaration, implementation: t.implementation });
    }
    // Nothing calls the tests, so CODESYS doesn't compile them: the project still builds clean.
    expect(await ok("compile")).toMatch(/Build: 0 error\(s\)/);
    const r = await call("run_tests");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/^Tests: 3 passed, 1 failed \(4 total/);
    expect(r.text).toMatch(/FAIL Tests\/T_Deliberately_Failing: ASSERT_EQUAL failed: expected 1, actual 2/);
    await ok("delete_object", { path: "Tests/T_Deliberately_Failing" });
    expect(await ok("run_tests")).toMatch(/^Tests: 3 passed, 0 failed/);
  }, LONG);

  let baseline = "";
  it("4. runs a setpoint-step experiment", async () => {
    baseline = await ok("run_experiment", { name: "level step", duration_s: 300, pv: "GVL_IO.lrLT101_Level", sp: { var: "GVL_Par.rLevelSP", value: 1.2, at_s: 10 }, watch: ["PLC_PRG.nTrips"] });
    expect(baseline).toMatch(/Step: GVL_Par\.rLevelSP -> 1\.2 at 10 s/);
    expect(baseline).toMatch(/steady-state error: [\d.]+/);
    expect(baseline).toMatch(/PLC_PRG\.nTrips: start 0; no change/);
    expect(iae(baseline)).toBeGreaterThan(0);
  }, LONG);

  it("5. stops at a conditional breakpoint when the interlock trips", async () => {
    expect(await ok("set_breakpoint", { path: "PLC_PRG", line: trip, condition: "GVL_IO.lrLT101_Level > 2.0" })).toMatch(/Breakpoint #1 at PLC_PRG line 11/);
    await ok("force_var", { name: "GVL_IO.lrLT101_Level", value: "2.4" });
    const stop = await ok("continue", { timeoutMs: 60_000 });
    expect(stop).toMatch(/Stopped \(breakpoint #1 \(GVL_IO\.lrLT101_Level > 2\.0\)\) at PLC_PRG line 11/);
    expect(stop).toMatch(/nTrips := nTrips \+ 1;/);
    expect(await ok("step_over")).toMatch(/PLC_PRG line 12[\s\S]*nTrips = 1/);
    await ok("unforce_var", { name: "GVL_IO.lrLT101_Level" });
    await ok("clear_breakpoint", { all: true });
    expect(await ok("read_vars", { names: ["GVL_Par.eMode"] })).toBe("GVL_Par.eMode = E_TankMode.INTERLOCKED");
  }, LONG);

  it("7. tunes the PI gain in simulation and logs the improvement", async () => {
    const tuned = await ok("run_experiment", {
      name: "level step",
      duration_s: 300,
      pv: "GVL_IO.lrLT101_Level",
      sp: { var: "GVL_Par.rLevelSP", value: 1.2, at_s: 10 },
      set: { "PLC_PRG.fbPI._rKp": 150 },
      watch: ["PLC_PRG.nTrips"],
    });
    expect(tuned).toMatch(/Compared with #1 level step/);
    expect(iae(tuned)).toBeLessThan(iae(baseline));
    expect(await ok("experiment_log")).toMatch(/#2 level step/);
  }, LONG);

  it("8. writes the gain to CODESYS, compiles, and the simulation picks it up", async () => {
    await ok("write_object", { path: "PLC_PRG", implementation: PRG_TANK_IMPL.replace("fbPI.Kp := 50.0;", "fbPI.Kp := 150.0;") });
    expect(await ok("compile")).toMatch(/Build: 0 error\(s\)/);
    const s = await ok("sync_mirror");
    expect(s).toMatch(/Changed: PLC_PRG/);
    expect(s).toMatch(/still has the old code/);
    await ok("sim_start", { speed: 50 });
    const after = await ok("run_experiment", { name: "level step", duration_s: 300, pv: "GVL_IO.lrLT101_Level", sp: { var: "GVL_Par.rLevelSP", value: 1.2, at_s: 10 } });
    expect(iae(after)).toBeLessThan(iae(baseline));
    await ok("sim_stop");
  }, LONG);
});
