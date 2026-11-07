/** Simulation layer tests that need no truST: mirror, plant, values, conditions, analysis, safety, MCP wiring. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { analyse, SimController } from "../src/sim/controller.js";
import { assertLoopback, TrustControl } from "../src/sim/control.js";
import { evaluate, evaluateCondition, ExprError, parseExpr } from "../src/sim/expr.js";
import { composeMirror, declaredType, enumMembers, fromMirror, HARNESS_FILE, injectAddress, isTestPou, methodHeader, parseIntervalMs, partLines, propertyHeader, rewriteEnumLiterals, stripQueryInterface, toMirror, toTestHeader, usedAddressEnd } from "../src/sim/mirror.js";
import { readManifest, writeMirror } from "../src/sim/mirror-store.js";
import { applyOverride, parsePlantConfig, PlantConfigError, simulationToml } from "../src/sim/plant.js";
import { assertSimulationOnly, parseDiagnostics, parseTestJson, runtimeToml } from "../src/sim/runtime.js";
import { SIM_CODESYS_OPS } from "../src/sim/tools.js";
import { formatValue, parseTrustValue, toTrustLiteral, type StValue } from "../src/sim/values.js";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { LINES, TANK_PLANT, tankNodes, tankTasks, tankTestNodes } from "./fixtures/tank.js";
import { fakeBridge, fakeProjectFile, ROOT, tempDir } from "./helpers.js";

const compose = () => composeMirror(tankNodes(), tankTasks(), { plant: parsePlantConfig(TANK_PLANT) });
const file = (c: ReturnType<typeof compose>, name: string) => c.files.find((f) => f.path === `src/${name}.st`)!;

describe("mirror composition", () => {
  it("nests methods, properties and accessors into the FB", () => {
    const t = file(compose(), "FB_PI").text;
    expect(t).toMatch(/^FUNCTION_BLOCK FB_PI IMPLEMENTS I_Resettable/);
    expect(t).toContain("METHOD PUBLIC Reset : BOOL\nrI := 0.0;\nrY := 0.0;\nReset := TRUE;\nEND_METHOD");
    expect(t).toContain("PUBLIC PROPERTY Kp : REAL\n    GET\nKp := _rKp;\n    END_GET\n    SET\nIF Kp > 0.0 THEN");
    expect(t.trimEnd().endsWith("END_FUNCTION_BLOCK")).toBe(true);
    expect(t).not.toMatch(/VAR\s+END_VAR/);
  });

  it("wraps GVLs in a namespace and injects plant addresses", () => {
    const c = compose();
    const io = file(c, "GVL_IO").text;
    expect(io).toMatch(/^NAMESPACE GVL_IO\n/);
    expect(io.trimEnd().endsWith("END_NAMESPACE")).toBe(true);
    expect(io).toContain("lrLT101_Level AT %IL0 : LREAL;");
    expect(io).toContain("lrFV101_FlowCmd AT %QL0 : LREAL;");
    expect(c.addresses.get("gvl_io.lrlt101_level")).toBe("%IL0");
  });

  it("removes the implicit IQueryInterface base", () => {
    expect(file(compose(), "I_Resettable").text).toBe("INTERFACE I_Resettable\nMETHOD Reset : BOOL\nEND_METHOD\nEND_INTERFACE\n");
    expect(stripQueryInterface("INTERFACE I EXTENDS __System.IQueryInterface, I_Base")).toBe("INTERFACE I EXTENDS I_Base");
    expect(stripQueryInterface("INTERFACE I EXTENDS I_Base, __System.IQueryInterface")).toBe("INTERFACE I EXTENDS I_Base");
  });

  it("builds the configuration with the harness first and programs named after their POU", () => {
    const c = compose();
    const cfg = c.files.find((f) => f.path === "src/Configuration.st")!.text;
    expect(cfg).toContain("TASK MainTask (INTERVAL := T#10MS, PRIORITY := 1);");
    expect(cfg.indexOf("PROGRAM MCP_SimHarness WITH MainTask")).toBeLessThan(cfg.indexOf("PROGRAM PRG_Tank WITH MainTask : PRG_Tank;"));
    expect(c.cycleMs).toBe(10);
    const h = c.files.find((f) => f.path === HARNESS_FILE)!.text.split("\n");
    expect(h[c.harnessLine0]).toBe("nScan := nScan + 1;");
    expect(h.join("\n")).toContain("IF GVL_IO.xXV101_Open THEN GVL_IO.xXV101_Opened := tonFb1.Q; ELSE GVL_IO.xXV101_Opened := tofFb1.Q; END_IF");
    expect(h.join("\n")).toContain("tonFb2(IN := GVL_IO.xP101_Run, PT := T#500MS);");
  });

  it("reports graphical objects and skips tasks it can't run", () => {
    const c = composeMirror(tankNodes(), [...tankTasks(), { name: "Ev", kind: "Event", pous: [] }, { name: "Slow", interval: "t#100ms", kind: "Cyclic", pous: ["SEQ_Fill"] }]);
    expect(c.warnings.join("\n")).toMatch(/Not simulated \(graphical, not ST\): SEQ_Fill/);
    expect(c.warnings.join("\n")).toMatch(/Task Ev \(Event\) is not cyclic/);
    expect(c.warnings.join("\n")).toMatch(/Slow calls SEQ_Fill, which is not an ST program/);
  });

  it("maps CODESYS lines to mirror lines and back", () => {
    const c = compose();
    const m = toMirror(c.files, "PRG_Tank", LINES.trip)!;
    expect(m.path).toBe("src/PRG_Tank.st");
    expect(c.files.find((f) => f.path === m.path)!.text.split("\n")[m.line0]).toBe("    nTrips := nTrips + 1;");
    expect(fromMirror(c.files, "src/PRG_Tank.st", m.line0)).toEqual({ obj: "PRG_Tank", part: "impl", line: LINES.trip });
    expect(fromMirror(c.files, "C:\\x\\src\\PRG_Tank.st", m.line0)?.line).toBe(LINES.trip);
    const r = toMirror(c.files, "FB_PI/Reset", 2)!;
    expect(c.files.find((f) => f.path === r.path)!.text.split("\n")[r.line0]).toBe("rY := 0.0;");
    expect(partLines(c.files, "PRG_Tank", "impl")).toBe(31);
  });

  it("refuses a project with no simulated program", () => {
    expect(() => composeMirror(tankNodes(), [])).toThrow(/No task calls an ST program/);
  });

  it("parses task intervals", () => {
    expect(parseIntervalMs("t#10ms")).toBe(10);
    expect(parseIntervalMs("T#1s500ms")).toBe(1500);
    expect(parseIntervalMs("20", "ms")).toBe(20);
    expect(parseIntervalMs("2", "s")).toBe(2000);
    expect(parseIntervalMs(undefined)).toBeUndefined();
  });

  it("finds types, injects addresses and allocates after the project's own", () => {
    const d = "VAR_GLOBAL\n    a AT %IX0.3 : BOOL;\n    b : REAL; // c : INT\n    x AT %IW4 : INT;\nEND_VAR";
    expect(declaredType(d, "b")).toBe("REAL");
    expect(declaredType(d, "c")).toBeUndefined();
    expect(injectAddress(d, "x", "%IW100")).toContain("x AT %IW100 :");
    expect(injectAddress(d, "b", "%ID8")).toContain("b AT %ID8 : REAL");
    expect(usedAddressEnd([d])).toEqual({ I: 10, Q: 0, M: 0 });
    const nodes = tankNodes().map((n) => (n.path === "GVL_IO" ? { ...n, declaration: n.declaration!.replace("xP101_Running : BOOL;", "xP101_Running AT %IX0.0 : BOOL;\n    rSpare AT %ID3 : REAL;") } : n));
    const c = composeMirror(nodes, tankTasks(), { plant: parsePlantConfig(TANK_PLANT) });
    expect(c.addresses.get("gvl_io.lrlt101_level")).toBe("%IL2");
    expect(propertyHeader("PROPERTY PUBLIC FINAL X : INT")).toBe("PUBLIC FINAL PROPERTY X : INT");
  });

  it("makes CODESYS's implicit PUBLIC explicit on methods and properties", () => {
    expect(methodHeader("METHOD Reset : BOOL")).toBe("METHOD PUBLIC Reset : BOOL");
    expect(methodHeader("METHOD FINAL Bar : INT")).toBe("METHOD PUBLIC FINAL Bar : INT");
    expect(methodHeader("{attribute 'x'}\nMETHOD Baz")).toBe("{attribute 'x'}\nMETHOD PUBLIC Baz");
    expect(methodHeader("METHOD PRIVATE Foo")).toBe("METHOD PRIVATE Foo");
    expect(methodHeader("METHOD PUBLIC Q")).toBe("METHOD PUBLIC Q");
    expect(propertyHeader("PROPERTY Kp : REAL")).toBe("PUBLIC PROPERTY Kp : REAL");
    expect(propertyHeader("PROPERTY PRIVATE Y : INT")).toBe("PRIVATE PROPERTY Y : INT");
    expect(propertyHeader("PROPERTY Publicity : INT")).toBe("PUBLIC PROPERTY Publicity : INT");
  });

  it("rewrites CODESYS enum literals for truST, outside strings and comments", () => {
    expect(enumMembers("{attribute 'qualified_only'}\nTYPE E_M :\n(\n    A := 0, // first\n    B,\n    C := 5\n) INT;\nEND_TYPE")).toEqual({ name: "E_M", members: ["A", "B", "C"] });
    const enums = new Map([["e_m", new Set(["a", "b", "c"])]]);
    const src = "x := E_M.A; IF y = e_m . c THEN s := 'E_M.A'; END_IF // E_M.B\n(* E_M.C *) z := E_M.Other; w := MyE_M.A; q := s.E_M.A;";
    expect(rewriteEnumLiterals(src, enums)).toBe("x := E_M#A; IF y = e_m#c THEN s := 'E_M.A'; END_IF // E_M.B\n(* E_M.C *) z := E_M.Other; w := MyE_M.A; q := s.E_M.A;");
    const c = compose();
    expect(file(c, "PRG_Tank").text).toContain("GVL_Par.eMode := E_TankMode#INTERLOCKED;");
    expect(file(c, "PRG_Tank").text).not.toMatch(/E_TankMode\.(AUTO|INTERLOCKED)/);
    expect(file(c, "GVL_Par").text).toContain("eMode : E_TankMode := E_TankMode#AUTO;");
    expect(c.notes.join("\n")).toMatch(/Rewrote enum literals E\.X to E#X in 2 text/);
  });

  it("turns {attribute 'test'} programs into truST tests and keeps them out of the tasks", () => {
    expect(isTestPou("{attribute 'test'}\nPROGRAM T_X")).toBe(true);
    expect(isTestPou("// comment\n{attribute 'hide'}\n{ attribute 'test' }\nFUNCTION_BLOCK T_Y")).toBe(true);
    expect(isTestPou("PROGRAM P\nVAR {attribute 'test'} x : INT; END_VAR")).toBe(false);
    expect(toTestHeader("{attribute 'test'}\nPROGRAM T_X\nVAR\nEND_VAR")).toBe("{attribute 'test'}\nTEST_PROGRAM T_X\nVAR\nEND_VAR");
    expect(toTestHeader("{attribute 'test'}\nfunction_block T_Y")).toBe("{attribute 'test'}\nTEST_FUNCTION_BLOCK T_Y");
    const tasks = [...tankTasks(), { name: "Bad", interval: "t#100ms", kind: "Cyclic", pous: ["T_PI_Proportional"] }];
    const c = composeMirror([...tankNodes(), ...tankTestNodes()], tasks, { plant: parsePlantConfig(TANK_PLANT) });
    const f = file(c, "T_PI_Proportional").text;
    expect(f).toMatch(/^\{attribute 'test'\}\nTEST_PROGRAM T_PI_Proportional\n/);
    expect(f.trimEnd().endsWith("END_TEST_PROGRAM")).toBe(true);
    expect(file(c, "T_Mode_DefaultsToAuto").text).toContain("GVL_Par.eMode = E_TankMode#AUTO");
    expect(c.tests.map((t) => t.path)).toEqual(["Tests/T_PI_Proportional", "Tests/T_PI_ResetViaInterface", "Tests/T_Mode_DefaultsToAuto"]);
    expect(c.files.find((x) => x.path === "src/Configuration.st")!.text).not.toMatch(/T_PI/);
    expect(c.warnings.join("\n")).toMatch(/Task Bad calls the test T_PI_Proportional; tests only run with run_tests/);
  });

  it("strips AT %I* placeholders", () => {
    const nodes = tankNodes().map((n) => (n.path === "GVL_IO" ? { ...n, declaration: n.declaration!.replace("xP101_Running : BOOL;", "xP101_Running AT %I* : BOOL;") } : n));
    const c = composeMirror(nodes, tankTasks());
    expect(file(c, "GVL_IO").text).toContain("xP101_Running : BOOL;");
    expect(c.notes.join()).toMatch(/AT %I\*/);
  });
});

