/**
 * A complete project with page-oriented CFC, on a real CODESYS, through the MCP tool: a conveyor
 * station whose control is a three-page CFC (start/stop latch, motor with start warning, jam
 * fault and part counter) joined by connection marks both ways, a plain CFC beside it, I/O in a
 * GVL. It compiles, is tested in CODESYS's simulation, is read back with its pages and
 * positions, edited (a timer preset and a box moved), replaced, and tested again.
 * Run with:
 *   CODESYS_LIVE=1 npx vitest run test/live/cfc.live.test.ts
 * Optional: CODESYS_PATH, CODESYS_PROFILE. Works on a fresh project in a temp folder, headless.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CodesysBridge } from "../../src/bridge/bridge.js";
import { resolveCodesys } from "../../src/codesys/install.js";
import { createServer } from "../../src/server.js";
import type { AppContext } from "../../src/tools.js";
import type { CfcChart, CfcElement } from "../../src/codesys/cfc.js";
import { tempDir, viaCodesys, WATCHER } from "../helpers.js";

const LONG = 900_000;
const live = process.env.CODESYS_LIVE === "1";
const dir = tempDir("cmcp-cfc-live-");
const log: string[] = [];
let client: Client;
let ctx: AppContext;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool(viaCodesys(name, args), undefined, { timeout: LONG })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  log.push(`> ${name} ${JSON.stringify(args).slice(0, 400)}\n${text.slice(0, 3000)}`);
  return { text, isError: !!r.isError };
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.text;
}

const GVL = `VAR_GLOBAL
    xStartBtn : BOOL;     // start push button
    xStopBtn : BOOL;      // stop push button (TRUE = pressed)
    xEStopOk : BOOL;      // emergency stop circuit healthy
    xResetBtn : BOOL;     // fault reset
    xPartAtEnd : BOOL;    // sensor at the end of the belt
    xMotor : BOOL;        // belt motor contactor
    xLampRun : BOOL;
    xLampFault : BOOL;
    xHorn : BOOL;         // start warning
    nPartCount : WORD;
    xBatchFull : BOOL;
END_VAR`;

const DECL = `PROGRAM PRG_Conveyor
VAR
    rtStart : R_TRIG;
    rsRun : RS;
    tonWarn : TON;
    tonJam : TON;
    rsFault : RS;
    ctuParts : CTU;
END_VAR`;

/** The conveyor: page 1 start/stop, page 2 motor with a start warning, page 3 jam fault and counter. */
const conveyor: CfcChart = {
  pages: [{ name: "Start/Stop" }, { name: "Motor", description: "Horn for 2 s, then the motor" }, { name: "Fault and count" }],
  elements: [
    // page 1
    { id: "start", input: "GVL_IO.xStartBtn", page: 1 },
    { id: "stop", input: "GVL_IO.xStopBtn", page: 1 },
    { id: "estop", input: "GVL_IO.xEStopOk", page: 1 },
    { id: "faultIn1", mark: "Fault", page: 1 },
    { id: "rtStart", box: "R_TRIG", instance: "rtStart", page: 1 },
    { id: "notEStop", box: "NOT", page: 1 },
    { id: "notFault", box: "NOT", page: 1 },
    { id: "startOk", box: "AND", page: 1 },
    { id: "stopAny", box: "OR", page: 1 },
    { id: "rsRun", box: "RS", instance: "rsRun", page: 1 },
    { id: "run", mark: "Run", page: 1 },
    { id: "note1", comment: "Start on a rising edge unless faulted; stop, E-stop or fault stops", page: 1 },
    // page 2
    { id: "run2", mark: "Run", page: 2 },
    { id: "warnTime", input: "T#2S", page: 2 },
    { id: "tonWarn", box: "TON", instance: "tonWarn", page: 2 },
    { id: "motorOn", box: "AND", page: 2 },
    { id: "notWarned", box: "NOT", page: 2 },
    { id: "hornOn", box: "AND", page: 2 },
    { id: "motor", output: "GVL_IO.xMotor", page: 2 },
    { id: "lampRun", output: "GVL_IO.xLampRun", page: 2 },
    { id: "horn", output: "GVL_IO.xHorn", page: 2 },
    // page 3
    { id: "run3", mark: "Run", page: 3 },
    { id: "part", input: "GVL_IO.xPartAtEnd", page: 3 },
    { id: "reset", input: "GVL_IO.xResetBtn", page: 3 },
    { id: "jamTime", input: "T#3S", page: 3 },
    { id: "limit", input: "1000", page: 3 },
    { id: "jamCond", box: "AND", page: 3 },
    { id: "tonJam", box: "TON", instance: "tonJam", page: 3 },
    { id: "rsFault", box: "RS", instance: "rsFault", page: 3 },
    { id: "ctuParts", box: "CTU", instance: "ctuParts", page: 3 },
    { id: "fault", mark: "Fault", page: 3 },
    { id: "lampFault", output: "GVL_IO.xLampFault", page: 3 },
    { id: "count", output: "GVL_IO.nPartCount", page: 3 },
  ],
  wires: [
    { from: "start", to: "rtStart.CLK" },
    { from: "estop", to: "notEStop.In1" },
    { from: "faultIn1", to: "notFault.In1" },
    { from: "rtStart.Q", to: "startOk.In1" },
    { from: "notFault", to: "startOk.In2" },
    { from: "stop", to: "stopAny.In1" },
    { from: "notEStop", to: "stopAny.In2" },
    { from: "faultIn1", to: "stopAny.In3" },
    { from: "startOk", to: "rsRun.SET" },
    { from: "stopAny", to: "rsRun.RESET1" },
    { from: "rsRun.Q1", to: "run" },
    { from: "run2", to: "tonWarn.IN" },
    { from: "warnTime", to: "tonWarn.PT" },
    { from: "run2", to: "motorOn.In1" },
    { from: "tonWarn.Q", to: "motorOn.In2" },
    { from: "tonWarn.Q", to: "notWarned.In1" },
    { from: "run2", to: "hornOn.In1" },
    { from: "notWarned", to: "hornOn.In2" },
    { from: "motorOn", to: "motor" },
    { from: "run2", to: "lampRun" },
    { from: "hornOn", to: "horn" },
    { from: "run3", to: "jamCond.In1" },
    { from: "part", to: "jamCond.In2" },
    { from: "jamCond", to: "tonJam.IN" },
    { from: "jamTime", to: "tonJam.PT" },
    { from: "tonJam.Q", to: "rsFault.SET" },
    { from: "reset", to: "rsFault.RESET1" },
    { from: "rsFault.Q1", to: "fault" },
    { from: "rsFault.Q1", to: "lampFault" },
    { from: "part", to: "ctuParts.CU" },
    { from: "reset", to: "ctuParts.RESET" },
    { from: "limit", to: "ctuParts.PV" },
    { from: "ctuParts.CV", to: "count" },
  ],
};

