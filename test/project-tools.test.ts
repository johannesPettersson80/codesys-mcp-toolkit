/** Phase 5 project tools: declaration parser, outline, I/O list, change tracking, scenarios. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { ChangeStore, diffObjects, formatDiff, lineDiff, snapshot } from "../src/codesys/changes.js";
import { ProjectCache } from "../src/codesys/cache.js";
import { parseDeclaration, signature } from "../src/codesys/decl.js";
import { buildOutline, ioList } from "../src/codesys/outline.js";
import type { TreeNode } from "../src/codesys/st.js";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { tankNodes, tankTasks, tankTestNodes } from "./fixtures/tank.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { Driver } from "../src/driver.js";
import { fakeBridge, fakeProjectFile, tempDir, viaCodesys } from "./helpers.js";

describe("declaration parser", () => {
  it("reads headers with modifiers, EXTENDS, IMPLEMENTS and return types", () => {
    expect(parseDeclaration("FUNCTION_BLOCK FINAL FB_X EXTENDS FB_Base IMPLEMENTS I_A, I_B\nVAR_INPUT\n  a : INT;\nEND_VAR").header).toMatchObject({
      keyword: "FUNCTION_BLOCK",
      name: "FB_X",
      modifiers: ["FINAL"],
      extends: ["FB_Base"],
      implements: ["I_A", "I_B"],
    });
    expect(parseDeclaration("METHOD PROTECTED Calc : LREAL").header).toMatchObject({ keyword: "METHOD", name: "Calc", modifiers: ["PROTECTED"], returnType: "LREAL" });
    expect(parseDeclaration("FUNCTION F_Clamp : REAL").header.returnType).toBe("REAL");
    expect(parseDeclaration("{attribute 'test'}\nPROGRAM T_X").header.attributes).toEqual(["test"]);
  });

  it("reads variables: several names, AT, initial values, comments, sections and flags", () => {
    const p = parseDeclaration(`FUNCTION_BLOCK FB
VAR_INPUT
    xA, xB : BOOL; // two inputs
    rLim : REAL := 1.5; (* limit *)
END_VAR
VAR_OUTPUT
    aOut : ARRAY[1..3] OF INT := [1, 2, 3];
END_VAR
VAR CONSTANT
    cMax : INT := 10;
END_VAR
VAR RETAIN
    nCount AT %MW4 : UDINT;
    sName : STRING(20) := 'a;b';
END_VAR`);
    expect(p.vars.map((v) => `${v.section}:${v.name}:${v.type}:${v.init ?? ""}:${v.at ?? ""}:${v.comment ?? ""}`)).toEqual([
      "VAR_INPUT:xA:BOOL:::two inputs",
      "VAR_INPUT:xB:BOOL:::two inputs",
      "VAR_INPUT:rLim:REAL:1.5::limit",
      "VAR_OUTPUT:aOut:ARRAY[1..3] OF INT:[1, 2, 3]::",
      "VAR:cMax:INT:10::",
      "VAR:nCount:UDINT::%MW4:",
      "VAR:sName:STRING(20):'a;b'::",
    ]);
    expect(p.vars.find((v) => v.name === "cMax")!.constant).toBe(true);
    expect(p.vars.find((v) => v.name === "nCount")!.retain).toBe(true);
    expect(signature(p)).toBe("FB(xA : BOOL, xB : BOOL, rLim : REAL; out aOut : ARRAY[1..3] OF INT)");
  });

  it("reads DUTs: enums, structs, aliases", () => {
    expect(parseDeclaration("{attribute 'qualified_only'}\nTYPE E_M :\n(\n    A := 0,\n    B,\n    C := 5\n) INT;\nEND_TYPE")).toMatchObject({
      dutKind: "enum",
      enumMembers: [{ name: "A", value: "0" }, { name: "B" }, { name: "C", value: "5" }],
      baseType: "INT",
      header: { name: "E_M", attributes: ["qualified_only"] },
    });
    const s = parseDeclaration("TYPE ST_P :\nSTRUCT\n  bRun : BOOL; // running\n  aHist : ARRAY[1..10] OF REAL;\nEND_STRUCT\nEND_TYPE");
    expect(s.dutKind).toBe("struct");
    expect(s.fields!.map((f) => `${f.name}:${f.type}:${f.comment ?? ""}`)).toEqual(["bRun:BOOL:running", "aHist:ARRAY[1..10] OF REAL:"]);
    expect(parseDeclaration("TYPE T_Level : LREAL; END_TYPE")).toMatchObject({ dutKind: "alias", baseType: "LREAL" });
  });
});

describe("outline", () => {
  const nodes = [...tankNodes(), ...tankTestNodes()];

  it("summarises the project: tasks, interfaces, DUTs, GVLs, tests", () => {
    const o = buildOutline(nodes, tankTasks());
    expect(o).toMatch(/^Outline: 3 POU\(s\), 2 GVL\(s\), 1 DUT\(s\), 1 interface\(s\), 3 test\(s\)\./);
    expect(o).toContain("Tasks: MainTask (t#10ms, prio 1) -> PRG_Tank");
    expect(o).toContain("PRG_Tank  PROGRAM [MainTask t#10ms]");
    expect(o).toContain("SEQ_Fill  PROGRAM [non-ST]");
    expect(o).toContain("FB_PI  FUNCTION_BLOCK IMPLEMENTS I_Resettable\n  in: bEnable : BOOL; rPV : REAL; rSP : REAL; rCycleS : REAL := 0.01\n  out: rY : REAL\n  methods: Reset() : BOOL\n  properties: Kp : REAL; Ti : REAL");
    expect(o).toContain("I_Resettable  INTERFACE\n");
    expect(o).toContain("E_TankMode  ENUM (MANUAL=0, AUTO=1, INTERLOCKED=2)");
    expect(o).toContain("GVL_IO  GVL (6 vars, qualified_only)");
    expect(o).toContain("tests: Tests/T_PI_Proportional, Tests/T_PI_ResetViaInterface, Tests/T_Mode_DefaultsToAuto");
  });

  it("details one object, a folder, or suggests a path", () => {
    const fb = buildOutline(nodes, tankTasks(), { path: "FB_PI" });
    expect(fb).toContain("    rPV : REAL // process value");
    expect(fb).toContain("  var:\n    _rKp : REAL := 50.0");
    expect(fb).toContain("  property PUBLIC Kp : REAL (get, set)");
    expect(fb).toContain("  implementation: 7 line(s)");
    expect(buildOutline(nodes, tankTasks(), { path: "Tests" })).toMatch(/^Tests\/ {2}\(3 object\(s\)\)\nTests\/T_PI_Proportional {2}TEST/);
    expect(buildOutline(nodes, tankTasks(), { path: "T_PI_Proportional" })).toBe("No object 'T_PI_Proportional'. Did you mean: Tests/T_PI_Proportional?");
    expect(buildOutline(nodes, tankTasks(), { maxLines: 3 })).toMatch(/\.\.\. \d+ more line\(s\)\. Pass path/);
  });

  it("lists I/O variables with placeholders", () => {
    const io = ioList([{ path: "GVL_IO", name: "GVL_IO", kind: "gvl", depth: 0, declaration: "VAR_GLOBAL\n  xStart AT %IX0.0 : BOOL; // start\n  xRun AT %Q* : BOOL;\n  nW AT %MW2 : WORD;\nEND_VAR" }]);
    expect(io.map((x) => `${x.direction}:${x.at}:${x.name}:${x.placeholder}`)).toEqual(["input:%IX0.0:xStart:false", "output:%Q*:xRun:true", "memory:%MW2:nW:false"]);
  });
});

describe("change tracking", () => {
  it("diffs lines and formats hunks with new line numbers", () => {
    const ops = lineDiff("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(ops.map((o) => o.op + o.text).join(",")).toBe(" a,-b,+B, c, d,+e");
    expect(formatDiff(ops, 0)).toEqual(["-      | b", "+    2 | B", "  ...", "+    5 | e"]);
  });

  it("finds added, removed and modified objects", () => {
    const before = snapshot(tankNodes());
    const after = snapshot(
      tankNodes()
        .filter((n) => n.path !== "FB_PI/Reset")
        .map((n) => (n.path === "FB_PI" ? { ...n, implementation: n.implementation + "\nrY := rY;" } : n))
        .concat([{ path: "FB_New", name: "FB_New", kind: "pou", sub: "function_block", depth: 0, declaration: "FUNCTION_BLOCK FB_New" }]),
    );
    expect(diffObjects(before, after)).toEqual([
      { path: "FB_New", kind: "pou", change: "added" },
      { path: "FB_PI", kind: "pou", change: "modified", impl: { plus: 1, minus: 0 } },
      { path: "FB_PI/Reset", kind: "method", change: "removed" },
    ]);
  });

  it("stores checkpoints on disk and takes session-start once", async () => {
    const s = new ChangeStore(tempDir("cmcp-cp-"));
    let exports = 0;
    const exp = async () => {
      exports++;
      return tankNodes();
    };
    expect(await s.sessionStart("C:/p/Tank.project", exp)).toBe(true);
    expect(await s.sessionStart("c:/P/tank.project", exp)).toBe(false);
    expect(exports).toBe(1);
    await s.save("C:/p/Tank.project", "x", tankNodes());
    expect((await s.list("C:/p/Tank.project")).map((c) => c.name).sort()).toEqual(["review", "session-start", "x"]);
    expect((await s.load("C:/p/Tank.project", "x"))!.objects.find((o) => o.path === "FB_PI")!.implementation).toContain("rE := rSP - rPV;");
  });
});

describe("create_project", () => {
  it("brings CODESYS's own template up to this CODESYS, and nothing else", async () => {
    const templatesDir = tempDir();
    writeFileSync(join(templatesDir, "Standard.project"), "OLD-TEMPLATE"); // the fake's device 3.1.3.0
    const workspace = tempDir();
    const ctx: AppContext = { bridge: fakeBridge({ staleHeartbeatMs: 30_000, hungGraceMs: 10_000 }), autosave: true, workspace, templatesDir, startWaitMs: 20_000 };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => ((await client.callTool(viaCodesys(name, args))) as { content: { text: string }[] }).content[0]!.text;
    try {
      expect(await call("create_project", { path: "New.project" })).toMatch(/Device updated to 3\.5\.22\.40\./);
      expect((JSON.parse(readFileSync(join(workspace, "New.project"), "utf8")) as { roots: { device_version: string }[] }).roots[0]!.device_version).toBe("3.5.22.40");

      const mine = join(workspace, "MyTemplate.project");
      writeFileSync(mine, "OLD-TEMPLATE");
      expect(await call("create_project", { path: "FromMine.project", template: mine })).not.toMatch(/Device updated/);
      expect(readFileSync(join(workspace, "FromMine.project"), "utf8")).toBe("OLD-TEMPLATE");

      const existing = join(workspace, "Existing.project");
      writeFileSync(existing, "OLD-TEMPLATE");
      await call("open_project", { path: existing });
      expect(readFileSync(existing, "utf8")).toBe("OLD-TEMPLATE");
    } finally {
      await client.close();
      await ctx.bridge.stop();
    }
  }, 30_000);
});

describe("project tools over MCP (fake CODESYS)", () => {
  let client: Client;
  let ctx: AppContext;
  let firstOpen = "";
  const browserOpens: boolean[] = [];
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool(viaCodesys(name, args))) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };

  beforeAll(async () => {
    // generous heartbeat limits: other test files start processes in parallel
    const viewer = { url: "http://viewer/", open: (force = false) => (browserOpens.push(force), true) };
    ctx = { bridge: fakeBridge({ staleHeartbeatMs: 30_000, hungGraceMs: 10_000 }), autosave: true, workspace: tempDir(), startWaitMs: 20_000, changes: new ChangeStore(tempDir("cmcp-cps-")), cache: new ProjectCache(), driver: new Driver(), viewer };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    // a client with MCP Apps support, so the panel's user-action tools exist
    client = new Client({ name: "t", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } as never });
    await client.connect(b);
    firstOpen = (await call("open_project", { path: fakeProjectFile() })).text;
    expect(firstOpen).toMatch(/Checkpoint 'session-start' saved/);
  });

  afterAll(async () => {
    await client?.close();
    await ctx?.bridge.stop();
  });

  it("asks for the card and never opens the browser by itself", async () => {
    expect(browserOpens).toEqual([]);
    expect(firstOpen).toContain("Call open_sim_panel now");
    expect(firstOpen).not.toMatch(/browser/);
    expect((await call("open_workspace")).text).toContain("http://viewer/");
    expect(browserOpens).toEqual([true]);
  });

  it("doesn't open the browser by itself where the chat can't show the card either", async () => {
    const opened: boolean[] = [];
    const plainCtx: AppContext = { bridge: fakeBridge({ staleHeartbeatMs: 30_000, hungGraceMs: 10_000 }), autosave: true, workspace: tempDir(), startWaitMs: 20_000, viewer: { url: "http://viewer/", open: (force = false) => (opened.push(force), true) } };
    const server = createServer(plainCtx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const plain = new Client({ name: "t", version: "1" });
    await plain.connect(b);
    try {
      const text = ((await plain.callTool(viaCodesys("open_project", { path: fakeProjectFile() }))) as { content: { text: string }[] }).content[0]!.text;
      expect(text).not.toMatch(/open_sim_panel|browser/);
      expect(opened).toEqual([]);
    } finally {
      await plain.close();
      await plainCtx.bridge.stop();
    }
  }, 30_000);

  describe("batch", () => {
    const write = (implementation: string) => ({ action: "write_object", args: { path: "PLC_PRG", implementation } });
    const read = { action: "read_objects", args: { paths: ["PLC_PRG"] } };

    it("runs several actions in one call and returns every result", async () => {
      const r = await call("batch", { calls: [write("c := 1;"), read, { action: "wait", args: { ms: 1 } }] });
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(/^\[1\/3\] write_object:\n/);
      expect(r.text).toMatch(/\[2\/3\] read_objects:\n[\s\S]*c := 1;/);
      expect(r.text).toMatch(/\[3\/3\] wait:\nWaited 1 ms\./);
      await call("revert_object", { path: "PLC_PRG" });
    });

    it("stops at the first step that fails and says what was left", async () => {
      const before = (await call("read_objects", { paths: ["PLC_PRG"] })).text;
      const r = await call("batch", { calls: [{ action: "delete_object", args: { path: "Nope" } }, write("d := 1;"), read] });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^\[1\/3\] delete_object FAILED:\n/);
      expect(r.text).toMatch(/Stopped: the remaining 2 step\(s\) were not run\.$/);
      expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toBe(before);
    });

    it("carries on after a failure when asked, and still reports the failure", async () => {
      const r = await call("batch", { calls: [{ action: "delete_object", args: { path: "Nope" } }, read], continueOnError: true });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/\[1\/2\] delete_object FAILED/);
      expect(r.text).toMatch(/\[2\/2\] read_objects:\n/);
    });

    it("checks every step first, so a bad one leaves nothing half done", async () => {
      const before = (await call("read_objects", { paths: ["PLC_PRG"] })).text;
      const bad = await call("batch", { calls: [write("e := 1;"), { action: "write_object", args: { pth: "PLC_PRG" } }] });
      expect(bad.isError).toBe(true);
      expect(bad.text).toMatch(/^Step 2 \(write_object\) has invalid arguments, so nothing was run:/);
      expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toBe(before);
    });

    it("refuses help, a nested batch and unknown actions", async () => {
      for (const action of ["help", "batch", "nope"]) {
        const r = await call("batch", { calls: [write("f := 1;"), { action }] });
        expect(r.isError, action).toBe(true);
        expect(r.text, action).toMatch(new RegExp(`^Step 2: '${action}' can't run in a batch, so nothing was run\\.`));
      }
    });

    it("respects Pause Claude for each step", async () => {
      await client.callTool({ name: "ui_hold", arguments: { on: true } });
      const r = await call("batch", { calls: [read, write("g := 1;")] });
      await client.callTool({ name: "ui_hold", arguments: { on: false } });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/\[1\/2\] read_objects:\n/);
      expect(r.text).toMatch(/\[2\/2\] write_object FAILED:\npaused_by_user:/);
    });
  });

  it("outlines the fake project", async () => {
    const o = await call("get_outline");
    expect(o.isError, o.text).toBe(false);
    expect(o.text).toMatch(/Tasks: MainTask/);
    expect(o.text).toMatch(/FB_Pump {2}FUNCTION_BLOCK/);
    expect((await call("get_outline", { path: "Nope" })).text).toMatch(/No object 'Nope'/);
  });

  it("tracks a change, shows its diff and reverts it", async () => {
    const before = (await call("read_objects", { paths: ["PLC_PRG"] })).text;
    await call("write_object", { path: "PLC_PRG", implementation: "x := 42;" });
    const ch = await call("get_changes");
    expect(ch.text).toMatch(/M PLC_PRG \[pou\] \(implementation/);
    expect((await call("get_changes", { path: "PLC_PRG" })).text).toMatch(/\+ +1 \| x := 42;/);
    await call("create_object", { kind: "function", name: "F_New", returnType: "INT" });
    expect((await call("get_changes")).text).toMatch(/A F_New \[pou\]/);
    expect((await call("revert_object", { path: "F_New" })).text).toMatch(/deleted F_New/);
    expect((await call("revert_object", { path: "PLC_PRG" })).text).toMatch(/restored PLC_PRG/);
    expect((await call("get_changes")).text).toMatch(/No changes since 'session-start'/);
    expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toBe(before);
    expect((await call("checkpoint")).text).toMatch(/session-start/);
    expect((await call("get_changes", { since: "nope" })).text).toMatch(/No checkpoint 'nope'\. Checkpoints: session-start/);
  });

  it("restores a deleted graphical object from the checkpoint's PLCopenXML", async () => {
    expect((await call("delete_object", { path: "SEQ_Fill" })).isError).toBe(false);
    expect((await call("get_changes")).text).toMatch(/D SEQ_Fill/);
    const r = await call("revert_object", { path: "SEQ_Fill" });
    expect(r.text).toContain("recreated SEQ_Fill (graphical, from its PLCopenXML)");
    expect((await call("get_project_tree")).text).toMatch(/SEQ_Fill .*\[non-ST\]/);
    expect((await call("read_objects", { paths: ["SEQ_Fill"] })).text).toContain("<SFC>");
  });

  it("keeps the workspace cache current as a side effect of the tools", async () => {
    const cache = ctx.cache!;
    expect(cache.project).toMatch(/Sample\.project$/);
    expect(cache.get("PLC_PRG")).toBeDefined();
    let v = cache.version;
    await call("write_object", { path: "PLC_PRG", implementation: "y := 7;" });
    expect(cache.get("PLC_PRG")!.implementation).toBe("y := 7;");
    expect(cache.focus).toMatchObject({ path: "PLC_PRG", action: "write" });
    expect(cache.version).toBeGreaterThan(v);
    await call("create_object", { kind: "function_block", name: "FB_Cache" });
    expect(cache.get("FB_Cache")).toMatchObject({ kind: "pou", sub: "function_block" });
    await call("rename_object", { path: "FB_Cache", newName: "FB_Cache2" });
    expect(cache.get("FB_Cache")).toBeUndefined();
    expect(cache.get("FB_Cache2")).toBeDefined();
    await call("delete_object", { path: "FB_Cache2" });
    expect(cache.get("FB_Cache2")).toBeUndefined();
    expect(cache.focus).toMatchObject({ path: "FB_Cache2", action: "delete" });
    await call("write_object", { path: "PLC_PRG", implementation: "ERROR_HERE" });
    v = cache.version;
    await call("compile");
    expect(cache.compile).toMatchObject({ errors: 1 });
    expect(cache.compile!.messages[0]).toMatchObject({ severity: "error", object: expect.stringMatching(/PLC_PRG/) });
    expect(cache.version).toBeGreaterThan(v);
    await call("revert_object", { path: "PLC_PRG" });
    expect(cache.focus).toMatchObject({ path: "PLC_PRG", action: "revert" });
    await call("close_project");
    expect(cache.nodes).toBeUndefined();
    await call("open_project", { path: cache.project ?? fakeProjectFile() });
  });

  it("reverts to what the user accepted in the panel, not to session-start", async () => {
    const ui = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as { ok: boolean; message: string };
    await call("write_object", { path: "PLC_PRG", implementation: "a := 1;" });
    expect((await ui("ui_accept_object", { path: "PLC_PRG" })).ok).toBe(true);
    await call("write_object", { path: "PLC_PRG", implementation: "a := 2;" });
    const r = await ui("ui_revert_object", { path: "PLC_PRG" });
    expect(r, r.message).toMatchObject({ ok: true, message: expect.stringMatching(/restored PLC_PRG/) });
    expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toMatch(/a := 1;/);
    expect(ctx.cache!.get("PLC_PRG")!.implementation).toBe("a := 1;");
    // Claude's own view still compares with session-start
    expect((await call("get_changes")).text).toMatch(/M PLC_PRG/);
  });

  it("holds project edits while the user has paused Claude", async () => {
    const ui = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as { ok: boolean };
    expect((await ui("ui_hold", { on: true })).ok).toBe(true);
    const w = await call("write_object", { path: "PLC_PRG", implementation: "b := 1;" });
    expect(w.isError).toBe(true);
    expect(w.text).toMatch(/^paused_by_user:/);
    expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toMatch(/a := 1;/);
    expect((await call("get_outline")).isError).toBe(false);
    expect((await ui("ui_hold", { on: false })).ok).toBe(true);
    expect((await call("write_object", { path: "PLC_PRG", implementation: "b := 1;" })).isError).toBe(false);
  });

  it("reports library reading as unavailable where CODESYS has no library manager", async () => {
    const r = await call("get_library_api", { name: "Standard" });
    expect(r.isError).toBe(true);
  });
});