describe("plant.toml", () => {
  it("parses plants and feedback", () => {
    const p = parsePlantConfig(TANK_PLANT);
    expect(p.plants[0]).toMatchObject({ id: "T101", model: "gravity_tank", inputs: ["GVL_IO.lrFV101_FlowCmd"], outputs: ["GVL_IO.lrLT101_Level"], initial_state: [0.2] });
    expect(p.feedback).toEqual([
      { signal: "GVL_IO.xXV101_Opened", follows: "GVL_IO.xXV101_Open", delay_ms: 2000, invert: false },
      { signal: "GVL_IO.xP101_Running", follows: "GVL_IO.xP101_Run", delay_ms: 500, invert: false },
    ]);
  });

  it("rejects bad configurations with clear messages", () => {
    const bad = (t: string, re: RegExp) => expect(() => parsePlantConfig(t)).toThrow(re);
    bad("[plants]\n", /unknown section \[plants\]/);
    bad('[[plant]]\nid = "T"\nmodel = "x"\ninputs = ["level"]\n', /not a variable path/);
    bad('[[plant]]\nid = "T"\nmodel = "x"\ncommand_sources = ["%QL0"]\n', /use inputs\/outputs/);
    bad('[[plant]]\nid = "T"\nmodel = "x"\noutputs = ["G.a"]\n[[feedback]]\nsignal = "G.a"\nfollows = "G.b"\n', /wired twice/);
    bad("not = [toml", /not valid TOML/);
  });

  it("applies overrides and writes simulation.toml", () => {
    const p = parsePlantConfig(TANK_PLANT);
    applyOverride(p, { plant: "t101", key: "area_m2", value: 2 });
    applyOverride(p, { plant: "T101", key: "parameters.outflow_coefficient_m2_sqrt_m_per_s", value: 0.05 });
    applyOverride(p, { plant: "T101", key: "noise.std_dev", value: 0.01 });
    expect(() => applyOverride(p, { plant: "T9", key: "a", value: 1 })).toThrow(PlantConfigError);
    const toml = simulationToml(p, { timeScale: 10, traceCapacity: 1000, addresses: compose().addresses });
    expect(toml).toContain('command_sources = [ "%QL0" ]');
    expect(toml).toContain('feedback_targets = [ "%IL0" ]');
    expect(toml).toContain("area_m2 = 2");
    expect(toml).toContain("outflow_coefficient_m2_sqrt_m_per_s = 0.05");
    expect(toml).toMatch(/\[plants\.noise\]\s+std_dev = 0\.01/);
    expect(toml).toMatch(/\[simulation\][\s\S]*enabled = true/);
  });
});

