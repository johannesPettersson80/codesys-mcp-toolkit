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
      ["create_object", { kind: "gvl", name: "GVL_Par", declaration: "VAR_GLOBAL\n    eMode : E_Mode := E_Mode.AUTO;\n    sTag : STRING := 'Nivå åäö';\nEND_VAR" }],
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

  it("searches, lists libraries and tasks", async () => {
    expect((await call("search_code", { pattern: "itf.Reset" })).text).toContain("PLC_PRG [impl]");
    expect((await call("list_libraries")).isError).toBe(false);
    expect((await call("list_tasks")).text).toMatch(/calls .*PLC_PRG/);
  }, LONG);

  it("saves and reports status", async () => {
    expect((await call("save_project")).isError).toBe(false);
    expect((await call("codesys_status")).text).toMatch(/Bridge: ready \/ healthy/);
  }, LONG);
});
