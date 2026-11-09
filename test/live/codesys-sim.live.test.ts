/**
 * CODESYS's own simulation on a real CODESYS, through the MCP tools. No controller
 * is involved. Run with:
 *   CODESYS_LIVE=1 npx vitest run test/live/codesys-sim.live.test.ts
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
import { tempDir, viaCodesys, WATCHER } from "../helpers.js";

const LONG = 300_000;
const dir = tempDir("cmcp-codesyssim-");
const log: string[] = [];
let client: Client;
let ctx: AppContext;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool(viaCodesys(name, args))) as { content: { text: string }[]; isError?: boolean };
  const text = r.content.map((c) => c.text).join("\n");
  log.push(`> ${name} ${JSON.stringify(args)}\n${text}`);
  return { text, isError: !!r.isError };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.text;
}

const P = "PLC_PRG.";
const value = async (name: string) => (await ok("codesys_sim_read", { names: [P + name] })).split(" = ")[1];
const count = async () => Number((await value("nCount"))!.split("#")[1]);
/** Several values from one read, so they belong to the same moment. */
const snapshot = async (...names: string[]) =>
  Object.fromEntries((await ok("codesys_sim_read", { names: names.map((n) => P + n) })).split("\n").map((line) => {
    const [name, v] = line.split(" = ");
    return [name!.slice(P.length), v];
  }));

const DECL = `PROGRAM PLC_PRG
VAR
    nCount : DINT;
    xInput : BOOL;
    xOutput : BOOL;
    xSeenBefore : BOOL;
    xSeenAfter : BOOL;
    nSetpoint : INT;
    rValue : REAL;
    fbTimer : TON;
    xTimerDone : BOOL;
END_VAR
`;
const IMPL = `nCount := nCount + 1;
xSeenBefore := xOutput;
xOutput := xInput;
xSeenAfter := xOutput;
fbTimer(IN := xInput, PT := T#2S);
xTimerDone := fbTimer.Q;
`;