describe("values from truST", () => {
  it("parses eval output", () => {
    expect(parseTrustValue("LReal(0.25)")).toEqual({ kind: "number", type: "LREAL", value: 0.25 });
    expect(parseTrustValue("UDInt(5)")).toEqual({ kind: "number", type: "UDINT", value: 5 });
    expect(parseTrustValue("Bool(true)")).toMatchObject({ kind: "bool", value: true });
    expect(parseTrustValue('String("Niv\\u{e5} \\"x\\"")')).toMatchObject({ kind: "string", value: 'Nivå "x"' });
    expect(parseTrustValue("Time(Duration { secs: 2, nanos: 500000000 })")).toMatchObject({ kind: "time", ms: 2500 });
    expect(parseTrustValue('Enum(EnumValue { type_name: "E_TankMode", variant_name: "AUTO", numeric_value: 1 })')).toEqual({ kind: "enum", type: "E_TankMode", name: "AUTO", numeric: 1 });
  });

  it("formats values as Structured Text", () => {
    const f = (s: string) => formatValue(parseTrustValue(s));
    expect(f("Real(1)")).toBe("1.0");
    expect(f("Int(3)")).toBe("3");
    expect(f("Bool(false)")).toBe("FALSE");
    expect(f('String("it\'s $5")')).toBe("'it$'s $$5'");
    expect(f("Time(Duration { secs: 62, nanos: 5000000 })")).toBe("T#1m2s5ms");
    expect(f('Enum(EnumValue { type_name: "E", variant_name: "A", numeric_value: 0 })')).toBe("E.A");
  });

  it("converts CODESYS enum literals for truST", () => {
    expect(toTrustLiteral("E_TankMode.AUTO")).toBe("E_TankMode#AUTO");
    expect(toTrustLiteral(" 0.5 ")).toBe("0.5");
    expect(toTrustLiteral("'a.b'")).toBe("'a.b'");
  });
});

