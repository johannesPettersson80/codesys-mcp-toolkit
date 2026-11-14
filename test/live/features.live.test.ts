/**
 * The features beyond plain ST, on a real CODESYS, through the MCP tool: capabilities,
 * signatures and references, LD read-edit-replace, devices and I/O mapping, HMI with
 * symbols, the native export with CODESYS alarms (when the version can compile
 * visualizations), alarms in the simulation, the handover report and the text export.
 * Run with:
 *   CODESYS_LIVE=1 npx vitest run test/live/features.live.test.ts
 * Optional: CODESYS_PATH, CODESYS_PROFILE. Works on a fresh project in a temp folder.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CodesysBridge } from "../../src/bridge/bridge.js";
import { resolveCodesys } from "../../src/codesys/install.js";
import { createServer } from "../../src/server.js";
import type { AppContext } from "../../src/tools.js";
import { tempDir, viaCodesys, WATCHER } from "../helpers.js";

const LONG = 900_000;
const dir = tempDir("cmcp-features-");
const log: string[] = [];
let client: Client;
let ctx: AppContext;
let canExport = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool(viaCodesys(name, args), undefined, { timeout: LONG })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  log.push(`> ${name} ${JSON.stringify(args).slice(0, 300)}\n${text.slice(0, 2000)}`);
  return { text, isError: !!r.isError };
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.text;
}

const PRG = {
  declaration: "PROGRAM PLC_PRG\nVAR\n    xStart : BOOL;\n    xStop : BOOL;\n    xRun : BOOL;\n    xFault : BOOL;\n    rLevel : REAL := 40;\n    tonDelay : TON;\nEND_VAR",
  implementation: "IF xStop OR xFault THEN\n    xRun := FALSE;\nELSIF xStart THEN\n    xRun := TRUE;\nEND_IF\ntonDelay(IN := xRun, PT := T#1S);\nIF xRun THEN rLevel := rLevel + 0.1; END_IF",
};

describe("live CODESYS: features beyond ST", () => {
  beforeAll(async () => {
    const cs = resolveCodesys(process.env.CODESYS_PATH, process.env.CODESYS_PROFILE);
    const bridge = new CodesysBridge({ command: cs.exe, profile: cs.profile, additionalFolder: cs.install.additionalFolder, watcherSource: WATCHER, sessionRoot: join(dir, "sessions"), log: (m) => log.push(m) });
    ctx = { bridge, autosave: true, workspace: dir, templatesDir: cs.install.templatesDir, codesys: { exe: cs.exe, profile: cs.profile, label: cs.install.label }, startWaitMs: LONG };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "features-live", version: "1" });
    await client.connect(b);
    await bridge.start();
    await ok("create_project", { path: "Features.project" });
    await ok("write_object", { path: "PLC_PRG", ...PRG });
    expect(await ok("compile")).toMatch(/0 error\(s\)/);
  }, LONG);

  afterAll(async () => {
    await call("codesys_sim_stop").catch(() => undefined);
    await client?.close();
    await ctx?.bridge.stop();
    process.stderr.write(`\n---- features live log (${dir}) ----\n${log.join("\n")}\n`);
  }, 120_000);

  it("reports what this CODESYS offers", async () => {
    await sleep(1500);
    const s = await ok("codesys_status");
    expect(s).toMatch(/Features: .*signatures/);
    canExport = /Features: [^.]*floating point utils/.test(s) && /Features: [^.]*visualization/.test(s);
  }, LONG);

  it("reads library interfaces and cross-references from the compiler", async () => {
    expect(await ok("get_signature", { names: ["TON"] })).toMatch(/IN : BOOL[\s\S]*PT : TIME[\s\S]*Q : BOOL/);
    expect(await ok("find_references", { name: "xRun" })).toMatch(/write/i);
  }, LONG);

  it("creates a ladder POU, reads it as a description, and replaces it with an extra rung", async () => {
    const decl = "PROGRAM LD_Lamp\nVAR\n    xA : BOOL;\n    xB : BOOL;\n    xLamp : BOOL;\n    xAlarm : BOOL;\nEND_VAR";
    await ok("create_graphical", { name: "LD_Lamp", declaration: decl, ladder: { rungs: [{ when: { and: ["xA", "NOT xB"] }, then: [{ coil: "xLamp" }] }] } });
    const read = await ok("read_objects", { paths: ["LD_Lamp"] });
    const ld = JSON.parse(/\{"ladder":.*\}/.exec(read)![0]).ladder as { rungs: unknown[] };
    expect(ld.rungs).toEqual([{ when: { and: ["xA", "NOT xB"] }, then: [{ coil: "xLamp", kind: "coil" }] }]);
    ld.rungs.push({ when: "xB", then: [{ coil: "xAlarm", kind: "set" }] });
    expect(await ok("create_graphical", { name: "LD_Lamp", declaration: decl, ladder: ld, replace: true })).toMatch(/^Replaced/);
    expect(await ok("compile")).toMatch(/0 error\(s\)/);
    expect(await ok("read_objects", { paths: ["LD_Lamp"] })).toContain('{"when":"xB","then":[{"coil":"xAlarm","kind":"set"}]}');
  }, LONG);

  it("adds a Modbus device, sets a parameter and maps a channel", async () => {
    const found = await ok("find_device", { text: "ModbusTCP Server Device" });
    const m = /type=(\d+) id='([^']+)' version='([^']+)'/.exec(found);
    expect(m, found).not.toBeNull();
    await ok("add_device", { parent: "/PLCWinNT", name: "Ethernet", type: 110, id: "0000 0002", version: (/Ethernet.*version='([^']+)'/.exec(await ok("find_device", { text: "Ethernet" })) ?? [])[1] ?? "4.2.0.0" }).catch(() => undefined);
    const devs = await ok("get_devices", { io: false });
    const eth = /^\s*(\S*Ethernet\S*)/m.exec(devs)?.[1];
    expect(eth, devs).toBeTruthy();
    await ok("add_device", { parent: `/PLCWinNT/${eth}`, name: "MB_Server", type: Number(m![1]), id: m![2], version: m![3] });
    const params = await ok("device_parameters", { device: `/PLCWinNT/${eth}/MB_Server`, channels: true, depth: 1 });
    const key = /^\s+(c\d+\/\d+\/\S+)\s+\S+ Registers\[0\]/m.exec(params)?.[1];
    expect(key, params).toBeTruthy();
    expect(await ok("configure_device", { device: `/PLCWinNT/${eth}/MB_Server`, mappings: [{ channel: key, variable: "wRegister0" }] })).toMatch(/-> wRegister0 at %[IQ]W/);
    expect(await ok("compile")).toMatch(/0 error\(s\)/);
    expect(await ok("get_io_list")).toMatch(/wRegister0/);
  }, LONG);

  it("saves an HMI with a standard symbol, a custom one and alarms", async () => {
    await ok("hmi_save_symbol", { name: "box_tank", svg: '<rect x="5" y="5" width="90" height="90" rx="10" fill="var(--body)" stroke="var(--state)" stroke-width="5"/>', ports: { in: { x: 5, y: 50, dir: "left" } } });
    await ok("hmi_save_screen", {
      screen: {
        name: "Overview",
        title: "Features",
        widgets: [
          { type: "process", at: [1, 1, 8, 6], items: [{ type: "symbol", symbol: "motor", label: "M-1", x: 30, y: 50, size: 12, on: "PLC_PRG.xRun", fault: "PLC_PRG.xFault" }, { type: "symbol", symbol: "box_tank", label: "B-1", x: 70, y: 50, size: 14 }, { type: "pipe", from: [0, 50], to: "B-1.in" }] },
          { type: "gauge", title: "Level", at: [9, 1, 4, 3], value: "PLC_PRG.rLevel", min: 0, max: 100, unit: "%" },
          { type: "alarms", title: "Alarms", at: [9, 4, 4, 3], items: [{ active: "PLC_PRG.xFault", text: "Motor fault" }] },
        ],
      },
    });
  }, LONG);

  it("exports the HMI as a native visualization with CODESYS alarms (when this CODESYS can compile one)", async () => {
    if (!canExport) return;
    const r = await ok("hmi_export_codesys");
    expect(r).toMatch(/1 alarm\(s\) in CODESYS alarm management/);
    expect(r).toMatch(/Compiles with 0 errors/);
  }, LONG);

  it("tests the alarm in the simulation: active, cleared, acknowledged", async () => {
    if (!canExport) return;
    await ok("codesys_sim_start", { run: true });
    await ok("codesys_sim_write", { values: { "PLC_PRG.xFault": "TRUE" } });
    await sleep(1500);
    expect(await ok("alarm_status")).toMatch(/ACTIVE\s+\[Error\] Motor fault/);
    await ok("codesys_sim_write", { values: { "PLC_PRG.xFault": "FALSE" } });
    await sleep(1500);
    expect(await ok("alarm_status")).toMatch(/cleared, waiting for confirmation/);
    expect(await ok("alarm_acknowledge")).toMatch(/-> normal/);
    await sleep(1000);
    // The export added the alarm history: active, cleared, normal, newest first.
    expect(await ok("alarm_history")).toMatch(/normal\s+Motor fault[\s\S]*cleared, waiting for confirmation\s+Motor fault[\s\S]*ACTIVE\s+Motor fault/);
    await ok("codesys_sim_stop");
  }, LONG);

  it("writes the handover report and the text export", async () => {
    const rep = await ok("project_report");
    const file = /Wrote (.*\.report\.md)/.exec(rep)![1]!;
    expect(readFileSync(file, "utf8")).toMatch(/## Commissioning checklist[\s\S]*- \[ \] Safety functions/);
    const exp = await ok("export_sources", { dir: join(dir, "src") });
    expect(exp).toMatch(/\d+ \.st file\(s\), 1 graphical body\(ies\) as \.xml/);
    expect(existsSync(join(dir, "src", "PLC_PRG.st"))).toBe(true);
    expect(await ok("export_sources", { dir: join(dir, "src") })).toMatch(/ 0 file\(s\) written or changed/);
  }, LONG);

  it("draws an SFC with alternative and parallel branches and a CFC, and runs them", async () => {
    const chart = [
      { step: "Idle" },
      { when: "xGo" },
      { step: "Check" },
      { alternative: [[{ when: "xBad" }, { step: "Reject" }, { when: "NOT xBad" }, { jump: "Idle" }], [{ when: "NOT xBad" }]] },
      { parallel: [[{ step: "Fill", actions: [{ name: "A_Fill", qualifier: "N", st: "nA := nA + 1;" }] }], [{ step: "Heat", actions: [{ name: "A_Heat", qualifier: "N", st: "nB := nB + 1;" }] }]] },
      { when: "nA >= 3 AND nB >= 3" },
      { step: "Done" },
      { when: "NOT xGo" },
    ];
    await ok("create_graphical", { name: "SFC_Branch", declaration: "PROGRAM SFC_Branch\nVAR\n    xGo, xBad : BOOL;\n    nA, nB : INT;\nEND_VAR", sfc: { chart } });
    await ok("create_graphical", { name: "CFC_Calc", declaration: "PROGRAM CFC_Calc\nVAR\n    nIn, nOut : INT;\nEND_VAR", cfc: { networks: [{ expr: { fn: "LIMIT", args: ["0", { fn: "ADD", args: ["nIn", "5"] }, "100"] }, to: "nOut" }] } });
    expect(await ok("read_objects", { paths: ["SFC_Branch"] })).toContain('"alternative":[[{"when":"xBad"}');
    expect(await ok("read_objects", { paths: ["CFC_Calc"] })).toContain('"cfc":{"networks":[{"expr":{"fn":"LIMIT"');
    await ok("write_object", { path: "PLC_PRG", implementation: `${PRG.implementation}\nSFC_Branch();\nCFC_Calc();` });
    expect(await ok("compile")).toMatch(/0 error\(s\)/);
    await ok("codesys_sim_start", { run: false });
    await ok("codesys_sim_write", { values: { "SFC_Branch.xGo": "TRUE", "CFC_Calc.nIn": "98" } });
    let r = "";
    for (let k = 0; k < 6 && !/Done\.x = TRUE/.test(r); k++) {
      await ok("codesys_sim_cycle", { count: 10 });
      r = await ok("codesys_sim_read", { names: ["SFC_Branch.Done.x", "SFC_Branch.Idle.x", "SFC_Branch.Check.x", "SFC_Branch.nA", "SFC_Branch.nB", "CFC_Calc.nOut"] });
    }
    expect(r).toMatch(/SFC_Branch\.Done\.x = TRUE/);
    expect(r).toMatch(/CFC_Calc\.nOut = INT#100/);
  }, LONG);

  it("watches values and halts on a data breakpoint and a line breakpoint", async () => {
    await ok("codesys_sim_control", { action: "run" });
    await ok("codesys_sim_write", { values: { "PLC_PRG.xStart": "TRUE" } });
    expect(await ok("watch", { add: ["PLC_PRG.rLevel", "PLC_PRG.xRun"], samples: 3, every: 300 })).toMatch(/PLC_PRG\.rLevel = REAL#[\d.]+\s+\[min [\d.]+, max [\d.]+, \d change/);
    await ok("breakpoint_on_change", { variable: "PLC_PRG.rLevel" });
    await sleep(1500);
    expect(await ok("debug_status")).toMatch(/Halted in PLC_PRG/);
    await ok("breakpoint_clear");
    await ok("debug_continue");
    await ok("breakpoint_set", { path: "PLC_PRG", line: 6 });
    await sleep(1500);
    expect(await ok("debug_status")).toMatch(/Halted in PLC_PRG at line 6/);
    await ok("breakpoint_clear");
    await ok("debug_continue");
    await ok("codesys_sim_stop");
  }, LONG);

  it("compares the project with its earlier export, and pins a library", async () => {
    const cmp = await ok("compare_sources", { with: join(dir, "src") });
    expect(cmp).toMatch(/Only in .*\(open\):[\s\S]*\+ SFC_Branch/);
    expect(cmp).toMatch(/~ PLC_PRG/);
    expect(await ok("find_library", { query: "Standard", limit: 3 })).toMatch(/^Standard \(System\)/m);
    expect(await ok("pin_library", { name: "Standard" })).toMatch(/-> Standard, [\d.]+ \(System\) \(pinned\)/);
    expect(await ok("compile")).toMatch(/0 error\(s\)/);
    expect(await ok("pin_library", { name: "Standard", unpin: true })).toMatch(/Standard, \* \(System\)/);
  }, LONG);
});
