/** Simulation panel (MCP App): registration, UI gating, supersession, panel data. No truST needed. */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "../src/server.js";
import { SimController } from "../src/sim/controller.js";
import { PANEL_URI } from "../src/sim/panel.js";
import type { PanelState, SourceView } from "../src/sim/panel-types.js";
import { Recorder } from "../src/sim/recorder.js";
import type { AppContext } from "../src/tools.js";
import { LINES, TANK_PLANT, tankNodes, tankTasks, tankTestNodes } from "./fixtures/tank.js";
import { ProjectCache } from "../src/codesys/cache.js";
import { ChangeStore, diffObjects, snapshot } from "../src/codesys/changes.js";
import { Driver } from "../src/driver.js";
import { tempDir } from "./helpers.js";

const UI = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };

async function connect(withUi: boolean, project?: string, driver: Driver | null = new Driver()) {
  const root = tempDir("cmcp-panel-");
  const proj = project ?? join(root, "Tank.project");
  writeFileSync(join(root, "Tank.plant.toml"), TANK_PLANT);
  const sim = new SimController({ exportSt: async () => tankNodes(), tasks: async () => tankTasks(), projectPath: () => (project === "" ? undefined : proj) }, { mirrorRoot: join(root, "m"), git: false });
  const cache = new ProjectCache();
  const changes = new ChangeStore(join(root, "cp"));
  const ctx = { bridge: {} as AppContext["bridge"], autosave: false, workspace: root, startWaitMs: 0, sim, cache, changes, driver: driver ?? undefined, ...(project === "" ? {} : { project: { path: proj } }) } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" }, withUi ? { capabilities: UI as never } : undefined);
  await client.connect(b);
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { structuredContent?: T; content: { text: string }[]; isError?: boolean };
    return r;
  };
  return { client, sim, call, cache, changes, driver, project: proj };
}