describe("conditions", () => {
  const vars = new Map<string, StValue>([
    ["GVL_IO.rLevel", { kind: "number", type: "REAL", value: 0.95 }],
    ["n", { kind: "number", type: "INT", value: 3 }],
    ["b", { kind: "bool", type: "BOOL", value: true }],
    ["e", { kind: "enum", type: "E_Mode", name: "AUTO", numeric: 1 }],
    ["s", { kind: "string", type: "STRING", value: "OK" }],
    ["t", { kind: "time", type: "TIME", ms: 2500 }],
  ]);
  const ev = (src: string) => evaluate(parseExpr(src), vars);

  it("follows ST precedence", () => {
    expect(ev("1 + 2 * 3")).toMatchObject({ value: 7 });
    expect(ev("2 ** 3 MOD 5")).toMatchObject({ value: 3 });
    expect(ev("NOT b OR n = 3")).toMatchObject({ value: true });
    expect(ev("n > 2 AND n < 4 XOR FALSE")).toMatchObject({ value: true });
    expect(ev("-n + 1")).toMatchObject({ value: -2 });
    expect(ev("GVL_IO.rLevel > 0.9 & b")).toMatchObject({ value: true });
    expect(ev("16#10 = 16")).toMatchObject({ value: true });
    expect(ev("REAL#2.5 * 2 = 5")).toMatchObject({ value: true });
  });

  it("compares strings, times and enums", () => {
    expect(ev("s = 'OK'")).toMatchObject({ value: true });
    expect(ev("t >= T#2s500ms")).toMatchObject({ value: true });
    expect(ev("e = E_Mode#AUTO")).toMatchObject({ value: true });
    expect(ev("e <> E_Mode#MANUAL")).toMatchObject({ value: true });
    expect(ev("e = 1")).toMatchObject({ value: true });
  });

  it("reads variables through truST and treats unknown E.X as an enum literal", async () => {
    const read = async (p: string): Promise<StValue> => {
      if (vars.has(p)) return vars.get(p)!;
      throw new Error("unknown identifier");
    };
    expect(await evaluateCondition("e = E_Mode.AUTO AND GVL_IO.rLevel > 0.9", read)).toBe(true);
    expect(await evaluateCondition("e = E_Mode.MANUAL", read)).toBe(false);
    await expect(evaluateCondition("nope > 1", read)).rejects.toThrow(/unknown identifier/);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseExpr("a >")).toThrow(ExprError);
    expect(() => parseExpr("(a")).toThrow(/missing '\)'/);
    expect(() => parseExpr("a ? b")).toThrow(/unexpected/);
    expect(() => parseExpr("'open")).toThrow(/unterminated/);
  });
});

