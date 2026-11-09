/** Browser viewer: serves the workspace on 127.0.0.1, token-gated, panel tools only. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { ProjectCache } from "../src/codesys/cache.js";
import { ChangeStore } from "../src/codesys/changes.js";
import { Driver } from "../src/driver.js";
import type { AppContext } from "../src/tools.js";
import { startViewer, viewerMayCall, type Viewer } from "../src/viewer.js";
import { tankNodes } from "./fixtures/tank.js";
import { tempDir } from "./helpers.js";

describe("browser viewer", () => {
  let viewer: Viewer;
  const opened: string[] = [];
  const root = tempDir("cmcp-viewer-");
  const project = join(root, "Tank.project");

  beforeAll(async () => {
    const cache = new ProjectCache();
    cache.reset(project);
    cache.setAll(tankNodes());
    const ctx = { bridge: { health: () => ({ scripting: "4.2.0.0" }) } as unknown as AppContext["bridge"], codesys: { exe: "x", profile: "p", label: "CODESYS 3.5.22.40" }, autosave: false, workspace: root, startWaitMs: 0, cache, changes: new ChangeStore(join(root, "cp")), driver: new Driver(), project: { path: project, compiler_version: "3.5.19.40" } } as AppContext;
    viewer = await startViewer(ctx, { port: 0, openBrowser: (u) => opened.push(u) });
  });
  afterAll(async () => viewer?.close());

  const base = () => viewer.url.split("/?")[0]!;
  const token = () => new URL(viewer.url).searchParams.get("t")!;
  const call = (name: string, args: object = {}, t = token()) =>
    fetch(`${base()}/call`, { method: "POST", headers: { "content-type": "application/json", "x-viewer-token": t }, body: JSON.stringify({ name, arguments: args }) });

  it("serves the host page and the panel only with the token", async () => {
    const page = await fetch(viewer.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/<iframe id="panel"/);
    expect((await fetch(`${base()}/`)).status).toBe(403);
    expect((await fetch(`${base()}/panel.html?t=${token()}`)).status).toBe(200);
    expect((await fetch(`${base()}/panel.html?t=nope`)).status).toBe(403);
  });

  it("answers the panel's tools from the shared context", async () => {
    const r = await call("get_workspace");
    expect(r.status).toBe(200);
    const w = ((await r.json()) as { structuredContent: { tree: { path: string }[]; versions?: string } }).structuredContent;
    expect(w.tree.map((n) => n.path)).toContain("PRG_Tank");
    expect(w.versions).toBe("CODESYS 3.5.22.40 · Scripting 4.2.0.0 · compiler 3.5.19.40");
    const o = ((await (await call("get_object", { path: "FB_PI" })).json()) as { structuredContent: { object: { implementation: string } } }).structuredContent;
    expect(o.object.implementation).toContain("rE := rSP - rPV;");
  });

  it("refuses other tools and requests without the token", async () => {
    expect((await call("write_object", { path: "FB_PI", implementation: "x" })).status).toBe(403);
    expect((await call("get_workspace", {}, "wrong")).status).toBe(403);
    expect(viewerMayCall("ui_hold")).toBe(true);
    expect(viewerMayCall("get_workspace")).toBe(true);
    expect(viewerMayCall("open_project")).toBe(false);
    expect(viewerMayCall("codesys_sim_force")).toBe(false);
  });

  it("opens the browser once unless forced", () => {
    expect(viewer.open()).toBe(true);
    expect(viewer.open()).toBe(false);
    expect(viewer.open(true)).toBe(true);
    expect(opened).toEqual([viewer.url, viewer.url]);
  });
});
