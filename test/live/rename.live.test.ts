/**
 * rename_symbol on a real CODESYS (issue #16): a POU in a folder (with a method), two FBs
 * with a local variable of the same name, and a GVL variable mapped to a Modbus channel in the
 * device tree. Every rename is followed by a build that must pass.
 * Run with:
 *   CODESYS_LIVE=1 npx vitest run test/live/rename.live.test.ts
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
import { tempDir, viaCodesys, WATCHER } from "../helpers.js";

const LONG = 900_000;
const dir = tempDir("cmcp-rename-live-");
const log: string[] = [];
let client: Client;
let ctx: AppContext;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool(viaCodesys(name, args), undefined, { timeout: LONG })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  log.push(`> ${name} ${JSON.stringify(args).slice(0, 300)}\n${text.slice(0, 3000)}`);
  return { text, isError: !!r.isError };
}
async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.text;
}
const builds = async () => expect(await ok("compile")).toMatch(/Build: 0 error\(s\)/);
const text = async (path: string) => ok("read_objects", { paths: [path] });

describe("live CODESYS: rename_symbol in folders, with shared names and I/O mapping", () => {
  beforeAll(async () => {
    const cs = resolveCodesys(process.env.CODESYS_PATH, process.env.CODESYS_PROFILE);
    const bridge = new CodesysBridge({ command: cs.exe, profile: cs.profile, additionalFolder: cs.install.additionalFolder, watcherSource: WATCHER, sessionRoot: join(dir, "sessions"), log: (m) => log.push(m) });
    ctx = { bridge, autosave: true, workspace: dir, templatesDir: cs.install.templatesDir, codesys: { exe: cs.exe, profile: cs.profile, label: cs.install.label }, startWaitMs: LONG };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "rename-live", version: "1" });
    await client.connect(b);
    await bridge.start();
    await ok("create_project", { path: "Rename.project" });
    await ok("create_object", { kind: "folder", name: "Folder1" });
    await ok("create_object", {
      kind: "function_block",
      name: "FB_A",
      parent: "Folder1",
      declaration: "FUNCTION_BLOCK FB_A\nVAR_INPUT\n    iCurrentState : INT;\nEND_VAR\nVAR\n    iFoo : DWORD;\nEND_VAR",
      implementation: "iFoo := iFoo + 1;\niCurrentState := iCurrentState + 1;",
    });
    await ok("create_object", { kind: "method", name: "Bump", parent: "Folder1/FB_A", declaration: "METHOD Bump : DWORD\nVAR_INPUT\nEND_VAR", implementation: "iFoo := iFoo + 10;\nBump := iFoo;" });
    await ok("create_object", {
      kind: "function_block",
      name: "FB_B",
      declaration: "FUNCTION_BLOCK FB_B\nVAR\n    iCurrentState : INT;\n    fbInner : FB_A;\nEND_VAR",
      implementation: "iCurrentState := iCurrentState + 2;\nfbInner(iCurrentState := iCurrentState);",
    });
    await ok("create_object", { kind: "gvl", name: "GVL_IO", declaration: "VAR_GLOBAL\n    wReg0 : WORD;\n    wReg1 : WORD;\nEND_VAR" });
    await ok("write_object", {
      path: "PLC_PRG",
      declaration: "PROGRAM PLC_PRG\nVAR\n    fbA : FB_A;\n    fbB : FB_B;\n    i : INT;\n    d : DWORD;\nEND_VAR",
      implementation: "fbA(iCurrentState := 1);\nfbB();\ni := fbA.iCurrentState + fbB.iCurrentState;\nd := fbA.Bump();\nGVL_IO.wReg1 := GVL_IO.wReg0 + 1;",
    });
    // A Modbus TCP server with its first input register mapped to GVL_IO.wReg0.
    const found = await ok("find_device", { text: "ModbusTCP Server Device" });
    const m = /type=(\d+) id='([^']+)' version='([^']+)'/.exec(found);
    expect(m, found).not.toBeNull();
    await call("add_device", { parent: "/PLCWinNT", name: "Ethernet", type: 110, id: "0000 0002", version: (/Ethernet.*version='([^']+)'/.exec(await ok("find_device", { text: "Ethernet" })) ?? [])[1] ?? "4.2.0.0" });
    const eth = /^\s*(\S*Ethernet\S*)/m.exec(await ok("get_devices", { io: false }))?.[1];
    expect(eth).toBeTruthy();
    await ok("add_device", { parent: `/PLCWinNT/${eth}`, name: "MB_Server", type: Number(m![1]), id: m![2], version: m![3] });
    const params = await ok("device_parameters", { device: `/PLCWinNT/${eth}/MB_Server`, channels: true, depth: 1 });
    const key = /^\s+(c\d+\/\d+\/\S+)\s+\S+ Registers\[0\]/m.exec(params)?.[1];
    expect(key, params).toBeTruthy();
    await ok("configure_device", { device: `/PLCWinNT/${eth}/MB_Server`, mappings: [{ channel: key, variable: "Application.GVL_IO.wReg0" }] });
    await ok("configure_task", { name: "MainTask", add_calls: [] });
    await builds();
  }, LONG);

  afterAll(async () => {
    await client?.close();
    await ctx?.bridge.stop();
    process.stderr.write(`\n---- rename live log (${dir}) ----\n${log.join("\n")}\n`);
  }, 120_000);

  it("renames a variable of an FB in a folder, its method included, by the bare name", async () => {
    const r = await ok("rename_symbol", { kind: "variable", owner: "FB_A", name: "iFoo", newName: "dwFoo" });
    expect(r).toMatch(/Renamed Folder1\/FB_A\.iFoo to dwFoo: \d+ occurrence/);
    expect(r).not.toMatch(/Not changed/);
    expect(await text("Folder1/FB_A")).toMatch(/dwFoo : DWORD;[\s\S]*dwFoo := dwFoo \+ 1;/);
    expect(await text("Folder1/FB_A/Bump")).toMatch(/dwFoo := dwFoo \+ 10;\s*Bump := dwFoo;/);
    await builds();
  }, LONG);

  it("renames only FB_A's iCurrentState when FB_B declares one too", async () => {
    const r = await ok("rename_symbol", { kind: "variable", owner: "FB_A", name: "iCurrentState", newName: "iState" });
    expect(r).toMatch(/Renamed Folder1\/FB_A\.iCurrentState to iState/);
    expect(await text("Folder1/FB_A")).toMatch(/iState : INT;[\s\S]*iState := iState \+ 1;/);
    const fbB = await text("FB_B");
    expect(fbB).toMatch(/iCurrentState : INT;/);
    expect(fbB).toMatch(/iCurrentState := iCurrentState \+ 2;\s*fbInner\(iState := iCurrentState\);/);
    expect(await text("PLC_PRG")).toMatch(/fbA\(iState := 1\);[\s\S]*i := fbA\.iState \+ fbB\.iCurrentState;/);
    await builds();
  }, LONG);

  it("remaps the Modbus channel when the mapped GVL variable is renamed, and the build passes", async () => {
    await ok("find_references", { name: "wReg0" }); // in the log: how CODESYS reports a GVL variable and its I/O use
    const r = await ok("rename_symbol", { kind: "variable", owner: "GVL_IO", name: "wReg0", newName: "wRegister0" });
    expect(r).toMatch(/Remapped 1 I\/O channel\(s\) on 1 device\(s\): \S+ Application\.GVL_IO\.wReg0 -> Application\.GVL_IO\.wRegister0/);
    expect(await ok("get_devices")).toMatch(/GVL_IO\.wRegister0/);
    await builds();
  }, LONG);

  it("renames the FB in the folder itself", async () => {
    const r = await ok("rename_symbol", { kind: "pou", owner: "FB_A", newName: "FB_Alpha" });
    expect(r).toMatch(/Renamed Folder1\/FB_A to FB_Alpha/);
    expect(await ok("get_project_tree")).toMatch(/Folder1 +\[folder\]\s+FB_Alpha +\[function_block\]/);
    expect(await text("PLC_PRG")).toMatch(/fbA : FB_Alpha;/);
    expect(await text("FB_B")).toMatch(/fbInner : FB_Alpha;/);
    await builds();
  }, LONG);

  it("is an error, not a 'Renamed' line, when there is nothing to rename", async () => {
    const r = await call("rename_symbol", { kind: "variable", owner: "FB_Nope", name: "iFoo", newName: "x" });
    expect(r.isError).toBe(true);
    const s = await call("rename_symbol", { kind: "variable", owner: "FB_B", name: "iNope", newName: "x" });
    expect(s.isError).toBe(true);
  }, LONG);
});