/** A plain CFC beside it: the batch is full at 3 parts. */
const stats: CfcChart = {
  elements: [
    { id: "count", input: "GVL_IO.nPartCount" },
    { id: "three", input: "3" },
    { id: "full", box: "GE" },
    { id: "out", output: "GVL_IO.xBatchFull" },
  ],
  wires: [
    { from: "count", to: "full.In1" },
    { from: "three", to: "full.In2" },
    { from: "full", to: "out" },
  ],
};

const G = "GVL_IO.";
const press = (name: string) => [{ write: { [G + name]: "TRUE" }, cycles: 2 }, { write: { [G + name]: "FALSE" }, cycles: 2 }];

/** The description read_objects gives for a CFC. */
async function readChart(path: string): Promise<{ text: string; chart: CfcChart }> {
  const text = await ok("read_objects", { paths: [path] });
  const m = /--- (?:page-oriented )?CFC body, as create_graphical's description ---\n(.+)\n/.exec(text);
  expect(m, text).not.toBeNull();
  return { text, chart: (JSON.parse(m![1]!) as { cfc: CfcChart }).cfc };
}

describe.skipIf(!live)("live CODESYS: a complete project with page-oriented CFC", () => {
  beforeAll(async () => {
    const cs = resolveCodesys(process.env.CODESYS_PATH, process.env.CODESYS_PROFILE);
    const bridge = new CodesysBridge({ command: cs.exe, profile: cs.profile, additionalFolder: cs.install.additionalFolder, watcherSource: WATCHER, sessionRoot: join(dir, "sessions"), log: (m) => log.push(m) });
    ctx = { bridge, autosave: true, workspace: dir, templatesDir: cs.install.templatesDir, codesys: { exe: cs.exe, profile: cs.profile, label: cs.install.label }, startWaitMs: LONG };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "cfc-live", version: "1" });
    await client.connect(b);
    await bridge.start();
    await ok("create_project", { path: "Conveyor.project" });
  }, LONG);

  afterAll(async () => {
    await call("codesys_sim_stop").catch(() => undefined);
    await client?.close();
    await ctx?.bridge.stop();
    process.stderr.write(`\n---- cfc live log (${dir}) ----\n${log.join("\n")}\n`);
  }, 120_000);

  it("creates the I/O, the three-page CFC and the plain CFC, with no import messages", async () => {
    await ok("create_object", { kind: "gvl", name: "GVL_IO", declaration: GVL });
    const made = await ok("create_graphical", { name: "PRG_Conveyor", declaration: DECL, cfc: conveyor });
    expect(made).toMatch(/Created .*PRG_Conveyor in page-oriented CFC with 3 pages, 14 boxes and 33 wires\./);
    expect(made).not.toMatch(/import said/);
    const plain = await ok("create_graphical", { name: "PRG_Stats", declaration: "PROGRAM PRG_Stats\nVAR\nEND_VAR", cfc: stats });
    expect(plain).toMatch(/Created .*PRG_Stats in CFC with 1 boxes and 3 wires\./);
    expect(await ok("get_project_tree")).toMatch(/PRG_Conveyor .*\[non-ST\]/);
  }, LONG);

  it("compiles once a task calls them", async () => {
    await ok("configure_task", { name: "MainTask", add_calls: ["PRG_Conveyor", "PRG_Stats"] });
    const r = await ok("compile");
    expect(r, r).toMatch(/Build: 0 error\(s\)/);
  }, LONG);

  it("works in CODESYS's simulation: start warning, stop, E-stop, jam fault, counter", async () => {
    await ok("codesys_sim_start", { run: true });
    const r = await ok("codesys_sim_test", {
      cases: [
        {
          // The simulation runs in real time and a step takes about half a second, so the
          // horn is checked in the step right after the press, well inside its 2 s.
          name: "start: horn first, motor after 2 s",
          steps: [
            { write: { [G + "xEStopOk"]: "TRUE", [G + "xResetBtn"]: "FALSE" }, cycles: 2 },
            { write: { [G + "xStartBtn"]: "TRUE" }, cycles: 2 },
            { write: { [G + "xStartBtn"]: "FALSE" }, cycles: 2, expect: { [G + "xLampRun"]: true, [G + "xHorn"]: true, [G + "xMotor"]: false } },
            { waitMs: 2500, expect: { [G + "xMotor"]: true, [G + "xHorn"]: false } },
          ],
        },
        { name: "stop", steps: [...press("xStopBtn"), { cycles: 2, expect: { [G + "xMotor"]: false, [G + "xLampRun"]: false } }] },
        {
          name: "E-stop stops it",
          steps: [...press("xStartBtn"), { waitMs: 2500, expect: { [G + "xMotor"]: true } }, { write: { [G + "xEStopOk"]: "FALSE" }, cycles: 2, expect: { [G + "xMotor"]: false, [G + "xLampRun"]: false } }, { write: { [G + "xEStopOk"]: "TRUE" }, cycles: 2 }],
        },
        {
          name: "a part held at the end for 3 s is a jam: fault, stop, no restart until reset",
          steps: [
            ...press("xStartBtn"),
            { waitMs: 2500, expect: { [G + "xMotor"]: true } },
            { write: { [G + "xPartAtEnd"]: "TRUE" }, waitMs: 3500, expect: { [G + "xLampFault"]: true, [G + "xMotor"]: false, [G + "xLampRun"]: false } },
            ...press("xStartBtn"),
            { cycles: 2, expect: { [G + "xLampRun"]: false } },
            { write: { [G + "xPartAtEnd"]: "FALSE" }, cycles: 2 },
            ...press("xResetBtn"),
            { cycles: 2, expect: { [G + "xLampFault"]: false } },
          ],
        },
        {
          name: "parts are counted, reset clears, the plain CFC says when the batch is full",
          steps: [
            { cycles: 2, expect: { [G + "nPartCount"]: 0, [G + "xBatchFull"]: false } },
            ...press("xPartAtEnd"),
            ...press("xPartAtEnd"),
            { cycles: 2, expect: { [G + "nPartCount"]: 2, [G + "xBatchFull"]: false } },
            ...press("xPartAtEnd"),
            { cycles: 2, expect: { [G + "nPartCount"]: 3, [G + "xBatchFull"]: true } },
            ...press("xResetBtn"),
            { cycles: 2, expect: { [G + "nPartCount"]: 0, [G + "xBatchFull"]: false } },
          ],
        },
      ],
    });
    expect(r, r).toMatch(/5 passed, 0 failed/);
    await ok("codesys_sim_stop");
  }, LONG);

  let before: CfcChart;
  it("reads the chart back with its pages, marks and positions", async () => {
    const { chart } = await readChart("PRG_Conveyor");
    before = chart;
    expect(chart.pages).toEqual([{ name: "Start/Stop" }, { name: "Motor", description: "Horn for 2 s, then the motor" }, { name: "Fault and count" }]);
    expect(chart.elements).toHaveLength(conveyor.elements.length);
    expect(chart.wires).toHaveLength(conveyor.wires!.length);
    const marks = chart.elements.filter((e) => e.mark);
    expect(marks.map((e) => `${e.mark}@${e.page}`).sort()).toEqual(["Fault@1", "Fault@3", "Run@1", "Run@2", "Run@3"]);
    for (const e of chart.elements) expect(e.x !== undefined && e.y !== undefined, e.id).toBe(true);
    const plain = (await readChart("PRG_Stats")).chart;
    expect(plain.pages).toBeUndefined();
    expect(plain.elements.find((e) => e.box)).toMatchObject({ box: "GE" });
  }, LONG);

  it("takes an edited chart back: the new preset runs, the moved box stays where it was put", async () => {
    await call("codesys_sim_stop"); // whatever the test before left running
    const chart = structuredClone(before);
    const preset = chart.elements.find((e) => e.input === "T#2S")!;
    preset.input = "T#3S";
    const jam = chart.elements.find((e) => e.instance === "tonJam")!;
    const moved = { x: jam.x! + 4, y: jam.y! + 6 };
    Object.assign(jam, moved);
    const r = await ok("create_graphical", { name: "PRG_Conveyor", declaration: DECL, cfc: chart, replace: true });
    expect(r).toMatch(/^Replaced .*PRG_Conveyor in page-oriented CFC/);
    const after = (await readChart("PRG_Conveyor")).chart;
    expect(after.elements.find((e) => e.instance === "tonJam")).toMatchObject(moved);
    expect(after.elements.find((e) => e.input === "T#3S")).toBeDefined();
    // everything not edited is where it was, in the same order (ids come from the text, so an
    // edited input gets a new one)
    const at = (c: CfcChart) => c.elements.filter((e: CfcElement) => e.instance !== "tonJam").map((e) => [e.box ?? e.input ?? e.output ?? e.mark ?? e.comment, e.page, e.area, e.x, e.y]);
    expect(at(after)).toEqual(at(before).map((r) => (r[0] === "T#2S" ? ["T#3S", ...r.slice(1)] : r)));
    expect(await ok("list_tasks")).toMatch(/MainTask[^\n]*PRG_Conveyor/);
    expect(await ok("compile")).toMatch(/Build: 0 error\(s\)/);
    await ok("codesys_sim_start", { run: true });
    const t = await ok("codesys_sim_test", {
      cases: [
        {
          name: "the motor now starts after 3 s",
          steps: [
            { write: { [G + "xEStopOk"]: "TRUE" }, cycles: 2 },
            { write: { [G + "xStartBtn"]: "TRUE" }, cycles: 2 },
            { write: { [G + "xStartBtn"]: "FALSE" }, waitMs: 1700, expect: { [G + "xMotor"]: false, [G + "xHorn"]: true } }, // past the old 2 s
            { waitMs: 2000, expect: { [G + "xMotor"]: true, [G + "xHorn"]: false } },
            ...press("xStopBtn"),
          ],
        },
      ],
    });
    expect(t, t).toMatch(/1 passed, 0 failed/);
    await ok("codesys_sim_stop");
  }, LONG);
});
