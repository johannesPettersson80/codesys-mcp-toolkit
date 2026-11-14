/** HMI screens: spec, renderer, store, actions and the panel's live tools (fake CODESYS). */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ProjectCache } from "../src/codesys/cache.js";
import { renderScreen } from "../src/hmi/render.js";
import { accessRights, GAUGE_STEPS, nativePlan, onColor, paletteFor, type NativeElement } from "../src/hmi/native.js";
import { bottomTaken, connectionWarnings, overlapWarnings, portsOf, routePipe, routeProblems } from "../src/hmi/route.js";
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
    expect(plcValue("'abc'")).toBe("abc"); // a STRING shows without its quotes
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

describe("process checks: is the diagram a process?", () => {
  const P = (items: unknown[]) => items as ProcessItem[];
  it("reports floating equipment, missing inlets and outlets, a one-circuit heat exchanger and stray instruments", () => {
    const w = connectionWarnings(
      P([
        { type: "tank", x: 5, y: 20, w: 10, h: 50, level: "a", label: "T-1" },
        { type: "pump", x: 30, y: 80, size: 8, running: "b", label: "P-1" },
        { type: "symbol", symbol: "heat_exchanger", x: 50, y: 80, size: 10, label: "E-1" },
        { type: "symbol", symbol: "motor", x: 70, y: 20, size: 6, label: "M-1" },
        { type: "symbol", symbol: "pressure_switch", x: 40, y: 40, size: 5, label: "PS-1" },
        { type: "symbol", symbol: "level_switch", x: 80, y: 50, size: 5, label: "LS-1" },
        { type: "sensor", x: 85, y: 10, value: "c", label: "TT-1" },
        { type: "pipe", from: "T-1.right", to: "P-1.in" },
        { type: "pipe", from: "P-1.out", to: "E-1.in" },
        { type: "pipe", from: "E-1.out", to: [60, 50] },
      ]),
      0.5,
    );
    const all = w.join("\n");
    expect(all).toContain("tank T-1: nothing flows in");
    expect(all).not.toContain("tank T-1: nothing flows out");
    expect(all).toContain("heat exchanger E-1 needs both circuits");
    expect(all).toContain("motor M-1 drives nothing");
    expect(all).toContain("pressure_switch PS-1 isn't connected: run a short pipe from its bottom");
    expect(all).toContain("level_switch LS-1 isn't on a tank");
    expect(all).toContain("sensor TT-1 isn't next to a pipe or tank");
    expect(all).toContain("pipe 10 ends at [60, 50], in the middle of the diagram");
    expect(all).not.toContain("P-1");
  });

  it("is quiet for a connected line, and the built-in templates pass", () => {
    const ok = P([
      { type: "tank", x: 5, y: 20, w: 10, h: 50, level: "a", label: "T-1" },
      { type: "symbol", symbol: "level_switch", x: 10, y: 25, size: 4, label: "LS-1" },
      { type: "pump", x: 30, y: 80, size: 8, running: "b", label: "P-1" },
      { type: "symbol", symbol: "motor", x: 30, y: 68, size: 6, rotate: 90, label: "M-1" },
      { type: "sensor", x: 45, y: 74, value: "c", label: "PT-1" },
      { type: "pipe", from: [0, 25], to: "T-1.left-high" },
      { type: "pipe", from: "T-1.right", to: "P-1.in" },
      { type: "pipe", from: "P-1.out", to: [100, 80] },
    ]);
    expect(connectionWarnings(ok, 0.5)).toEqual([]);
    for (const t of Object.values(TEMPLATES)) {
      const s = screenSchema.parse((t as { screen?: unknown }).screen ?? t);
      for (const w of s.widgets) if (w.type === "process") expect(connectionWarnings(w.items, 0.5)).toEqual([]);
    }
  });

  it("moves a label aside when a pipe or a motor's shaft runs below the item", () => {
    const items = P([
      { type: "tank", x: 5, y: 20, w: 10, h: 50, level: "a", label: "T-1" },
      { type: "pump", x: 30, y: 90, size: 6, running: "b", label: "P-1" },
      { type: "symbol", symbol: "motor", x: 60, y: 40, size: 6, rotate: 90, label: "M-1" },
      { type: "symbol", symbol: "motor", x: 80, y: 40, size: 6, label: "M-2" },
      { type: "pipe", from: "T-1.bottom", to: "P-1.in" },
    ]);
    expect([...bottomTaken(items)].sort()).toEqual(["m-1", "t-1"]);
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

/** A plan's elements with the fallbacks of complex elements (drawn when CODESYS has no window). */
const flat = (els: NativeElement[]): NativeElement[] => els.flatMap((e) => [e, ...(e.fallback ? flat(e.fallback) : [])]);

describe("native CODESYS visualization plan", () => {
  const plan = nativePlan(screenSchema.parse(SCREEN));

  it("names the visualization, image pool and helper program after the screen", () => {
    expect(plan.visu).toBe("Visu_Overview");
    expect(plan.imagePool).toBe("IP_Overview");
    expect(plan.helper.name).toBe("PRG_HMI_Overview");
    expect(plan.helper.declaration).toMatch(/^PROGRAM PRG_HMI_Overview/);
  });

  it("draws a gauge as the browser's arc, one picture per step chosen by the helper program", () => {
    const gauge = plan.elements.find((e) => e.kind === "image" && String(e.props?.["Static ID"]).includes("gauge_"))!;
    const ids = plan.images.filter((i) => i.id.startsWith(`gauge_${gauge.w}_`)).map((i) => i.id);
    expect(ids).toHaveLength(GAUGE_STEPS + 1);
    expect(gauge.props!["Bitmap ID variable.Bitmap ID"]).toMatch(/^CONCAT\('IP_Overview\.gauge_\d+_', CONCAT\(INT_TO_STRING\(PRG_HMI_Overview\.iG\d+\), '(_\w+)?'\)\)$/);
    expect(plan.helper.implementation).toMatch(/iG\d+ := REAL_TO_INT\(LIMIT\(0\.0, \(ANY_TO_REAL\(PLC_PRG\.rLevel\)/);
    expect(plan.images.find((i) => i.id === ids[0])!.svg).not.toMatch(/stroke-width="14" stroke-linecap="round"\/><path/); // empty at 0
    expect(plan.elements.some((e) => e.kind === "complex")).toBe(false);
  });

  it("makes alarm rows follow CODESYS's alarm states, with time, state and ACK, when the alarms are exported", () => {
    const withIdx = nativePlan(screenSchema.parse(SCREEN), [], {}, { "PLC_PRG.xHigh": 0 });
    expect(withIdx.helper.implementation).toMatch(/iAs\d+ := TO_INT\(__Alm__GVL\.g_inst\.gen_Inst_AG_HMI_AlarmGroup\.gen_ArrAllAlarms\[0\]\.m_eState\);/);
    expect(withIdx.helper.implementation).toMatch(/LINT_TO_DT\(.*m_liTimestampActive \/ 10000000 - 11644473600 \+ INT_TO_LINT\(.*m_iOffsetActive\) \* 60\)/);
    const ack = withIdx.elements.find((e) => e.text === "ACK")!;
    expect(ack.click).toBe("__Alm__GVL.g_inst.gen_Inst_AG_HMI_AlarmGroup.gen_ArrAllAlarms[0].m_xToAcknowledge := TRUE;");
    expect(ack.invisible).toMatch(/^NOT PRG_HMI_Overview\.xAk\d+$/);
    expect(withIdx.elements.find((e) => e.text === "No active alarms")!.invisible).toMatch(/PRG_HMI_Overview\.xAo\d+/);
  });

  it("scales bars and tank levels in the helper program and binds them", () => {
    expect(plan.helper.implementation).toMatch(/ANY_TO_REAL\(PLC_PRG\.rLevel\)/);
    const moving = flat(plan.elements).filter((e) => e.props && Object.keys(e.props).some((k) => k.startsWith("Relative movement")));
    expect(moving.length).toBeGreaterThanOrEqual(1); // the tank fill (the gauge is pictures now)
    for (const e of moving) for (const v of Object.values(e.props!)) if (typeof v === "string" && v.startsWith("PRG_HMI_")) expect(plan.helper.declaration).toContain(v.split(".")[1]!);
  });

  it("uses SVG symbols for pumps, with buttons, alarms and texts bound to the program", () => {
    const pump = plan.elements.find((e) => e.kind === "image")!;
    // one SVG per symbol size, drawn at exactly the box's size: the stopped picture and 8 running frames
    expect(plan.images.filter((i) => i.id.startsWith("pump")).map((i) => i.id).sort()).toEqual([...Array.from({ length: 8 }, (_, k) => `pump_f${k}_${pump.w}`), `pump_off_${pump.w}`].sort());
    for (const i of plan.images.filter((x) => x.id.startsWith("pump"))) expect(i.svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${pump.w}" height="${pump.w}"`));
    expect(pump.props!["Static ID"]).toBe(`IP_Overview.pump_off_${pump.w}`);
    expect(pump.props!["Bitmap ID variable.Bitmap ID"]).toBe(`SEL(PLC_PRG.xRun, 'IP_Overview.pump_off_${pump.w}', CONCAT('IP_Overview.pump_f', CONCAT(INT_TO_STRING(PRG_HMI_Overview.iF${(plan.helper.implementation.match(/iF(\d+)/) ?? [])[1]}), '_${pump.w}')))`);
    expect(plan.helper.implementation).toMatch(/IF PLC_PRG\.xRun THEN iF\d+ := DINT_TO_INT\(\(TIME_TO_DINT\(TIME\(\)\) \/ 100\) MOD 8\); END_IF/);
    expect(plan.elements.find((e) => e.text === "Start")!.props).toMatchObject({ "Input configuration.Tap.Variable": "PLC_PRG.xStart" });
    expect(flat(plan.elements).find((e) => e.invisible === "NOT PLC_PRG.xHigh")!.text).toMatch(/High level <T-101>/);
    for (const e of plan.elements) expect(e.x + e.w).toBeLessThanOrEqual(1280);
  });
});

describe("alarm history on the alarms widget", () => {
  it("native rows read GVL_AlarmHistory with the AG_HMI messages; the browser gets a history list", () => {
    const widgets = SCREEN.widgets.map((w: { type: string }) => (w.type === "alarms" ? { ...w, history: 3 } : w));
    const s = screenSchema.parse({ ...SCREEN, widgets });
    const plan = nativePlan(s, [], {}, { "PLC_PRG.xHigh": 0 }, [], ["Level high", "Pump fault"]);
    expect(plan.helper.implementation).toContain("IF GVL_AlarmHistory.aEvents[iHi].sGroup = 'AG_HMI' AND GVL_AlarmHistory.aEvents[iHi].sAlarm = '2' THEN sHx := 'Pump fault'; END_IF");
    expect(plan.helper.declaration.match(/sHt\d+ : STRING\(12\);/g)).toHaveLength(3);
    expect(plan.elements.some((e) => e.text === "HISTORY")).toBe(true);
    // Without CODESYS alarms there is no history in the PLC.
    expect(nativePlan(s).helper.implementation).not.toContain("GVL_AlarmHistory");
    expect(renderScreen(s).html).toContain('<ul class="al-hist" data-hist="3"></ul>');
  });
});

describe("access rights per tile", () => {
  it("rights per user group, with None for nobody logged in", () => {
    expect(accessRights("Maintenance", "see")).toEqual([["None", "OnlyVisible"], ["Operator", "OnlyVisible"], ["Maintenance", "Operable"], ["Admin", "Operable"]]);
    expect(accessRights("Admin", "hide")).toEqual([["None", "Invisible"], ["Operator", "Invisible"], ["Maintenance", "Invisible"], ["Admin", "Operable"]]);
  });

  it("every element of a restricted tile carries them; the browser marks the tile", () => {
    const widgets = SCREEN.widgets.map((w: { type: string }, k: number) => (k === 0 ? { ...w, access: { min: "Maintenance" } } : w));
    const s = screenSchema.parse({ ...SCREEN, widgets });
    const plan = nativePlan(s);
    const tile = plan.elements.find((e) => e.name === "Tile1")!;
    expect(tile.access?.[2]).toEqual(["Maintenance", "Operable"]);
    expect(plan.elements.find((e) => e.name === "Tile2")!.access).toBeUndefined();
    expect(renderScreen(s).html).toContain('class="t-lock" title="In CODESYS: operated by Maintenance and up"');
    expect(() => screenSchema.parse({ ...SCREEN, widgets: SCREEN.widgets.map((w: object) => ({ ...w, access: { min: "Boss" } })) })).toThrow();
  });
});

describe("themes, brand colour and pipe flow", () => {
  it("high contrast and a brand colour in the browser", () => {
    const contrast = renderScreen(screenSchema.parse({ ...SCREEN, theme: "contrast" }));
    expect(contrast.html).toContain('class="hmi theme-contrast');
    expect(contrast.css).toContain(".theme-contrast{--bg:#000;--fg:#fff");
    const red = renderScreen(screenSchema.parse({ ...SCREEN, accent: "#e30613" }));
    expect(red.html).toContain("--accent:#e30613;--on-accent:#fff");
    const yellow = renderScreen(screenSchema.parse({ ...SCREEN, accent: "#ffd400" }));
    expect(yellow.html).toContain("--accent:#ffd400;--on-accent:#04121f");
    expect(() => screenSchema.parse({ ...SCREEN, accent: "red" })).toThrow();
  });

  it("the native palette follows the theme and the brand colour", () => {
    expect(paletteFor({ theme: "contrast" }).bg).toBe(0xff000000);
    expect(paletteFor({ theme: "contrast" }).border).toBe(0xffffffff);
    expect(paletteFor({ theme: "light", accent: "#e30613" }).tones.accent).toBe(0xffe30613);
    expect(paletteFor({ theme: "dark" }).tones.accent).toBe(0xff38bdf8);
    expect(onColor(0xffe30613)).toBe(0xffffffff);
    expect(onColor(0xffffd400)).toBe(0xff04121f);
    const plan = nativePlan(screenSchema.parse({ ...SCREEN, theme: "contrast", accent: "#e30613" }), [{ name: "Overview", title: "A" }, { name: "Other", title: "B" }]);
    const nav = plan.elements.find((e) => e.name === "Nav_Overview")!;
    expect(nav.fill).toBe(0xffe30613);
    expect(nav.color).toBe(0xffffffff);
  });

  it("native pipes with flow get dashes that slide with the clock", () => {
    const plan = nativePlan(screenSchema.parse(SCREEN));
    const dashes = plan.elements.filter((e) => e.invisible === "NOT (PLC_PRG.xRun)" && e.kind === "rect");
    expect(dashes.length).toBeGreaterThan(0);
    for (const d of dashes) {
      const moves = Object.entries(d.props ?? {}).filter(([k]) => k.startsWith("Relative movement."));
      expect(moves).toHaveLength(2);
      expect(new Set(moves.map(([, v]) => v)).size).toBe(1);
    }
    expect(plan.helper.declaration).toContain("iFlow : INT;");
    expect(plan.helper.implementation).toContain("iFlow := DINT_TO_INT((TIME_TO_DINT(TIME()) / 20) MOD 24);");
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

  it("saves the project's own symbol, refuses unsafe SVG, and uses it on a screen", async () => {
    const bad = await call("hmi_save_symbol", { name: "centrifuge", svg: `<circle r="4" onclick="x()"/><script>1</script>` });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Not saved: the symbol's SVG needs changes[\s\S]*onclick[\s\S]*<script> is not allowed/);
    expect((await call("hmi_save_symbol", { name: "motor", svg: "<g/>" })).text).toMatch(/standard symbol/);
    const ok = await call("hmi_save_symbol", { name: "centrifuge", svg: `<circle cx="50" cy="50" r="44" fill="var(--body)" stroke="var(--state)" stroke-width="5"/><g class="spin"><path d="M50 20v60M20 50h60" stroke="var(--line)" stroke-width="5"/></g>`, ports: { in: { x: 6, y: 50, dir: "left" }, out: { x: 94, y: 50, dir: "right" } }, description: "Decanter centrifuge" });
    expect(ok.isError).toBe(false);
    expect(ok.text).toMatch(/Saved symbol 'centrifuge' \(100x100, ports: in, out\)/);
    if (findBrowser()) expect(ok.images).toHaveLength(1);
    const list = await call("hmi_symbols", { names: ["centrifuge", "heat_exchanger"] });
    expect(list.text).toMatch(/centrifuge \(project\): Decanter centrifuge \[100x100; ports: in left, out right\]/);
    expect(list.text).toMatch(/heat_exchanger: Heat exchanger/);
    const plant = { name: "Plant", title: "Plant", widgets: [{ type: "process", at: [1, 1, 8, 5], items: [{ type: "symbol", symbol: "centrifuge", label: "C-1", x: 50, y: 50, size: 16, on: "PLC_PRG.xRun" }, { type: "pipe", from: [0, 50], to: "C-1.in" }] }] };
    expect((await call("hmi_save_screen", { screen: plant })).isError).toBe(false);
    const h = await panel("get_hmi", { screen: "Plant" });
    expect(Object.keys(h.symbols as object)).toEqual(["centrifuge"]);
    const wrong = await call("hmi_save_screen", { screen: { ...plant, widgets: [{ ...plant.widgets[0], items: [{ type: "symbol", symbol: "decanter", x: 50, y: 50 }] }] } });
    expect(wrong.text).toMatch(/no symbol 'decanter' in the library/);
    expect((await call("hmi_delete_screen", { screen: "Plant" })).text).toMatch(/Deleted/);
    expect((await call("hmi_delete_symbol", { name: "centrifuge" })).text).toMatch(/Deleted symbol 'centrifuge'/);
  }, 90_000);

  it("exports the project as text files, updates them, and removes files of deleted objects", async () => {
    const dir = join(tempDir(), "src");
    const first = await call("export_sources", { dir });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/Exported to .*: \d+ \.st file\(s\), 1 graphical body\(ies\) as \.xml, project\.txt(, hmi\.json)?\. \d+ file\(s\) written or changed/);
    expect(readdirSync(dir).some((f) => f.endsWith(".xml"))).toBe(true);
    expect(readFileSync(join(dir, "PLC_PRG.st"), "utf8")).toMatch(/^PROGRAM PLC_PRG/);
    expect(readFileSync(join(dir, "project.txt"), "utf8")).toMatch(/\[Tasks\][\s\S]*\[Libraries\]/);
    expect((await call("export_sources", { dir })).text).toMatch(/ 0 file\(s\) written or changed;/);
    // A file an earlier export wrote for an object that no longer exists goes; other files stay.
    const manifest = JSON.parse(readFileSync(join(dir, ".codesys-export.json"), "utf8")) as { files: string[] };
    writeFileSync(join(dir, "FB_Gone.st"), "FUNCTION_BLOCK FB_Gone\n");
    writeFileSync(join(dir, "notes.md"), "mine\n");
    writeFileSync(join(dir, ".codesys-export.json"), JSON.stringify({ files: [...manifest.files, "FB_Gone.st"] }));
    expect((await call("export_sources", { dir })).text).toMatch(/1 removed \(deleted objects\)/);
    expect(existsSync(join(dir, "FB_Gone.st"))).toBe(false);
    expect(existsSync(join(dir, "notes.md"))).toBe(true);
  });

  it("writes a project report with a commissioning checklist", async () => {
    const file = join(tempDir(), "report.md");
    const r = await call("project_report", { path: file });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/Wrote .*report\.md \(\d+ lines, \d+ checklist items\)/);
    const md = readFileSync(file, "utf8");
    expect(md).toMatch(/## Summary[\s\S]*## Tasks[\s\S]*## Commissioning checklist/);
    expect(md).toMatch(/- \[ \] Safety functions/);
  });

  it("needs the simulation for alarm states and acknowledging", async () => {
    for (const a of ["alarm_status", "alarm_acknowledge"]) {
      const r = await call(a);
      expect(r.isError, a).toBe(true);
      expect(r.text, a).toMatch(/simulation isn't running/);
    }
    const w = await panel("ui_hmi_write", { variable: "@ack:PLC_PRG.xFault", value: "TRUE" });
    expect(w).toMatchObject({ ok: false, message: expect.stringMatching(/simulation isn't running/) });
  });

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
