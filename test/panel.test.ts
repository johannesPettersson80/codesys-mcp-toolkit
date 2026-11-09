/** The panel (MCP App): registration, UI gating, supersession, workspace data and user actions. */
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "../src/server.js";
import { PANEL_URI } from "../src/panel.js";
import type { PanelState } from "../src/panel-types.js";
import type { AppContext } from "../src/tools.js";
import { tankNodes, tankTestNodes } from "./fixtures/tank.js";
import { ProjectCache } from "../src/codesys/cache.js";
import { ChangeStore, diffObjects, snapshot } from "../src/codesys/changes.js";
import { Driver } from "../src/driver.js";
import { annotatedTools } from "../src/annotations.js";
import { tempDir } from "./helpers.js";

const UI = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };

async function connect(withUi: boolean, project?: string, driver: Driver | null = new Driver()) {
  const root = tempDir("cmcp-panel-");
  const proj = project ?? join(root, "Tank.project");
  const cache = new ProjectCache();
  const changes = new ChangeStore(join(root, "cp"));
  const ctx = { bridge: { health: () => ({}) } as unknown as AppContext["bridge"], autosave: false, workspace: root, startWaitMs: 0, cache, changes, driver: driver ?? undefined, ...(project === "" ? {} : { project: { path: proj } }) } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" }, withUi ? { capabilities: UI as never } : undefined);
  await client.connect(b);
  const call = async <T>(name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { structuredContent?: T; content: { text: string }[]; isError?: boolean };
    return r;
  };
  return { client, call, cache, changes, driver, project: proj, ctx };
}

describe("panel registration", () => {
  it("links open_sim_panel to the UI resource and hides app-only tools from the model", async () => {
    const { client } = await connect(true);
    const tools = (await client.listTools()).tools;
    const open = tools.find((t) => t.name === "open_sim_panel")!;
    expect((open._meta as { ui: { resourceUri: string } }).ui.resourceUri).toBe(PANEL_URI);
    for (const n of ["get_sim_state", "get_workspace", "get_object"]) {
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
    expect(names).not.toContain("get_workspace");
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

  it("answers open_sim_panel with a text snapshot too", async () => {
    const none = await connect(true, "");
    expect((await none.call("open_sim_panel")).content[0]!.text).toBe("Panel opened. No project is open yet.");
    const { call, project } = await connect(true);
    const open = await call("open_sim_panel");
    expect(open.content[0]!.text).toBe(`Panel opened. Project: ${project}.`);
    // hosts that show only structuredContent still get the snapshot
    expect(open.structuredContent).toMatchObject({ snapshot: open.content[0]!.text });
  });

  it("reports a running CODESYS simulation", async () => {
    const { call, ctx } = await connect(true);
    expect((await call<PanelState>("get_sim_state")).structuredContent!.codesysSim).toBeUndefined();
    ctx.codesysSim = { state: "run", forced: ["PLC_PRG.x"], cycles: 2 };
    expect((await call<PanelState>("get_sim_state")).structuredContent!.codesysSim).toMatchObject({ state: "run", forced: ["PLC_PRG.x"] });
    expect((await call("open_sim_panel")).content[0]!.text).toMatch(/CODESYS simulation: application run\./);
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
    type Ws = { version: number; unchanged?: boolean; tree: { path: string; change?: string; errors?: number; kind: string }[]; removed: string[]; changeCount: number; focus: { path: string } };
    const w = (await call<Ws>("get_workspace")).structuredContent!;
    const node = (p: string) => w.tree.find((n) => n.path === p)!;
    expect(node("FB_PI")).toMatchObject({ change: "M", errors: 1 });
    expect(node("PRG_Tank").change).toBeUndefined();
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
});

describe("user actions", () => {
  type Act = { ok: boolean; message: string };
  const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

  it("are app-only tools", async () => {
    const { client } = await connect(true);
    const tools = (await client.listTools()).tools;
    for (const n of ["ui_hold", "ui_accept_object", "ui_revert_object"]) {
      const t = tools.find((x) => x.name === n);
      expect(t, n).toBeDefined();
      expect((t!._meta as { ui: { visibility: string[] } }).ui.visibility).toEqual(["app"]);
    }
    const plain = (await (await connect(false)).client.listTools()).tools.map((t) => t.name);
    expect(plain.some((n) => n.startsWith("ui_"))).toBe(false);
  });

  it("Pause Claude holds the tools that change things, not the reading ones", async () => {
    const { call, driver } = await connect(true);
    expect((await call<Act>("ui_hold", { on: true })).structuredContent!).toEqual({ ok: true, message: "paused Claude" });
    expect(driver!.held).toBe(true);
    const s = (await call<PanelState>("get_sim_state")).structuredContent!;
    expect(s.held).toBe(true);
    expect(s.heldSince).toBe(driver!.since);
    for (const [tool, args] of [["codesys_sim_force", { values: { "PLC_PRG.x": "TRUE" } }], ["write_object", { path: "FB_PI", implementation: "x" }], ["create_project", { path: "C:/x.project" }]] as const) {
      const r = await call(tool, args);
      expect(r.isError, tool).toBe(true);
      expect(text(r), tool).toMatch(new RegExp(`^paused_by_user: .*so ${tool} is held`));
    }
    expect(text(await call("codesys_status"))).not.toMatch(/paused_by_user/);
    expect((await call<Act>("ui_hold", { on: false })).structuredContent!.message).toBe("resumed Claude");
    expect(text(await call("write_object", { path: "FB_PI", implementation: "x" }))).not.toMatch(/paused_by_user/);
  });

  it("report failures as ok:false instead of tool errors", async () => {
    const { call } = await connect(true);
    const r = await call<Act>("ui_accept_object", { path: "FB_PI" });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ ok: false, message: "No project is open." });
    const none = await connect(true, undefined, null);
    expect((await none.call<Act>("ui_hold", { on: true })).structuredContent).toEqual({ ok: false, message: "Pause Claude is not available." });
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

describe("tool annotations", () => {
  it("classify every tool, so clients can skip approvals for harmless ones", async () => {
    const { client } = await connect(false);
    await new Promise((r) => setTimeout(r, 20));
    const tools = (await client.listTools()).tools;
    const known = new Set(annotatedTools());
    for (const t of tools) {
      expect(known.has(t.name), `${t.name} needs a kind in src/annotations.ts`).toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(false);
    }
    const ann = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(ann("write_object")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(ann("codesys_sim_force")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(ann("read_objects")).toMatchObject({ readOnlyHint: true });
  });
});