describe("live CODESYS: its own simulation", () => {
  beforeAll(async () => {
    const cs = resolveCodesys(process.env.CODESYS_PATH, process.env.CODESYS_PROFILE);
    const bridge = new CodesysBridge({ command: cs.exe, profile: cs.profile, additionalFolder: cs.install.additionalFolder, watcherSource: WATCHER, sessionRoot: join(dir, "sessions"), log: (m) => log.push(m) });
    ctx = { bridge, autosave: true, workspace: dir, templatesDir: cs.install.templatesDir, codesys: { exe: cs.exe, profile: cs.profile, label: cs.install.label }, startWaitMs: LONG };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "codesys-sim-live", version: "1" });
    await client.connect(b);
    await bridge.start();
    await ok("create_project", { path: "CodesysSim.project" });
    await ok("write_object", { path: "PLC_PRG", declaration: DECL, implementation: IMPL });
  }, LONG);

  afterAll(async () => {
    await client?.close();
    await ctx?.bridge.stop();
    process.stderr.write(`\n---- codesys-sim live log (${dir}) ----\n${log.join("\n")}\n`);
  }, 60_000);

  it("loads the application, stopped", async () => {
    expect(await ok("codesys_sim_start")).toMatch(/application stop\./);
    expect(await value("nCount")).toBe("DINT#0");
  }, LONG);

  it("locks the project while it runs", async () => {
    const r = await call("write_object", { path: "PLC_PRG", implementation: "nCount := 0;" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/simulation_running/);
  }, LONG);

  it("runs in real time", async () => {
    await ok("codesys_sim_control", { action: "run" });
    const first = await count();
    await sleep(1_500);
    const moved = (await count()) - first;
    log.push(`cycles in about 1.5 s: ${moved}`);
    expect(moved).toBeGreaterThan(5);
  }, LONG);

  it("writes once, and a TON follows real time", async () => {
    await ok("codesys_sim_write", { values: { [`${P}xInput`]: "TRUE" } });
    await sleep(150);
    expect(await snapshot("xOutput", "xTimerDone")).toEqual({ xOutput: "TRUE", xTimerDone: "FALSE" });
    await sleep(2_200);
    expect(await value("xTimerDone")).toBe("TRUE");
    await ok("codesys_sim_write", { values: { [`${P}xInput`]: "FALSE" } });
    await sleep(200);
    expect(await value("xOutput")).toBe("FALSE");
  }, LONG);

  it("writes typed values", async () => {
    await ok("codesys_sim_write", { values: { [`${P}nSetpoint`]: "INT#42", [`${P}rValue`]: "REAL#1.5" } });
    await sleep(150);
    expect(await value("nSetpoint")).toBe("INT#42");
    expect(await value("rValue")).toMatch(/^REAL#1\.5/);
    const plain = await call("codesys_sim_write", { values: { [`${P}nSetpoint`]: "43" } });
    await sleep(150);
    log.push(`untyped write: ${plain.isError} ${plain.text}; value now ${await value("nSetpoint")}`);
  }, LONG);

  it("a write doesn't hold against the code, and a force holds between scans", async () => {
    await ok("codesys_sim_write", { values: { [`${P}xOutput`]: "TRUE" } });
    await sleep(200);
    expect(await value("xOutput")).toBe("FALSE");

    expect(await ok("codesys_sim_force", { values: { [`${P}xOutput`]: "TRUE", [`${P}nSetpoint`]: "INT#7" } })).toMatch(/Forced: PLC_PRG\.nSetpoint, PLC_PRG\.xOutput\./);
    await sleep(300);
    // Forced at the scan boundary: code before the assignment sees it, code after it sees the program's value.
    expect(await snapshot("xSeenBefore", "xSeenAfter")).toEqual({ xSeenBefore: "TRUE", xSeenAfter: "FALSE" });

    expect(await ok("codesys_sim_unforce", { names: [`${P}xOutput`] })).toMatch(/Forced: PLC_PRG\.nSetpoint\./);
    await sleep(300);
    expect(await value("xSeenBefore")).toBe("FALSE");
    expect(await value("nSetpoint")).toBe("INT#7");

    expect(await ok("codesys_sim_unforce")).not.toMatch(/Forced/);
  }, LONG);

  it("takes exact cycles", async () => {
    await ok("codesys_sim_control", { action: "stop" });
    const before = await count();
    await sleep(300);
    expect(await count()).toBe(before);
    await ok("codesys_sim_cycle");
    expect(await count()).toBe(before + 1);
    await ok("codesys_sim_cycle", { count: 10 });
    expect(await count()).toBe(before + 11);
  }, LONG);

  it("a TON follows the clock, not the cycle count", async () => {
    await ok("codesys_sim_write", { values: { [`${P}xInput`]: "TRUE" } });
    await sleep(200);
    await ok("codesys_sim_cycle");
    expect(await value("xTimerDone")).toBe("FALSE");
    await sleep(2_200);
    await ok("codesys_sim_cycle");
    expect(await value("xTimerDone")).toBe("TRUE"); // only two cycles, but over 2 s passed
    await ok("codesys_sim_write", { values: { [`${P}xInput`]: "FALSE" } });
    await sleep(200);
    await ok("codesys_sim_cycle");
  }, LONG);

  it("runs a whole simulation step as one batch", async () => {
    const write = (v: string) => ({ action: "codesys_sim_write", args: { values: { [`${P}xInput`]: v } } });
    const wait = (ms: number) => ({ action: "wait", args: { ms } });
    const cycle = { action: "codesys_sim_cycle" };
    const r = await ok("batch", {
      calls: [write("TRUE"), wait(200), cycle, wait(2_200), cycle, { action: "codesys_sim_read", args: { names: [`${P}xTimerDone`] } }, write("FALSE"), wait(200), cycle],
    });
    expect(r).toMatch(/\[6\/9\] codesys_sim_read:\nPLC_PRG\.xTimerDone = TRUE/);
  }, LONG);

  it("reports a bad name and keeps the good ones", async () => {
    const r = await ok("codesys_sim_read", { names: [`${P}nCount`, `${P}nope`] });
    log.push(`bad name: ${r}`);
    expect(r).toMatch(/PLC_PRG\.nCount = DINT#\d+/);
    expect(r).toMatch(/PLC_PRG\.nope: \S/);
    expect((await call("codesys_sim_write", { values: { [`${P}nope`]: "TRUE" } })).isError).toBe(true);
  }, LONG);

  it("a reset clears the program and releases forced values", async () => {
    for (const action of ["reset_warm", "reset_cold"]) {
      await ok("codesys_sim_force", { values: { [`${P}nSetpoint`]: "INT#9" } });
      await ok("codesys_sim_cycle");
      expect(await value("nSetpoint"), action).toBe("INT#9");
      expect(await ok("codesys_sim_control", { action }), action).not.toMatch(/Forced/);
      await sleep(300);
      expect(await count(), action).toBe(0);
      await ok("codesys_sim_cycle");
      expect(await value("nSetpoint"), action).toBe("INT#0");
    }
  }, LONG);

  it("stops, unlocks the project and leaves it unchanged", async () => {
    expect(await ok("codesys_sim_stop")).toMatch(/not running/);
    expect((await ctx.bridge.call<{ dirty: boolean }>("project.info")).dirty).toBe(false);
    expect(await ok("compile")).toMatch(/Build: 0 error\(s\)/);
    await ok("write_object", { path: "PLC_PRG", implementation: IMPL });
    expect(await ok("codesys_sim_start", { run: true })).toMatch(/application run\./);
    expect(await ok("codesys_sim_stop")).toMatch(/not running/);
  }, LONG);
});
