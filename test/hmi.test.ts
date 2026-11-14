/** HMI screens: spec, renderer, store, actions and the panel's live tools (fake CODESYS). */
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ProjectCache } from "../src/codesys/cache.js";
import { renderScreen } from "../src/hmi/render.js";
import { nativePlan } from "../src/hmi/native.js";
import { overlapWarnings, portsOf, routePipe, routeProblems } from "../src/hmi/route.js";
import { TEMPLATES } from "../src/hmi/templates.js";
import { canvasOf } from "../src/hmi/render.js";
import type { ProcessItem } from "../src/hmi/spec.js";
import { findBrowser } from "../src/hmi/service.js";
import { layoutProblems, plcValue, screenSchema, screenVariables } from "../src/hmi/spec.js";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { fakeBridge, fakeProjectFile, tempDir, viaCodesys } from "./helpers.js";

const SCREEN = {
  name: "Overview",
  title: "Pump Station",
  widgets: [
    {
      type: "process",
      title: "Process",
      at: [1, 1, 8, 5],
      items: [
        { type: "tank", x: 20, y: 20, w: 20, h: 60, level: "PLC_PRG.rLevel", label: "T-101" },
        { type: "pump", x: 60, y: 80, running: "PLC_PRG.xRun", label: "P-101" },
        { type: "pipe", from: "T-101.right", to: "P-101.in", flow: "PLC_PRG.xRun" },
      ],
    },
    { type: "gauge", title: "Level", at: [9, 1, 4, 3], value: "PLC_PRG.rLevel", unit: "%" },
    { type: "buttons", title: "Pump", at: [9, 4, 4, 2], items: [{ label: "Start", variable: "PLC_PRG.xStart" }, { label: "Stop", variable: "PLC_PRG.xStop" }] },
    { type: "alarms", title: "Alarms", at: [1, 6, 6, 3], items: [{ active: "PLC_PRG.xHigh", text: "High level <T-101>" }] },
  ],
};

describe("HMI spec and renderer", () => {
  it("parses a screen with defaults and lists its variables", () => {
    const s = screenSchema.parse(SCREEN);
    expect(s.theme).toBe("dark");
    expect(s.grid).toEqual([12, 8]);
    expect(screenVariables(s).sort()).toEqual(["PLC_PRG.rLevel", "PLC_PRG.xHigh", "PLC_PRG.xRun", "PLC_PRG.xStart", "PLC_PRG.xStop"]);
    expect(layoutProblems(s)).toEqual([]);
  });

  it("reports overlapping and out-of-grid tiles", () => {
    const s = screenSchema.parse({ ...SCREEN, widgets: [...SCREEN.widgets, { type: "text", at: [8, 5, 6, 1], text: "x" }] });
    const p = layoutProblems(s);
    expect(p.join("\n")).toMatch(/runs past the 12x8 grid/);
    expect(p.join("\n")).toMatch(/overlaps widget/);
  });

  it("renders bindings for every bound element and escapes text", () => {
    const r = renderScreen(screenSchema.parse(SCREEN));
    expect(r.html).toContain("High level &lt;T-101&gt;");
    expect(r.html).not.toContain("<T-101>");
    expect(r.bindings.map((b) => b.kind)).toEqual(expect.arrayContaining(["level", "on", "text", "alarm"]));
    for (const m of r.html.matchAll(/data-b="(\d+)"/g)) expect(r.bindings[Number(m[1])]).toBeDefined();
    expect(r.html).toMatch(/data-act="tap" data-var="PLC_PRG.xStart"/);
  });

  it("reads simulation values", () => {
    expect(plcValue("TRUE")).toBe(true);
    expect(plcValue("INT#8")).toBe(8);
    expect(plcValue("REAL#72.5")).toBe(72.5);
    expect(plcValue("T#1s500ms")).toBe(1500);
    expect(plcValue("'abc'")).toBe("'abc'");
  });
});

