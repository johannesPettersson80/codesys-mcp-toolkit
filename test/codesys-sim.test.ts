/** CODESYS's own simulation, through the MCP tools, on the fake CODESYS. */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { codesysSimLabel } from "../panel/src/views.js";
import { currentCodesysSim } from "../src/codesys/simulation.js";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { fakeBridge, tempDir, viaCodesys } from "./helpers.js";

let client: Client | undefined;
let ctx: AppContext | undefined;

afterEach(async () => {
  await client?.close();
  await ctx?.bridge.stop();
  client = undefined;
  ctx = undefined;
});

async function open(content = "FAKE") {
  const workspace = tempDir();
  const file = join(workspace, "Sim.project");
  writeFileSync(file, content);
  ctx = { bridge: fakeBridge({ staleHeartbeatMs: 30_000, hungGraceMs: 10_000 }), autosave: true, workspace, startWaitMs: 20_000 };
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  await call("open_project", { path: file });
  return file;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client!.callTool(viaCodesys(name, args))) as { content: { text: string }[]; isError?: boolean };
  return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
}

const COUNT = "PLC_PRG.nCount";
const read = async (name = COUNT) => (await call("codesys_sim_read", { names: [name] })).text;

describe("CODESYS's own simulation", () => {
  it("refuses to go online unless the device is really in simulation mode", async () => {
    await open("NO-SIMULATION");
    const r = await call("codesys_sim_start");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not_simulating/);
    expect((await call("codesys_sim_status")).text).toMatch(/not running/);
  });

  it("won't take over an application that is already logged in (attach mode)", async () => {
    await open("ONLINE-CONTROLLER");
    const r = await call("codesys_sim_start");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already_online/);
    expect((await call("codesys_sim_status")).text).toMatch(/not running/);
    expect((await call("codesys_sim_write", { values: { [COUNT]: "5" } })).isError).toBe(true);
  });

  it("runs, writes, forces and takes exact cycles", async () => {
    await open();
    expect((await call("codesys_sim_start")).text).toMatch(/application stop\..*locked until codesys_sim_stop/);
    expect(await read()).toBe(`${COUNT} = INT#0`);

    expect((await call("codesys_sim_cycle", { count: 3 })).isError).toBe(false);
    expect(await read()).toBe(`${COUNT} = INT#3`);

    expect((await call("codesys_sim_control", { action: "run" })).text).toMatch(/application run\./);
    expect((await call("codesys_sim_cycle")).text).toMatch(/application stop\./); // stops first, then one cycle
    expect(await read()).toBe(`${COUNT} = INT#4`);

    await call("codesys_sim_write", { values: { "GVL_IO.rLevel": "REAL#1.5" } });
    expect(await read("GVL_IO.rLevel")).toBe("GVL_IO.rLevel = REAL#1.5");

    expect((await call("codesys_sim_force", { values: { [COUNT]: "INT#99" } })).text).toMatch(/Forced: PLC_PRG\.nCount\./);
    await call("codesys_sim_cycle", { count: 2 });
    expect(await read()).toBe(`${COUNT} = INT#99`);

    expect((await call("codesys_sim_unforce", { names: [COUNT] })).text).not.toMatch(/Forced/);
    await call("codesys_sim_force", { values: { [COUNT]: "INT#7" } });
    expect((await call("codesys_sim_unforce")).text).not.toMatch(/Forced/);
    expect(await read()).toBe(`${COUNT} = INT#4`);

    await call("codesys_sim_force", { values: { "GVL_IO.rLevel": "REAL#3" } });
    expect((await call("codesys_sim_control", { action: "reset_cold" })).text).not.toMatch(/Forced/);
    expect(await read()).toBe(`${COUNT} = INT#0`);
    expect((await call("codesys_sim_stop")).text).toMatch(/not running/);
    expect((await call("codesys_sim_read", { names: [COUNT] })).text).toMatch(/not_running/);
  }, 30_000);

  it("reports a bad name, keeps the good ones and queues nothing", async () => {
    await open();
    await call("codesys_sim_start");
    expect((await call("codesys_sim_read", { names: [COUNT, "PLC_PRG.nope"] })).text).toMatch(/PLC_PRG\.nCount = INT#0\nPLC_PRG\.nope: Unknown expression/);
    const r = await call("codesys_sim_write", { values: { "GVL_IO.rLevel": "REAL#2", "PLC_PRG.nope": "1" } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown_variable.*PLC_PRG\.nope/);
    await call("codesys_sim_write", { values: { [COUNT]: "INT#1" } });
    expect(await read("GVL_IO.rLevel")).toBe("GVL_IO.rLevel = REAL#0"); // the refused write left nothing queued
  }, 30_000);

  it("locks the project while it runs and never saves the simulation flag", async () => {
    const file = await open();
    await call("codesys_sim_start");
    for (const [tool, args] of [
      ["write_object", { path: "PLC_PRG", implementation: "x := 1;" }],
      ["compile", {}],
      ["save_project", {}],
      ["close_project", {}],
      ["delete_object", { path: "FB_Pump" }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(r.text, tool).toMatch(/simulation_running.*codesys_sim_stop/);
    }
    expect(readFileSync(file, "utf8")).toBe("FAKE"); // nothing saved while simulating

    await call("codesys_sim_stop");
    const saved = JSON.parse(readFileSync(file, "utf8")) as { roots: { simulation: boolean }[] };
    expect(saved.roots[0]!.simulation).toBe(false);
    expect((await ctx!.bridge.call<{ dirty: boolean }>("project.info")).dirty).toBe(false);
    expect((await call("write_object", { path: "PLC_PRG", implementation: "nCount := 2;" })).isError).toBe(false);
  }, 30_000);

  it("won't start with compile errors", async () => {
    await open();
    await call("write_object", { path: "PLC_PRG", implementation: "ERROR_HERE" });
    const r = await call("codesys_sim_start");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Fix the compile errors/);
    expect((await call("codesys_sim_status")).text).toMatch(/not running/);
  }, 30_000);

  it("shows in the panel only while it runs", async () => {
    await open();
    expect(currentCodesysSim(ctx!)).toBeUndefined();
    await call("codesys_sim_start");
    await call("codesys_sim_force", { values: { [COUNT]: "INT#1" } });
    expect(currentCodesysSim(ctx!)).toMatchObject({ state: "stop", forced: [COUNT] });
    expect(codesysSimLabel(currentCodesysSim(ctx!)!)).toBe("CODESYS simulation: stopped · 1 forced");
    expect(codesysSimLabel({ state: "run", forced: [] })).toBe("CODESYS simulation: running");
    await call("codesys_sim_stop");
    expect(currentCodesysSim(ctx!)).toBeUndefined();
  }, 30_000);

  it("ends for the panel when CODESYS restarts", () => {
    const stale = { codesysSim: { state: "run", forced: [], cycles: 0, restarts: 0 }, bridge: { health: () => ({ restarts: 1 }) } } as unknown as AppContext;
    expect(currentCodesysSim(stale)).toBeUndefined();
  });
});
