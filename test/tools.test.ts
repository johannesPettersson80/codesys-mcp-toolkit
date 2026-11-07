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
        "get_io_list",
        "get_library_api",
        "get_outline",
        "revert_object",
        "close_project",
        "codesys_status",
        "compile",
        "create_object",
        "create_project",
        "delete_object",
        "get_project_tree",
        "list_libraries",
        "list_tasks",
        "open_project",
        "read_objects",
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
  });

  it("lists tasks", async () => {
    expect((await call("list_tasks")).text).toContain("MainTask: Cyclic, interval t#20ms, priority 1; calls PLC_PRG");
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