describe("HMI structure", () => {
  it("every page template is a valid screen with a clean layout", () => {
    for (const [k, t] of Object.entries(TEMPLATES)) {
      const sc = screenSchema.parse(t.screen);
      expect(layoutProblems(sc), k).toEqual([]);
    }
  });

  it("puts the other pages and an alarm count in the header", () => {
    const r = renderScreen(screenSchema.parse(SCREEN), { pages: [{ name: "Overview", title: "Pump Station" }, { name: "Alarms", title: "Alarms" }], alarms: [{ active: "PLC_PRG.xHigh" }, { active: "PLC_PRG.xFault" }] });
    expect(r.html).toMatch(/<button class="h-page cur" data-nav="Overview">Pump Station<\/button><button class="h-page" data-nav="Alarms">Alarms<\/button>/);
    expect(r.bindings).toContainEqual({ kind: "count", vars: ["PLC_PRG.xHigh", "PLC_PRG.xFault"] });
    expect(renderScreen(screenSchema.parse(SCREEN)).html).not.toMatch(/h-nav/); // a single page needs no navigation
  });

  it("opens a faceplate from a symbol, with its controls bound", () => {
    const sc = screenSchema.parse(SCREEN);
    const pump = (sc.widgets[0] as { items: Record<string, unknown>[] }).items[1]!;
    pump.faceplate = { auto: "PLC_PRG.xAuto", start: "PLC_PRG.xStart", stop: "PLC_PRG.xStop", values: [{ label: "Flow", value: "PLC_PRG.rFlow", unit: "m³/h" }] };
    const r = renderScreen(sc);
    expect(r.html).toMatch(/data-open="fp-1"/);
    expect(r.html).toMatch(/<div class="fp" id="fp-1" hidden>/);
    expect(r.html).toMatch(/data-act="tap" data-var="PLC_PRG.xStart"/);
    expect(screenVariables(sc)).toEqual(expect.arrayContaining(["PLC_PRG.xAuto", "PLC_PRG.rFlow"]));
  });

  it("sizes the canvas per panel", () => {
    expect(canvasOf({ size: "800x480" })).toMatchObject({ w: 800, h: 480, header: 54 });
    expect(canvasOf({ size: "1920x1080" })).toMatchObject({ w: 1920, h: 1080 });
    expect(canvasOf({})).toMatchObject({ w: 1280, h: 720 });
  });

  it("warns about overlapping symbols", () => {
    const items = [
      { type: "tank", x: 20, y: 20, w: 20, h: 60, level: "a", max: 100, label: "T-1" },
      { type: "pump", x: 30, y: 50, size: 10, running: "b", label: "P-1" },
      { type: "pump", x: 98, y: 50, size: 10, running: "c", label: "P-2" },
    ] as unknown as ProcessItem[];
    const w = overlapWarnings(items, 0.5);
    expect(w).toContain("tank T-1 overlaps pump P-1.");
    expect(w).toContain("pump P-2 reaches outside the diagram (0..100).");
  });
});

describe("pipe routing", () => {
  const items = [
    { type: "tank", x: 20, y: 20, w: 20, h: 60, level: "a", max: 100, label: "T-101" },
    { type: "pump", x: 60, y: 71, size: 10, running: "b", label: "P-101" },
    { type: "valve", x: 85, y: 40, size: 8, open: "c", vertical: true, label: "V-102" },
    { type: "pipe", from: "T-101.right", to: "P-101.in" },
    { type: "pipe", from: "P-101.out", to: "V-102.in" },
    { type: "pipe", from: "V-102.out", to: [98, 10] },
  ] as unknown as ProcessItem[];

  it("puts ports on the symbols' edges", () => {
    expect(portsOf(items[0]!, 0.5).right).toEqual({ at: [40, 71], dir: "r" });
    expect(portsOf(items[1]!, 0.5).in).toEqual({ at: [55, 71], dir: "l" });
    expect(portsOf(items[2]!, 0.5).in).toEqual({ at: [85, 48], dir: "d" }); // vertical: 4 x units = 8 y units at aspect 0.5
  });

  it("routes pipes with right angles from port to port", () => {
    const [, , , a, b, c] = items;
    expect(routePipe(a as never, items, 0.5)).toEqual([[40, 71], [55, 71]]); // same height: straight
    expect(routePipe(b as never, items, 0.5)).toEqual([[65, 71], [85, 71], [85, 48]]); // out to the right, up into the valve
    expect(routePipe(c as never, items, 0.5)).toEqual([[85, 32], [85, 10], [98, 10]]); // up, then out through the edge
  });

  it("names unknown symbols and ports", () => {
    const bad = [...items, { type: "pipe", from: "P-999.out", to: "V-102.side" }] as unknown as ProcessItem[];
    const p = routeProblems(bad);
    expect(p[0]).toMatch(/no symbol named 'P-999'/);
    expect(p[1]).toMatch(/valve 'V-102' has no port 'side' \(ports: in, out\)/);
  });
});