describe("experiment analysis", () => {
  it("computes step-response metrics", () => {
    // y rises from 0 to 1 with a 10 % overshoot, step at t=1
    const rows = [];
    for (let i = 0; i <= 200; i++) {
      const t = i * 0.1;
      const y = t < 1 ? 0 : 1 - Math.exp(-(t - 1)) * Math.cos(2 * (t - 1)) * 1;
      rows.push({ t, values: { pv: y } });
    }
    const m = analyse(rows, { duration_s: 20, pv: "pv", sp: { var: "sp", value: 1, at_s: 1 } });
    expect(m.start).toBe(0);
    expect(m.overshoot_pct as number).toBeGreaterThan(5);
    expect(m.rise_time_s as number).toBeGreaterThan(0);
    expect(m.settling_time_s as number).toBeGreaterThan(1);
    expect(Math.abs(m.steady_state_error as number)).toBeLessThan(0.01);
    expect(m.iae as number).toBeGreaterThan(0);
  });

  it("reports 'not settled' and handles missing setpoints", () => {
    const rows = [0, 1, 2, 3].map((t) => ({ t, values: { pv: t * 0.1 } }));
    expect(analyse(rows, { duration_s: 3, pv: "pv", sp: { var: "sp", value: 1 } }).settling_time_s).toBeNull();
    expect(analyse(rows, { duration_s: 3, pv: "pv" })).toEqual({ pv_min: 0, pv_max: 0.3, pv_final: 0.3 });
  });
});