describe("panel registration", () => {
  it("links open_sim_panel to the UI resource and hides app-only tools from the model", async () => {
    const { client } = await connect(true);
    const tools = (await client.listTools()).tools;
    const open = tools.find((t) => t.name === "open_sim_panel")!;
    expect((open._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(PANEL_URI);
    for (const n of ["get_sim_state", "get_events", "get_source", "get_trend", "get_workspace", "get_object", "get_locals", "get_values"]) {
      const t = tools.find((x) => x.name === n);
      expect(t, n).toBeDefined();
      expect((t!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }
  });

  it("drops the app-only tools for clients without MCP Apps support", async () => {
    const { client } = await connect(false);
    await new Promise((r) => setTimeout(r, 20));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("open_sim_panel");
    expect(names).not.toContain("get_sim_state");
    expect(names).not.toContain("get_trend");
  });

  it("serves the panel as a single HTML resource", async () => {
    const { client } = await connect(true);
    const r = await client.readResource({ uri: PANEL_URI });
    const c = r.contents[0] as { mimeType: string; text: string };
    expect(c.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(c.text).toMatch(/^<!doctype html>/i);
    expect((await client.listResources()).resources.map((x) => x.uri)).toContain(PANEL_URI);
  });
});

describe("panel data", () => {
  it("tells older panels to stop polling", async () => {
    const { call } = await connect(true);
    const first = (await call<{ panelId: string }>("open_sim_panel")).structuredContent!.panelId;
    const second = (await call<{ panelId: string }>("open_sim_panel")).structuredContent!.panelId;
    expect(first).not.toBe(second);
    expect((await call<PanelState>("get_sim_state", { panelId: first })).structuredContent!.current).toBe(false);
    expect((await call<PanelState>("get_sim_state", { panelId: second })).structuredContent!.current).toBe(true);
  });

  it("reports what is missing before the simulation runs", async () => {
    const none = await connect(true, "");
    expect((await none.call<PanelState>("get_sim_state")).structuredContent!.status).toBe("no_project");
    const { call, sim } = await connect(true);
    const open = await call("open_sim_panel");
    expect(open.content[0]!.text).toMatch(/Simulation: no_mirror[\s\S]*sync_mirror/);
    expect((await call<PanelState>("get_sim_state")).structuredContent!.status).toBe("no_mirror");
    await sim.sync();
    const s = (await call<PanelState>("get_sim_state")).structuredContent!;
    expect(s.status).toBe("stopped");
    expect(s.plants).toEqual([{ id: "T101", model: "gravity_tank", inputs: ["GVL_IO.lrFV101_FlowCmd"], outputs: ["GVL_IO.lrLT101_Level"], parameters: { area_m2: 1, outflow_coefficient_m2_sqrt_m_per_s: 0.03 }, initial_state: [0.2] }]);
    expect(s.signals.map((x) => `${x.name}:${x.role}:${x.address ?? ""}`)).toEqual([
      "GVL_IO.lrLT101_Level:plant_out:%IL0",
      "GVL_IO.lrFV101_FlowCmd:plant_in:%QL0",
      "GVL_IO.xXV101_Open:command:",
      "GVL_IO.xXV101_Opened:feedback:",
      "GVL_IO.xP101_Run:command:",
      "GVL_IO.xP101_Running:feedback:",
    ]);
    expect(s.warnings.join()).toMatch(/SEQ_Fill/);
    expect(s.journalSeq).toBeGreaterThan(0);
    const ev = (await call<{ events: { kind: string }[]; last: number }>("get_events", { since: 0 })).structuredContent!;
    expect(ev.events.map((e) => e.kind)).toContain("mirror_synced");
  });

  it("serves the code of the task's program with CODESYS line numbers and CODESYS text", async () => {
    const { call, sim } = await connect(true);
    await sim.sync();
    const src = (await call<{ source: SourceView }>("get_source")).structuredContent!.source;
    expect(src.title).toBe("PRG_Tank");
    const trip = src.lines.find((l) => l.obj === "PRG_Tank" && l.part === "impl" && l.line === LINES.trip)!;
    expect(trip.text).toBe("    nTrips := nTrips + 1;");
    expect(src.lines.some((l) => l.text.includes("E_TankMode.INTERLOCKED"))).toBe(true);
    expect(src.lines.some((l) => l.text.includes("E_TankMode#"))).toBe(false);
    const fb = (await call<{ source: SourceView }>("get_source", { obj: "FB_PI/Reset" })).structuredContent!.source;
    expect(fb.title).toBe("FB_PI");
    expect(fb.lines.find((l) => l.obj === "FB_PI/Reset" && l.part === "impl" && l.line === 2)!.text).toBe("rY := 0.0;");
  });
});

describe("workspace data", () => {
  it("serves the tree with badges, only when it changed", async () => {
    const { call, cache, changes, project } = await connect(true);
    expect((await call<{ tree: null }>("get_workspace")).structuredContent!.tree).toBeNull();
    const nodes = [...tankNodes(), ...tankTestNodes()];
    cache.reset(project);
    cache.setAll(structuredClone(nodes));
    await changes.sessionStart(project, async () => nodes);
    const fb = cache.get("FB_PI")!;
    cache.upsert({ ...fb, implementation: fb.implementation + "\nrY := rY;" });
    cache.remove("I_Resettable");
    cache.touch("FB_PI", "write");
    cache.setCompile({ at: new Date().toISOString(), errors: 1, warnings: 0, messages: [{ severity: "error", text: "boom", object: "FB_PI", position: "Line 1" }] });
    type Ws = { version: number; unchanged?: boolean; tree: { path: string; change?: string; errors?: number; test?: boolean; kind: string }[]; removed: string[]; changeCount: number; focus: { path: string } };
    const w = (await call<Ws>("get_workspace")).structuredContent!;
    const node = (p: string) => w.tree.find((n) => n.path === p)!;
    expect(node("FB_PI")).toMatchObject({ change: "M", errors: 1 });
    expect(node("PRG_Tank").change).toBeUndefined();
    expect(node("Tests/T_PI_Proportional").test).toBe(true);
    expect(w.removed).toEqual(["I_Resettable", "I_Resettable/Reset"]);
    expect(w.changeCount).toBe(3);
    expect(w.focus.path).toBe("FB_PI");
    expect((await call<Ws>("get_workspace", { version: w.version })).structuredContent).toEqual({ unchanged: true, version: w.version });
    cache.touch("PRG_Tank", "read");
    expect((await call<Ws>("get_workspace", { version: w.version })).structuredContent!.unchanged).toBeUndefined();
  });

  it("serves an object with its session-start text for the diff", async () => {
    const { call, cache, changes, project } = await connect(true);
    cache.reset(project);
    cache.setAll(tankNodes());
    await changes.sessionStart(project, async () => tankNodes());
    cache.upsert({ ...cache.get("FB_PI")!, implementation: "rY := 1.0;" });
    type Obj = { object: { implementation: string } | null; base: { implementation: string } | null };
    const o = (await call<Obj>("get_object", { path: "fb_pi" })).structuredContent!;
    expect(o.object!.implementation).toBe("rY := 1.0;");
    expect(o.base!.implementation).toContain("rE := rSP - rPV;");
    expect((await call<Obj>("get_object", { path: "Nope" })).structuredContent).toEqual({ object: null });
  });

  it("answers locals and values quietly when the simulation isn't running", async () => {
    const { call } = await connect(true);
    expect((await call("get_locals")).structuredContent).toEqual({ paused: false, stack: [], locals: [] });
    expect((await call("get_values", { names: ["GVL_IO.lrLT101_Level"] })).structuredContent).toEqual({ values: {} });
  });
});

describe("user actions (Phase 7)", () => {
  type Act = { ok: boolean; message: string };
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

  it("are app-only tools", async () => {
    const { client } = await connect(true);
    const tools = (await client.listTools()).tools;
    for (const n of ["ui_set_breakpoint", "ui_clear_breakpoint", "ui_continue", "ui_pause", "ui_step", "ui_run_for", "ui_force_var", "ui_unforce_var", "ui_write_var", "ui_set_plant_params", "ui_hold", "ui_accept_object", "ui_revert_object"]) {
      const t = tools.find((x) => x.name === n);
      expect(t, n).toBeDefined();
      expect((t!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }
    const plain = (await (await connect(false)).client.listTools()).tools.map((t) => t.name);
    expect(plain.some((n) => n.startsWith("ui_"))).toBe(false);
  });

  it("Pause Claude holds the tools that change things, not the reading ones", async () => {
    const { call, driver } = await connect(true);
    const on = (await call<Act>("ui_hold", { on: true })).structuredContent!;
    expect(on).toEqual({ ok: true, message: "paused Claude and took over the simulation" });
    expect(driver!.held).toBe(true);
    const s = (await call<PanelState>("get_sim_state")).structuredContent!;
    expect(s.held).toBe(true);
    expect(s.heldSince).toBe(driver!.since);
    for (const [tool, args] of [["run_scans", { n: 1 }], ["write_var", { name: "GVL_Par.rLevelSP", value: "1" }], ["write_object", { path: "FB_PI", implementation: "x" }], ["create_project", { path: "C:/x.project" }]] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(text(r), tool).toMatch(new RegExp(`^paused_by_user: .*so ${tool} is held`));
    }
    expect(text(await call("sim_status"))).not.toMatch(/paused_by_user/);
    const ev = (await call<{ events: { kind: string; text: string; data?: { by?: string } }[] }>("get_events", { since: 0 })).structuredContent!.events;
    expect(ev.at(-1)).toMatchObject({ kind: "user", text: "User: paused Claude and took over the simulation", data: { by: "user" } });
    expect((await call<Act>("ui_hold", { on: false })).structuredContent!.message).toBe("resumed Claude");
    expect(text(await call("run_scans", { n: 1 }))).not.toMatch(/paused_by_user/);
  });

  it("report failures as ok:false instead of tool errors", async () => {
    const { call } = await connect(true);
    const r = await call<Act>("ui_step", { kind: "step_over" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.ok).toBe(false);
    const none = await connect(true, undefined, null);
    expect((await none.call<Act>("ui_hold", { on: true })).structuredContent).toEqual({ ok: false, message: "Pause Claude is not available." });
    expect((await none.call<Act>("ui_accept_object", { path: "FB_PI" })).structuredContent!.ok).toBe(false);
  });

  it("Accept moves the review baseline, not session-start", async () => {
    const { call, cache, changes, project } = await connect(true);
    cache.reset(project);
    cache.setAll(tankNodes());
    await changes.sessionStart(project, async () => tankNodes());
    cache.upsert({ ...cache.get("FB_PI/Reset")!, implementation: "rY := 1.0;" });
    type Ws = { tree: { path: string; change?: string }[]; changeCount: number };
    const change = async (p: string) => (await call<Ws>("get_workspace")).structuredContent!.tree.find((n) => n.path === p)!.change;
    expect(await change("FB_PI/Reset")).toBe("M");
    expect((await call<Act>("ui_accept_object", { path: "FB_PI" })).structuredContent).toEqual({ ok: true, message: expect.stringMatching(/^accepted the changes to FB_PI and its \d+ child objects$/) });
    expect(await change("FB_PI/Reset")).toBeUndefined();
    type Obj = { base: { implementation: string } | null };
    expect((await call<Obj>("get_object", { path: "FB_PI/Reset" })).structuredContent!.base!.implementation).toBe("rY := 1.0;");
    // session-start is untouched, so get_changes still shows Claude's whole session
    expect(diffObjects((await changes.load(project, "session-start"))!.objects, snapshot(cache.nodes!)).map((c) => c.path)).toEqual(["FB_PI/Reset"]);
  });
});

describe("trend recorder", () => {
  it("keeps samples per epoch and answers deltas", () => {
    const r = new Recorder(100);
    r.add(0, { a: 1 });
    r.add(1, { a: 2 });
    r.add(1, { b: 5 });
    r.add(0.5, { a: 9 }); // stale, ignored
    expect(r.since(0, -1).points).toEqual([{ t: 0, values: { a: 1 } }, { t: 1, values: { a: 2, b: 5 } }]);
    expect(r.since(0, 0).points.map((p) => p.t)).toEqual([1]);
    r.reset();
    r.add(0, { a: 3 });
    const s = r.since(0, 1);
    expect(s).toMatchObject({ epoch: 1, reset: true });
    expect(s.points).toEqual([{ t: 0, values: { a: 3 } }]);
  });

  it("thins old samples when full", () => {
    const r = new Recorder(100);
    for (let i = 0; i < 1000; i++) r.add(i, { a: i });
    expect(r.size).toBeLessThanOrEqual(100);
    const pts = r.since(0, -1, 1000).points;
    expect(pts.at(-1)!.t).toBe(999);
    expect(pts[0]!.t).toBe(0);
  });
});