describe("native CODESYS visualization plan", () => {
  const plan = nativePlan(screenSchema.parse(SCREEN));

  it("names the visualization, image pool and helper program after the screen", () => {
    expect(plan.visu).toBe("Visu_Overview");
    expect(plan.imagePool).toBe("IP_Overview");
    expect(plan.helper.name).toBe("PRG_HMI_Overview");
    expect(plan.helper.declaration).toMatch(/^PROGRAM PRG_HMI_Overview/);
  });

  it("scales bars and tank levels in the helper program and binds them", () => {
    expect(plan.helper.implementation).toMatch(/ANY_TO_REAL\(PLC_PRG\.rLevel\)/);
    const moving = plan.elements.filter((e) => e.props && Object.keys(e.props).some((k) => k.startsWith("Relative movement")));
    expect(moving.length).toBeGreaterThanOrEqual(2); // gauge bar + tank fill
    for (const e of moving) for (const v of Object.values(e.props!)) if (typeof v === "string" && v.startsWith("PRG_HMI_")) expect(plan.helper.declaration).toContain(v.split(".")[1]!);
  });

  it("uses SVG symbols for pumps, with buttons, alarms and texts bound to the program", () => {
    const pump = plan.elements.find((e) => e.kind === "image")!;
    // one SVG per symbol size, drawn at exactly the box's size: the stopped picture and 8 running frames
    expect(plan.images.map((i) => i.id).sort()).toEqual([...Array.from({ length: 8 }, (_, k) => `pump_f${k}_${pump.w}`), `pump_off_${pump.w}`].sort());
    for (const i of plan.images) expect(i.svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${pump.w}" height="${pump.w}"`));
    expect(pump.props!["Static ID"]).toBe(`IP_Overview.pump_off_${pump.w}`);
    expect(pump.props!["Bitmap ID variable.Bitmap ID"]).toBe(`SEL(PLC_PRG.xRun, 'IP_Overview.pump_off_${pump.w}', CONCAT('IP_Overview.pump_f', CONCAT(INT_TO_STRING(PRG_HMI_Overview.iF${(plan.helper.implementation.match(/iF(\d+)/) ?? [])[1]}), '_${pump.w}')))`);
    expect(plan.helper.implementation).toMatch(/IF PLC_PRG\.xRun THEN iF\d+ := DINT_TO_INT\(\(TIME_TO_DINT\(TIME\(\)\) \/ 100\) MOD 8\); END_IF/);
    expect(plan.elements.find((e) => e.text === "Start")!.props).toMatchObject({ "Input configuration.Tap.Variable": "PLC_PRG.xStart" });
    expect(plan.elements.find((e) => e.invisible === "NOT PLC_PRG.xHigh")!.text).toMatch(/High level <T-101>/);
    for (const e of plan.elements) expect(e.x + e.w).toBeLessThanOrEqual(1280);
  });
});

describe("HMI actions over MCP (fake CODESYS)", () => {
  let client: Client;
  let ctx: AppContext;
  let projectFile: string;
  const call = async (action: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool(viaCodesys(action, args))) as { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
    return { text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), images: r.content.filter((c) => c.type === "image"), isError: !!r.isError };
  };
  const panel = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
  };

  beforeAll(async () => {
    ctx = { bridge: fakeBridge({ staleHeartbeatMs: 30_000, hungGraceMs: 10_000 }), autosave: true, workspace: tempDir(), startWaitMs: 20_000, cache: new ProjectCache() };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } as never });
    await client.connect(b);
    projectFile = fakeProjectFile();
    await call("open_project", { path: projectFile });
  }, 60_000);
  afterAll(async () => {
    await client.close();
    await ctx.bridge.stop();
  });

  it("saves, lists and returns a screen next to the project", async () => {
    const r = await call("hmi_save_screen", { screen: SCREEN });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Saved screen 'Overview' \(4 widgets, 5 variables\)/);
    const file = projectFile.replace(/\.project$/, ".hmi.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).screens[0].name).toBe("Overview");
    expect((await call("hmi_list")).text).toMatch(/Overview: "Pump Station" \(4 widgets, 5 variables\)/);
    expect((await call("hmi_save_screen", { screen: { ...SCREEN, title: "Pump Station 2" } })).text).toMatch(/^Replaced/);
  });

  it("refuses a screen with overlapping tiles", async () => {
    const r = await call("hmi_save_screen", { screen: { ...SCREEN, name: "Bad", widgets: [...SCREEN.widgets, { type: "text", at: [1, 1, 2, 2], text: "x" }] } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not saved: fix the layout/);
  });

  it("serves the screen to the panel, and writes only into a running simulation", async () => {
    const h = await panel("get_hmi", {});
    expect(h.screens).toEqual([{ name: "Overview", title: "Pump Station 2" }]);
    expect((h.screen as { name: string }).name).toBe("Overview");
    expect(h.values).toEqual({});
    const w = await panel("ui_hmi_write", { variable: "PLC_PRG.xStart", value: "TRUE" });
    expect(w).toMatchObject({ ok: false, message: expect.stringMatching(/simulation isn't running/) });
  });

  it.skipIf(!findBrowser())("returns a screenshot image", async () => {
    const r = await call("hmi_screenshot", { screen: "Overview" });
    expect(r.isError).toBe(false);
    expect(r.images).toHaveLength(1);
    expect(Buffer.from(r.images[0]!.data!, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(r.text).toMatch(/example values/);
  }, 90_000);

  it("says when this CODESYS can't build visualizations", async () => {
    const r = await call("hmi_export_codesys", { screen: "Overview" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/visualization scripting/);
  });

  it("says when the language services aren't there", async () => {
    const r = await call("get_signature", { names: ["TON"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unavailable/);
  });

  it("deletes a screen", async () => {
    expect((await call("hmi_delete_screen", { screen: "Overview" })).text).toMatch(/Deleted/);
    expect((await call("hmi_list")).text).toBe("No HMI screens yet.");
  });
});
