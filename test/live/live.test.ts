/**
 * Live test against a real CODESYS installation. Run with:
 *   CODESYS_LIVE=1 npx vitest run test/live
 * Optional: CODESYS_PATH, CODESYS_PROFILE. Works on a fresh project in a temp folder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CodesysBridge } from "../../src/bridge/bridge.js";
import { resolveCodesys } from "../../src/codesys/install.js";
import { createServer } from "../../src/server.js";
import type { AppContext } from "../../src/tools.js";
import { ChangeStore } from "../../src/codesys/changes.js";
import { tempDir, WATCHER } from "../helpers.js";

const LONG = 600_000;
let client: Client;
let ctx: AppContext;
const dir = tempDir("cmcp-live-");
const log: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content.map((c) => c.text).join("\n");
  log.push(`> ${name} ${JSON.stringify(args)}\n${text}`);
  return { text, isError: !!r.isError };
}

beforeAll(async () => {
  const cs = resolveCodesys(process.env.CODESYS_PATH, process.env.CODESYS_PROFILE);
  const bridge = new CodesysBridge({
    command: cs.exe,
    profile: cs.profile,
    additionalFolder: cs.install.additionalFolder,
    watcherSource: WATCHER,
    sessionRoot: join(dir, "sessions"),
    log: (m) => log.push(m),
  });
  ctx = {
    bridge,
    autosave: true,
    workspace: dir,
    templatesDir: cs.install.templatesDir,
    codesys: { exe: cs.exe, profile: cs.profile, label: cs.install.label },
    startWaitMs: LONG,
    changes: new ChangeStore(join(dir, "checkpoints")),
  };
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "live", version: "1" });
  await client.connect(b);
  const t = Date.now();
  await bridge.start();
  log.push(`CODESYS ready in ${Math.round((Date.now() - t) / 1000)}s`);
}, LONG);

afterAll(async () => {
  await client?.close();
  await ctx?.bridge.stop();
  process.stderr.write(`\n---- live log (${dir}) ----\n${log.join("\n")}\n`);
}, 60_000);

describe("live CODESYS", () => {
  it("creates a project from the Standard template", async () => {
    const r = await call("create_project", { path: "LiveTest.project" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/Active application: Application/);
  }, LONG);

  it("lists the tree with localised task config found by GUID", async () => {
    const r = await call("get_project_tree");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/PLC_PRG {2}\[program\]/);
    expect(r.text).toMatch(/\[task_config\]/);
    expect(r.text).toMatch(/\[library_manager\]/);
  }, LONG);

  it("rejects a headerless declaration (issue #5)", async () => {
    const r = await call("write_object", { path: "PLC_PRG", declaration: "VAR\n    x : INT;\nEND_VAR" });
    expect(r.isError).toBe(true);
  }, LONG);

  it("builds a small tank program with OOP objects", async () => {
    const steps: [string, Record<string, unknown>][] = [
      ["create_object", { kind: "dut", dutType: "enum", name: "E_Mode", declaration: "{attribute 'qualified_only'}\nTYPE E_Mode :\n(\n    MANUAL := 0,\n    AUTO := 1\n);\nEND_TYPE" }],
      ["create_object", { kind: "interface", name: "I_Resettable" }],
      ["create_object", { parent: "I_Resettable", kind: "method", name: "Reset", returnType: "BOOL" }],
      ["create_object", { kind: "function_block", name: "FB_PI", declaration: "FUNCTION_BLOCK FB_PI IMPLEMENTS I_Resettable\nVAR_INPUT\n    rPV, rSP : REAL;\nEND_VAR\nVAR_OUTPUT\n    rY : REAL;\nEND_VAR\nVAR\n    _rKp : REAL := 2.0;\n    rI : REAL;\nEND_VAR", implementation: "rI := rI + (rSP - rPV) * 0.01;\nrY := _rKp * (rSP - rPV) + rI;" }],
      ["create_object", { parent: "FB_PI", kind: "method", name: "Reset", returnType: "BOOL", implementation: "rI := 0;\nReset := TRUE;" }],
      ["create_object", { parent: "FB_PI", kind: "property", name: "Kp", returnType: "REAL" }],
      ["write_object", { path: "FB_PI/Kp/Get", implementation: "Kp := _rKp;" }],
      ["write_object", { path: "FB_PI/Kp/Set", implementation: "_rKp := Kp;" }],
      ["create_object", { kind: "function", name: "F_Clamp", returnType: "REAL", declaration: "FUNCTION F_Clamp : REAL\nVAR_INPUT\n    x : REAL;\nEND_VAR", implementation: "F_Clamp := LIMIT(0.0, x, 100.0);" }],
      ["create_object", { kind: "gvl", name: "GVL_Par", declaration: "VAR_GLOBAL\n    eMode : E_Mode := E_Mode.AUTO;\n    sTag : STRING := 'Nivå åäö';\n    rLimit : REAL; // 液位上限 測試\nEND_VAR" }],
      ["write_object", { path: "PLC_PRG", declaration: "PROGRAM PLC_PRG\nVAR\n    fbPI : FB_PI;\n    itf : I_Resettable;\n    rOut : REAL;\nEND_VAR", implementation: "fbPI.Kp := 3.0;\nfbPI(rPV := 0.5, rSP := 1.0);\nrOut := F_Clamp(fbPI.rY);\nIF GVL_Par.eMode = E_Mode.MANUAL THEN\n    itf := fbPI;\n    itf.Reset();\nEND_IF" }],
    ];
    for (const [tool, args] of steps) {
      const r = await call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}: ${r.text}`).toBe(false);
    }
  }, LONG);

  it("created the interface without IQueryInterface and kept non-ASCII text", async () => {
    const r = await call("read_objects", { paths: ["I_Resettable", "GVL_Par", "FB_PI/Kp/Get"] });
    expect(r.text).not.toContain("IQueryInterface");
    expect(r.text).toContain("'Nivå åäö'");
    expect(r.text).toContain("// 液位上限 測試"); // beyond Latin-1: PR #9
    expect(r.text).toContain("Kp := _rKp;");
  }, LONG);

  it("compiles cleanly", async () => {
    const r = await call("compile");
    expect(r.text).toMatch(/Build: 0 error\(s\)/);
  }, LONG);

  it("reports a compile error with object and position, then fixes it", async () => {
    await call("write_object", { path: "F_Clamp", implementation: "F_Clamp := 'text';" });
    const bad = await call("compile");
    expect(bad.text).toMatch(/Build: [1-9]\d* error\(s\)/);
    expect(bad.text).toMatch(/ERROR \S+ F_Clamp \(Line \d+, Column \d+ \(Impl\)\)/);
    await call("write_object", { path: "F_Clamp", implementation: "F_Clamp := LIMIT(0.0, x, 100.0);" });
    expect((await call("compile")).text).toMatch(/Build: 0 error\(s\)/);
  }, LONG);

  it("checks POUs no task calls only with check_all, and generates code with deep", async () => {
    const created = await call("create_object", {
      kind: "function_block",
      name: "FB_Unused",
      declaration: "FUNCTION_BLOCK FB_Unused\nVAR\n    n : INT;\nEND_VAR",
      implementation: "n := 'not a number';",
    });
    expect(created.isError, created.text).toBe(false);
    const plain = await call("compile", { check_all: false });
    log.push(`plain: ${plain.text}`);
    expect(plain.text).not.toMatch(/FB_Unused/); // CODESYS skips POUs no task reaches
    const all = await call("compile");
    log.push(`check_all: ${all.text}`);
    expect(all.text).toMatch(/ERROR \S+ FB_Unused \(Line \d+, Column \d+ \(Impl\)\)/);
    expect(all.text).toContain("Checked every POU");
    expect((await call("delete_object", { path: "FB_Unused" })).isError).toBe(false);
    const deep = await call("compile", { deep: true, clean: true });
    log.push(`deep: ${deep.text}`);
    expect(deep.text).toMatch(/Build: 0 error\(s\)/);
    expect(deep.text).toContain("Code generated.");
  }, LONG);

  it("creates and configures a task with program calls and a watchdog", async () => {
    expect((await call("create_object", { kind: "program", name: "PRG_Fast", implementation: ";" })).isError).toBe(false);
    const r = await call("configure_task", { name: "FastTask", create: true, kind: "cyclic", interval: "t#2ms", priority: 2, watchdog: { enabled: true, time: "t#10ms", sensitivity: 3 }, add_calls: ["PRG_Fast"] });
    log.push(`configure_task: ${r.text}`);
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/^Created task FastTask: Cyclic, interval t#2ms, priority 2, watchdog/);
    expect(r.text).toContain("calls PRG_Fast");
    const fb = await call("configure_task", { name: "FastTask", add_calls: ["FB_PI"] });
    expect(fb.text).toContain("FB_PI is not a PROGRAM");
    const tasks = (await call("list_tasks")).text;
    log.push(`list_tasks: ${tasks}`);
    expect(tasks).toMatch(/FastTask: Cyclic, interval t#2ms, priority 2.*calls PRG_Fast/);
    expect((await call("compile")).text).toMatch(/Build: 0 error\(s\)/);
    // SP21's scripting can't remove a call; the toolkit says so instead of failing silently.
    const removed = await call("configure_task", { name: "FastTask", remove_calls: ["PRG_Fast"] });
    log.push(`remove_calls: ${removed.text}`);
    if (removed.isError) expect(removed.text).toContain("can't remove a program call from a task");
    else expect(removed.text).toMatch(/calls nothing/);
  }, LONG);

  it("lists the device tree and reports the compiler version", async () => {
    const d = await call("get_devices");
    log.push(`get_devices: ${d.text}`);
    expect(d.isError, d.text).toBe(false);
    expect(d.text).toMatch(/\(type \d+, id [^,]+, version [\d.]+\)/);
    const s = (await call("codesys_status")).text;
    log.push(`status: ${s}`);
    // Scripting 4.2+ reports the project's compiler version
    if (/ScriptEngine|Compiler version/.test(s)) expect(s).toMatch(/Compiler version \d+\.\d+\.\d+\.\d+/);
    expect((await call("get_project_tree")).isError).toBe(false);
  }, LONG);

  it("searches, lists libraries and tasks", async () => {
    expect((await call("search_code", { pattern: "itf.Reset" })).text).toContain("PLC_PRG [impl]");
    expect((await call("list_libraries")).isError).toBe(false);
    expect((await call("list_tasks")).text).toMatch(/calls .*PLC_PRG/);
  }, LONG);

  it("outlines the project and lists I/O", async () => {
    await call("create_object", { kind: "gvl", name: "GVL_IO", declaration: "VAR_GLOBAL\n    xStart AT %IX0.0 : BOOL; // start button\n    xRun AT %Q* : BOOL; // pump contactor\nEND_VAR" });
    const o = await call("get_outline");
    expect(o.isError, o.text).toBe(false);
    expect(o.text).toMatch(/Tasks: MainTask .*-> PLC_PRG/);
    expect(o.text).toMatch(/FB_PI {2}FUNCTION_BLOCK IMPLEMENTS I_Resettable/);
    expect(o.text).toMatch(/methods: Reset\(\) : BOOL/);
    expect(o.text).toMatch(/F_Clamp {2}FUNCTION : REAL/);
    const d = await call("get_outline", { path: "GVL_Par" });
    expect(d.text).toMatch(/sTag : STRING := 'Nivå åäö'/);
    const io = await call("get_io_list");
    expect(io.text).toMatch(/%IX0\.0 +GVL_IO\.xStart : BOOL \/\/ start button/);
    expect(io.text).toMatch(/%Q\* +GVL_IO\.xRun : BOOL/);
    expect(io.text).toMatch(/1 placeholder/);
  }, LONG);

  it("tracks changes against checkpoints and reverts them", async () => {
    const all = await call("get_changes");
    expect(all.text).toMatch(/change\(s\) since 'session-start'/);
    expect(all.text).toMatch(/A FB_PI \[pou\]/);
    expect((await call("checkpoint", { name: "before-edit" })).text).toMatch(/Checkpoint 'before-edit' saved/);
    await call("write_object", { path: "F_Clamp", implementation: "F_Clamp := LIMIT(0.0, x, 50.0);" });
    await call("delete_object", { path: "FB_PI/Reset" });
    const ch = await call("get_changes", { since: "before-edit" });
    expect(ch.text).toMatch(/M F_Clamp \[pou\] \(implementation \+1 -1\)/);
    expect(ch.text).toMatch(/D FB_PI\/Reset \[method\]/);
    const diff = await call("get_changes", { since: "before-edit", path: "F_Clamp" });
    expect(diff.text).toMatch(/- +\| F_Clamp := LIMIT\(0\.0, x, 100\.0\);\n\+ +1 \| F_Clamp := LIMIT\(0\.0, x, 50\.0\);/);
    expect((await call("revert_object", { path: "F_Clamp", to: "before-edit" })).text).toMatch(/restored F_Clamp/);
    expect((await call("revert_object", { path: "FB_PI", to: "before-edit" })).text).toMatch(/recreated FB_PI\/Reset/);
    expect((await call("get_changes", { since: "before-edit" })).text).toMatch(/No changes since 'before-edit'/);
    expect((await call("compile")).text).toMatch(/Build: 0 error\(s\)/);
  }, LONG);

  it("lists a compiled library, and one the project doesn't reference", async () => {
    const libs = await call("list_libraries");
    log.push(`libraries: ${libs.text}`);
    const compiled = await call("get_library_api", { name: "Standard" });
    log.push(`get_library_api Standard: ${compiled.text.slice(0, 600)}`);
    expect(compiled.isError, compiled.text).toBe(false);
    expect(compiled.text).toMatch(/\d+ objects, from CODESYS's library browser/);
    expect(compiled.text).toMatch(/^- TON\b/m);
    expect((await call("list_libraries")).text).not.toMatch(/^Util,/m);
    const other = await call("get_library_api", { name: "Util", symbol: "blink" });
    log.push(`get_library_api Util: ${other.text.slice(0, 600)}`);
    expect(other.isError, other.text).toBe(false);
    expect(other.text).toMatch(/^- BLINK\b/m);
    expect((await call("get_library_api", { name: "NoSuchLibrary" })).text).toMatch(/No installed library 'NoSuchLibrary'/);
  }, LONG);

  it("saves and reports status", async () => {
    expect((await call("save_project")).isError).toBe(false);
    const status = (await call("codesys_status")).text;
    expect(status).toMatch(/Bridge: ready \/ healthy/);
    expect(status).toMatch(/, Scripting \d+\.\d+/);
  }, LONG);

  it("adds and removes a library", async () => {
    const add = await call("add_library", { name: "util" }); // a bare title, in any case
    log.push(`add_library: ${add.text}`);
    expect(add.isError, add.text).toBe(false);
    expect(add.text).toMatch(/^Added library Util, \* \(System\)/);
    expect((await call("list_libraries")).text).toMatch(/Util, \* \(System\)/);
    expect((await call("add_library", { name: "NoSuchLibrary" })).text).toMatch(/No library titled 'NoSuchLibrary'/);
    const rm = await call("remove_library", { name: "Util" });
    log.push(`remove_library: ${rm.text}`);
    expect(rm.isError, rm.text).toBe(false);
    expect((await call("list_libraries")).text).not.toMatch(/^Util,/m);
  }, LONG);

  it("writes a project archive and opens it again", async () => {
    const archive = join(dir, "Snapshot.projectarchive");
    const saved = await call("save_project", { archive });
    log.push(`save archive: ${saved.text}`);
    expect(saved.text).toContain(`Archive written: ${archive}.`);
    const opened = await call("open_project", { path: archive, extractTo: join(dir, "FromArchive.project") });
    log.push(`open archive: ${opened.text}`);
    expect(opened.isError, opened.text).toBe(false);
    expect(opened.text).toContain("(extracted from");
    expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toContain("fbPI(rPV := 0.5, rSP := 1.0);");
    const again = await call("open_project", { path: archive, extractTo: join(dir, "FromArchive.project") });
    expect(again.text).toContain("already exists");
  }, LONG);
});
