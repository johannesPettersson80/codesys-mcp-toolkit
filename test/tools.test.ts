import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { fakeBridge, fakeProjectFile, tempDir } from "./helpers.js";

let client: Client;
let ctx: AppContext;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}

beforeAll(async () => {
  ctx = { bridge: fakeBridge(), autosave: true, workspace: tempDir(), startWaitMs: 20_000 };
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

describe("MCP tools over the real watcher", () => {
  it("lists the v2 tool set", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_library",
        "checkpoint",
        "get_changes",
        "get_devices",
        "get_io_list",
        "get_library_api",
        "get_outline",
        "revert_object",
        "close_project",
        "codesys_sim_control",
        "codesys_sim_cycle",
        "codesys_sim_force",
        "codesys_sim_read",
        "codesys_sim_start",
        "codesys_sim_status",
        "codesys_sim_stop",
        "codesys_sim_unforce",
        "codesys_sim_write",
        "codesys_status",
        "compile",
        "configure_task",
        "create_object",
        "create_project",
        "delete_object",
        "get_project_tree",
        "list_libraries",
        "list_tasks",
        "open_project",
        "open_sim_panel",
        "read_objects",
        "remove_library",
        "rename_object",
        "save_project",
        "search_code",
        "write_object",
      ].sort(),
    );
  });

  it("opens a project", async () => {
    const r = await call("open_project", { path: fakeProjectFile() });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Opened: .*Sample\.project\. Active application: Application/);
  });

  it("shows the tree with kinds and marks non-ST objects", async () => {
    const r = await call("get_project_tree");
    expect(r.text).toContain("FB_Pump  [function_block]");
    expect(r.text).toContain("Speed  [property]");
    expect(r.text).toContain("SEQ_Fill  [program] [non-ST]");
    expect(r.text).toContain("E_Mode  [dut:enum]");
    expect(r.text).toContain("Taskkonfiguration  [task_config]");
  });

  it("reads POUs, accessors and graphical objects", async () => {
    const r = await call("read_objects", { paths: ["FB_Pump/Speed/Get", "Application/PLC_PRG", "SEQ_Fill", "Nope"] });
    expect(r.text).toContain("=== FB_Pump/Speed/Get (accessor) ===");
    expect(r.text).toContain("Speed := _rSpeed;");
    expect(r.text).toContain("=== PLC_PRG (program) ===");
    expect(r.text).toContain("not editable as ST");
    expect(r.text).toMatch(/No object 'Nope' under Application\. Children there: .*FB_Pump/);
  });

  it("rejects a declaration without its header (issue #5)", async () => {
    const r = await call("write_object", { path: "PLC_PRG", declaration: "VAR\n    bStart : BOOL;\nEND_VAR" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/must start with 'PROGRAM PLC_PRG'/);
  });

  it("writes declaration + implementation and saves", async () => {
    const r = await call("write_object", {
      path: "PLC_PRG",
      declaration: "PROGRAM PLC_PRG\nVAR\n    nCount : INT;\n    sText : STRING := 'Nivå';\nEND_VAR",
      implementation: "nCount := nCount + 1;",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Updated PLC_PRG (declaration + implementation). Project saved.");
  });

  it("refuses to write ST into a graphical body", async () => {
    const r = await call("write_object", { path: "SEQ_Fill", implementation: "x := 1;" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not_st/);
  });

  it("requires returnType for functions (PR #8)", async () => {
    const r = await call("create_object", { kind: "function", name: "F_Add" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/needs returnType/);
    const ok = await call("create_object", {
      kind: "function",
      name: "F_Add",
      returnType: "INT",
      declaration: "FUNCTION F_Add : INT\nVAR_INPUT\n    a, b : INT;\nEND_VAR",
      implementation: "F_Add := a + b;",
    });
    expect(ok.text).toBe("Created function F_Add. Project saved.");
  });

  it("creates methods, properties and interfaces without IQueryInterface", async () => {
    expect((await call("create_object", { parent: "FB_Pump", kind: "method", name: "Stop", returnType: "BOOL" })).isError).toBe(false);
    expect((await call("create_object", { parent: "FB_Pump", kind: "property", name: "Running", returnType: "BOOL" })).isError).toBe(false);
    expect((await call("create_object", { kind: "interface", name: "I_Pump" })).isError).toBe(false);
    const r = await call("read_objects", { paths: ["I_Pump", "FB_Pump/Running/Set"] });
    expect(r.text).not.toContain("IQueryInterface");
    expect(r.text).toContain("=== FB_Pump/Running/Set (accessor) ===");
  });

  it("compiles and reports errors with object and position", async () => {
    await call("write_object", { path: "F_Add", implementation: "F_Add := ERROR_HERE;" });
    const r = await call("compile");
    expect(r.text).toContain("Build: 1 error(s), 0 warning(s).");
    expect(r.text).toContain("ERROR C46 F_Add (Line 1, Column 1 (Impl)): Unknown identifier 'ERROR_HERE'");
    expect(r.text).toContain("Checked every POU, including those no task calls.");
  });

  it("compiles only what tasks reach, or deeper, when asked", async () => {
    const plain = await call("compile", { check_all: false });
    expect(plain.text).not.toContain("Checked every POU");
    const deep = await call("compile", { deep: true, clean: true });
    expect(deep.text).toContain("Code generated.");
  });

  it("searches code", async () => {
    const r = await call("search_code", { pattern: "nCount" });
    expect(r.text).toMatch(/^\d+ match\(es\)/);
    expect(r.text).toContain("PLC_PRG [impl]:1: nCount := nCount + 1;");
    expect((await call("search_code", { pattern: "zzz_none" })).text).toMatch(/No matches/);
  });

  it("lists and adds libraries", async () => {
    expect((await call("list_libraries")).text).toContain("Standard, * (System)");
    expect((await call("add_library", { name: "CAA Types, * (CAA Technology Group)" })).isError).toBe(false);
    const bad = await call("add_library", { name: "NoSuchLib" });
    expect(bad.isError).toBe(true);
    expect((await call("remove_library", { name: "CAA Types" })).text).toContain("Removed library CAA Types, * (CAA Technology Group).");
    expect((await call("list_libraries")).text).not.toContain("CAA Types");
    const missing = await call("remove_library", { name: "NoSuchLib" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("NoSuchLib is not referenced");
  });

  it("reads a graphical object as PLCopenXML", async () => {
    const r = (await call("read_objects", { paths: ["SEQ_Fill"] })).text;
    expect(r).toContain("--- graphical body as PLCopenXML (read-only) ---");
    expect(r).toContain('<pou name="SEQ_Fill" pouType="program">');
    expect(r).toContain('<step localId="0" initialStep="true" name="Init">');
    expect(r).not.toContain("addData");
    expect(r).not.toContain("<?xml");
  });

  it("lists devices and their I/O mapping", async () => {
    const d = (await call("get_devices")).text;
    expect(d).toContain("Device (type 4096, id 0000 0001, version 3.5.21.0): 2 channel(s), 1 mapped");
    expect(d).toContain("%ID0       Input@1 Level [m] -> GVL_IO.rLevel");
    expect(d).toContain("-> (not mapped)");
    expect((await call("get_io_list")).text).toContain("Mapped in the device tree (1):");
  });

  it("lists tasks", async () => {
    expect((await call("list_tasks")).text).toContain("MainTask: Cyclic, interval t#20ms, priority 1; calls PLC_PRG");
  });

  it("creates and configures tasks and their program calls", async () => {
    const r = await call("configure_task", { name: "FastTask", create: true, kind: "cyclic", interval: "t#2ms", priority: 0, watchdog: { enabled: true, time: "t#6ms", sensitivity: 2 }, add_calls: ["PLC_PRG"] });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Created task FastTask: Cyclic, interval t#2ms, priority 0, watchdog t#6ms ×2; calls PLC_PRG/);
    expect((await call("configure_task", { name: "FastTask", add_calls: ["SEQ_Fill"], remove_calls: ["PLC_PRG"] })).text).toContain("calls SEQ_Fill");
    const fb = await call("configure_task", { name: "FastTask", add_calls: ["FB_Pump"] });
    expect(fb.isError).toBe(true);
    expect(fb.text).toContain("FB_Pump is not a PROGRAM");
    const missing = await call("configure_task", { name: "NoSuchTask", interval: "t#5ms" });
    expect(missing.text).toContain("No task NoSuchTask (tasks: MainTask, FastTask). Pass create to make it.");
    const tasks = (await call("list_tasks")).text;
    expect(tasks).toContain("MainTask: Cyclic, interval t#20ms, priority 1; calls PLC_PRG");
    expect(tasks).toContain("FastTask: Cyclic, interval t#2ms, priority 0, watchdog t#6ms ×2; calls SEQ_Fill");
  });

  it("renames and deletes objects", async () => {
    expect((await call("rename_object", { path: "F_Add", newName: "F_Sum" })).text).toBe("Renamed to F_Sum. Project saved.");
    expect((await call("delete_object", { path: "F_Sum" })).text).toBe("Deleted F_Sum. Project saved.");
  });

  it("reports status without touching CODESYS", async () => {
    const r = await call("codesys_status");
    expect(r.text).toMatch(/Bridge: ready \/ healthy/);
    expect(r.text).toMatch(/Project \(last opened\): .*Sample\.project/);
  });

  it("persists saved changes across close + reopen", async () => {
    const path = ctx.project!.path;
    expect((await call("close_project")).text).toBe("Project closed.");
    expect((await call("read_objects", { paths: ["PLC_PRG"] })).text).toMatch(/no_project/);
    expect((await call("open_project", { path })).isError).toBe(false);
    const r = await call("read_objects", { paths: ["PLC_PRG", "FB_Pump/Running"] });
    expect(r.text).toContain("sText : STRING := 'Nivå';");
    expect(r.text).toContain("=== FB_Pump/Running (property) ===");
  });
});
