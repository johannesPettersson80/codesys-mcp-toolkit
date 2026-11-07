/** Browser viewer: serves the workspace on 127.0.0.1, token-gated, panel tools only. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectCache } from "../src/codesys/cache.js";
import { ChangeStore } from "../src/codesys/changes.js";
import { Driver } from "../src/driver.js";
import { SimController } from "../src/sim/controller.js";
import type { AppContext } from "../src/tools.js";
import { startViewer, viewerMayCall, type Viewer } from "../src/viewer.js";
import { TANK_PLANT, tankNodes, tankTasks } from "./fixtures/tank.js";
import { tempDir } from "./helpers.js";

describe("browser viewer", () => {
  let viewer: Viewer;
  const opened: string[] = [];
  const root = tempDir("cmcp-viewer-");
  const project = join(root, "Tank.project");

  beforeAll(async () => {
    writeFileSync(join(root, "Tank.plant.toml"), TANK_PLANT);
    const sim = new SimController({ exportSt: async () => tankNodes(), tasks: async () => tankTasks(), projectPath: () => project }, { mirrorRoot: join(root, "m"), git: false });
    const cache = new ProjectCache();
    cache.reset(project);
    cache.setAll(tankNodes());
    const ctx = { bridge: {} as AppContext["bridge"], autosave: false, workspace: root, startWaitMs: 0, sim, cache, changes: new ChangeStore(join(root, "cp")), driver: new Driver(), project: { path: project } } as AppContext;
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
    const w = ((await r.json()) as { structuredContent: { tree: { path: string }[] } }).structuredContent;
    expect(w.tree.map((n) => n.path)).toContain("PRG_Tank");
    const o = ((await (await call("get_object", { path: "FB_PI" })).json()) as { structuredContent: { object: { implementation: string } } }).structuredContent;
    expect(o.object.implementation).toContain("rE := rSP - rPV;");
  });

  it("refuses other tools and requests without the token", async () => {
    expect((await call("write_object", { path: "FB_PI", implementation: "x" })).status).toBe(403);
    expect((await call("get_workspace", {}, "wrong")).status).toBe(403);
    expect(viewerMayCall("ui_hold")).toBe(true);
    expect(viewerMayCall("get_events")).toBe(true);
    expect(viewerMayCall("open_project")).toBe(false);
    expect(viewerMayCall("run_scans")).toBe(false);
  });

  it("opens the browser once unless forced", () => {
    expect(viewer.open()).toBe(true);
    expect(viewer.open()).toBe(false);
    expect(viewer.open(true)).toBe(true);
    expect(opened).toEqual([viewer.url, viewer.url]);
  });
});