describe("truST output parsing", () => {
  it("parses check/build diagnostics", () => {
    const d = parseDiagnostics("Project check failed\n - program compile failed: src/FB_Dev.st: error[E206]: missing return value (at 68..122)\nsrc/FB_Counter.st: expected ';' at 113..119\nError: src/P.st: expected expression at 486..487");
    expect(d).toEqual([
      { file: "src/FB_Dev.st", message: "error[E206]: missing return value", start: 68, end: 122 },
      { file: "src/FB_Counter.st", message: "expected ';'", start: 113, end: 119 },
      { file: "src/P.st", message: "expected expression", start: 486, end: 487 },
    ]);
  });
});

describe("truST test results", () => {
  it("parses trust-dev JSON and makes file paths project-relative", () => {
    const json = JSON.stringify({
      summary: { duration_ms: 952, errors: 0, failed: 1, passed: 1, total: 2 },
      tests: [
        { duration_ms: 0, file: "\\\\?\\C:\\m\\Tank-1\\src\\T_A.st", kind: "TEST_PROGRAM", line: 2, message: null, name: "T_A", status: "passed" },
        { duration_ms: 1, file: "\\\\?\\C:\\m\\Tank-1\\src\\T_B.st", kind: "TEST_PROGRAM", line: 2, message: "ASSERT_EQUAL failed: expected 1, actual 2", name: "T_B", status: "failed" },
      ],
      version: 1,
    });
    const r = parseTestJson(`${json}\nError: 1 ST test(s) failed`, "C:\\m\\Tank-1")!;
    expect(r).toMatchObject({ ran: true, total: 2, passed: 1, failed: 1, durationMs: 952 });
    expect(r.tests[1]).toEqual({ name: "T_B", kind: "TEST_PROGRAM", status: "failed", message: "ASSERT_EQUAL failed: expected 1, actual 2", file: "src/T_B.st", line: 2, durationMs: 1 });
    expect(parseTestJson("Error: src/T_A.st: expected ';' at 10..12", "C:\\m")).toBeUndefined();
  });
});

describe("simulation safety (never a controller)", () => {
  it("only connects to loopback", () => {
    expect(() => assertLoopback("192.168.0.10")).toThrow(/only connects to a local trust-runtime/);
    expect(() => new TrustControl({ host: "10.0.0.5", port: 11740, token: "x" })).toThrow(/refused 10\.0\.0\.5/);
    expect(() => new TrustControl({ host: "127.0.0.1", port: 1, token: "x" })).not.toThrow();
  });

  it("refuses to start a project that isn't simulation-only", async () => {
    const dir = tempDir("cmcp-safe-");
    const write = (io: string, sim: string, rt: string) => {
      writeFileSync(join(dir, "io.toml"), io);
      writeFileSync(join(dir, "simulation.toml"), sim);
      writeFileSync(join(dir, "runtime.toml"), rt);
    };
    const io = '[io]\ndriver = "simulated"\nparams = {}\n';
    const sim = "[simulation]\nenabled = true\n";
    const rt = runtimeToml({ port: 4000, token: "t", cycleMs: 10 });
    write(io, sim, rt);
    await expect(assertSimulationOnly(dir)).resolves.toBeUndefined();
    write('[io]\ndriver = "modbus-tcp"\n', sim, rt);
    await expect(assertSimulationOnly(dir)).rejects.toThrow(/simulated driver/);
    write(io, "[simulation]\nenabled = false\n", rt);
    await expect(assertSimulationOnly(dir)).rejects.toThrow(/enable simulation/);
    write(io, sim, rt.replace("127.0.0.1", "0.0.0.0"));
    await expect(assertSimulationOnly(dir)).rejects.toThrow(/control endpoint/);
    write(io, sim, rt.replace("[runtime.web]\nenabled = false", "[runtime.web]\nenabled = true"));
    await expect(assertSimulationOnly(dir)).rejects.toThrow(/web UI/);
  });

  it("reads CODESYS only through export and tasks.list", () => {
    expect([...SIM_CODESYS_OPS]).toEqual(["export", "tasks.list"]);
    const simDir = join(ROOT, "src", "sim");
    for (const f of readdirSync(simDir)) {
      const src = readFileSync(join(simDir, f), "utf8");
      const calls = [...src.matchAll(/bridge\.call\b/g)];
      if (f === "tools.ts") expect(calls.length, f).toBe(1);
      else expect(calls.length, f).toBe(0);
      if (f !== "control.ts" && f !== "runtime.ts") expect(src, f).not.toMatch(/net\.connect|from "node:net"/);
      expect(src, f).not.toMatch(/\.(login|download|online_change|create_online_application)\s*\(/);
    }
  });
});

describe("mirror on disk and mapped diagnostics", () => {
  it("writes the mirror, removes stale files it owns, and maps build errors to CODESYS lines", async () => {
    const root = tempDir("cmcp-mirror-");
    const project = join(root, "Tank.project");
    writeFileSync(join(root, "Tank.plant.toml"), TANK_PLANT);
    let nodes = tankNodes();
    const sim = new SimController({ exportSt: async () => nodes, tasks: async () => tankTasks(), projectPath: () => project }, { mirrorRoot: join(root, "m"), git: false });
    const r = await sim.sync();
    expect(r.plantFile).toBe(join(root, "Tank.plant.toml"));
    expect(existsSync(join(r.dir, "src", "FB_PI.st"))).toBe(true);
    expect(readFileSync(join(r.dir, "io.toml"), "utf8")).toContain('driver = "simulated"');
    expect(readFileSync(join(r.dir, "trust-lsp.toml"), "utf8")).toContain('vendor_profile = "codesys"');
    expect(r.changed).toContain("PRG_Tank");

    const again = await sim.sync();
    expect(again.changed).toEqual([]);

    nodes = nodes.filter((n) => !n.path.startsWith("I_Resettable"));
    const third = await sim.sync();
    expect(third.removed).toEqual(["src/I_Resettable.st"]);
    expect(existsSync(join(r.dir, "src", "I_Resettable.st"))).toBe(false);
    expect((await readManifest(r.dir))!.files).not.toContain("src/I_Resettable.st");

    const text = readFileSync(join(r.dir, "src", "PRG_Tank.st"), "utf8");
    const at = Buffer.byteLength(text.slice(0, text.indexOf("nTrips := nTrips + 1;")), "utf8");
    const mapped = await sim.mapDiagnostics([{ file: "src/PRG_Tank.st", start: at, end: at + 5, message: "boom" }]);
    expect(mapped).toEqual([`PRG_Tank (implementation line ${LINES.trip}): boom`]);
  });

  it("keeps breakpoints on their CODESYS line across syncs", async () => {
    const root = tempDir("cmcp-bp-");
    const sim = new SimController({ exportSt: async () => tankNodes(), tasks: async () => tankTasks(), projectPath: () => join(root, "T.project") }, { mirrorRoot: root, git: false });
    await sim.sync();
    expect(await sim.setBreakpoint("prg_tank", LINES.trip, "PRG_Tank.nTrips > 0")).toBe(`Breakpoint #1 at PRG_Tank line ${LINES.trip}, condition: PRG_Tank.nTrips > 0 (applies when the simulation starts).`);
    await expect(sim.setBreakpoint("PRG_Tank", 99)).rejects.toThrow(/has 31 implementation line/);
    await expect(sim.setBreakpoint("Nope", 1)).rejects.toThrow(/not in the mirror/);
    await expect(sim.setBreakpoint("PRG_Tank", 1, "a >")).rejects.toThrow(ExprError);
    await sim.sync();
    expect(await sim.status()).toContain(`#1 PRG_Tank:${LINES.trip} if PRG_Tank.nTrips > 0`);
    expect(await sim.clearBreakpoint({ all: true })).toBe(`Cleared #1 (PRG_Tank:${LINES.trip}).`);
  });

  it("says clearly when truST is missing", async () => {
    const root = tempDir("cmcp-notrust-");
    const sim = new SimController({ exportSt: async () => tankNodes(), tasks: async () => tankTasks(), projectPath: () => join(root, "T.project") }, { mirrorRoot: root, trustRuntime: join(root, "missing.exe"), git: false });
    const old = process.env.PATH;
    const oldTr = process.env.TRUST_RUNTIME;
    process.env.PATH = "";
    delete process.env.TRUST_RUNTIME;
    try {
      await expect(sim.start()).rejects.toThrow(/trust-runtime was not found/);
    } finally {
      process.env.PATH = old;
      if (oldTr !== undefined) process.env.TRUST_RUNTIME = oldTr;
    }
  });
});

describe("simulation tools over MCP (fake CODESYS, no truST)", () => {
  let client: Client;
  let ctx: AppContext;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };

  beforeAll(async () => {
    const { codesysSource } = await import("../src/sim/tools.js");
    const bridge = fakeBridge();
    ctx = { bridge, autosave: true, workspace: tempDir(), startWaitMs: 20_000 };
    ctx.sim = new SimController(codesysSource(bridge, () => ctx.project?.path, 20_000), { mirrorRoot: tempDir("cmcp-mcpm-"), git: false });
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "test", version: "1" });
    await client.connect(b);
  });

  afterAll(async () => {
    await client?.close();
    await ctx?.bridge.stop();
  });

  it("registers the simulation tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["sync_mirror", "sim_start", "sim_stop", "sim_status", "run_scans", "run_for", "set_breakpoint", "clear_breakpoint", "continue", "step_over", "step_in", "step_out", "read_vars", "write_var", "force_var", "unforce_var", "set_plant_param", "run_experiment", "experiment_log", "run_tests"]) {
      expect(names).toContain(n);
    }
  });

  it("needs an open project", async () => {
    const r = await call("sync_mirror");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no_project/);
  });

  it("syncs the mirror from CODESYS and saves plant.toml next to the project", async () => {
    const project = fakeProjectFile();
    expect((await call("open_project", { path: project })).isError).toBe(false);
    const bad = await call("sync_mirror", { plant: "[[plant]]\nid = 1\n" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/needs an id/);
    const plant = '[[feedback]]\nsignal = "GVL_IO.bRunning"\nfollows = "GVL_IO.bStart"\ndelay_ms = 100\n';
    const r = await call("sync_mirror", { plant });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/Saved .*Sample\.plant\.toml/);
    expect(r.text).toMatch(/Changed: .*PLC_PRG/);
    expect(r.text).toMatch(/Warning: Not simulated \(graphical, not ST\): SEQ_Fill/);
    expect(readFileSync(project.replace(/\.project$/, ".plant.toml"), "utf8")).toBe(plant);
  });

  it("explains that the simulation is not running", async () => {
    const r = await call("run_scans", { n: 10 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not_running: .*sim_start/);
    expect((await call("sim_status")).text).toMatch(/Simulation: not running/);
  });
});
