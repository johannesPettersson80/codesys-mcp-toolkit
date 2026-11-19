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
import { connectionWarnings, labelSpots, meaningWarnings, overlapWarnings, portsOf, routePipe, routeProblems } from "../src/hmi/route.js";
import { TEMPLATES } from "../src/hmi/templates.js";
import { BUILTIN_SYMBOLS } from "../src/hmi/symbols.js";
import { canvasOf, cardWarnings, HMI_CSS, tileBox } from "../src/hmi/render.js";
import { THEMES } from "../src/hmi/theme.js";
import type { ProcessItem } from "../src/hmi/spec.js";
import { findBrowser, symbolSheet } from "../src/hmi/service.js";
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
    expect(s.theme).toBe("light");
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

  it("puts the other pages in a rail and an alarm count in the top bar", () => {
    const r = renderScreen(screenSchema.parse(SCREEN), { pages: [{ name: "Overview", title: "Pump Station" }, { name: "Alarms", title: "Alarms" }], alarms: [{ active: "PLC_PRG.xHigh" }, { active: "PLC_PRG.xFault" }] });
    // Each page with its icon (its own, or one from its title) and its title.
    expect(r.html).toMatch(/<button class="r-page cur" data-nav="Overview"><svg[^>]*><path d="M3\.5 11[^"]*"\/><\/svg><span>Pump Station<\/span><\/button><button class="r-page" data-nav="Alarms"><svg[^>]*><path d="M6 16\.5/);
    expect(r.bindings).toContainEqual({ kind: "count", vars: ["PLC_PRG.xHigh", "PLC_PRG.xFault"] });
    expect(renderScreen(screenSchema.parse(SCREEN)).html).not.toMatch(/h-rail/); // a single page needs no navigation
    // The rail moves the cards right.
    expect(tileBox(screenSchema.parse(SCREEN), [1, 1, 1, 1], true).x).toBe(tileBox(screenSchema.parse(SCREEN), [1, 1, 1, 1]).x + 84);
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

describe("station line (process overview)", () => {
  const LINE = {
    name: "Overview",
    title: "Line",
    widgets: [
      {
        type: "line",
        at: [1, 1, 12, 4],
        stations: [
          { name: "Feed", tag: "T-201", symbol: "tank", value: "PLC_PRG.rLevel", unit: "%", screen: "Process" },
          { name: "Pump", symbol: "pump", on: "PLC_PRG.xPump", fault: "PLC_PRG.xFault", warning: "PLC_PRG.xWarn", manual: "PLC_PRG.xHand" },
          { name: "Heating", symbol: "heat_exchanger", on: "PLC_PRG.xHeat", feed: { name: "Steam", symbol: "control_valve", on: "PLC_PRG.xSteam" } },
          { name: "Filling", symbol: "valve", on: "PLC_PRG.xFill" },
        ],
      },
    ],
  };

  it("lists the stations' and feeds' variables", () => {
    expect(screenVariables(screenSchema.parse(LINE)).sort()).toEqual(["PLC_PRG.rLevel", "PLC_PRG.xFault", "PLC_PRG.xFill", "PLC_PRG.xHand", "PLC_PRG.xHeat", "PLC_PRG.xPump", "PLC_PRG.xSteam", "PLC_PRG.xWarn"]);
  });

  it("draws a tile per station on the product path, the feed above, the state signs, a tap to the page", () => {
    const { html, bindings } = renderScreen(screenSchema.parse(LINE));
    expect(html.match(/class="stn[ "]/g)).toHaveLength(5);
    expect(html).toContain('data-nav="Process"');
    expect(html).toContain('class="ln-arrow"');
    // No words: the run sign before the name (driven equipment, not valves), the hand in Manual, the condition badge.
    expect(html).not.toMatch(/RUNNING|STOPPED|>OPEN<|CLOSED/);
    expect(html.match(/<svg class="rs"/g)).toHaveLength(2);
    expect(bindings).toContainEqual({ kind: "on", v: "PLC_PRG.xHand" });
    expect(html).toContain('class="stn-wn"');
    expect(bindings).toContainEqual({ kind: "fault", v: "PLC_PRG.xFault" });
    // A valve pictogram is filled while closed.
    expect(html).toContain('class="stn-pic vlv"');
    expect(bindings).toContainEqual({ kind: "text", v: "PLC_PRG.rLevel", decimals: 1 });
    // Pictograms: the built-in tank and the library's heat exchanger.
    expect(html).toContain("M30 22Q30 10 50 10");
    expect(html).toContain("M10 50H30L50 30V70L70 50H90");
  });

  it("sizes diagram texts as the browser does and marks line ends with an arrow in CODESYS", () => {
    const s = screenSchema.parse({
      name: "P",
      title: "P",
      widgets: [
        {
          type: "process",
          at: [1, 1, 12, 8],
          items: [
            { type: "pump", x: 50, y: 50, size: 10, running: "PLC_PRG.x", label: "P-1" },
            { type: "pipe", from: [0, 50], to: "P-1.in", label: "Feed" },
            { type: "pipe", from: "P-1.out", to: [100, 50], label: "Out" },
          ],
        },
      ],
    });
    const plan = nativePlan(s);
    const body = tileBox(s, [1, 1, 12, 8]).w - 32;
    const label = plan.elements.find((e) => e.text === "P-1")!;
    // .p-label is 1.75 diagram units, a unit being a hundredth of the card's body.
    expect(label.font![1]).toBeCloseTo((1.75 * body) / 100, 0);
    expect(plan.elements.find((e) => e.text === "Feed")!.font![1]).toBeCloseTo((1.9 * body) / 100, 0);
    expect(plan.images.filter((i) => i.id.startsWith("arrow_r_"))).toHaveLength(1);
    expect(plan.elements.filter((e) => e.kind === "image" && String(e.props?.["Static ID"]).includes(".arrow_r_"))).toHaveLength(2);
  });

  it("draws the same line in CODESYS: tiles, pictograms, the state signs, a tap to the page", () => {
    const plan = nativePlan(screenSchema.parse(LINE), [{ name: "Overview", title: "Overview" }, { name: "Process", title: "Process" }]);
    const ids = plan.images.map((i) => i.id);
    // The pump and the heat exchanger have an off and an on picture; the tank, without a state, one.
    expect(ids.filter((i) => i.startsWith("stn_pic_pump_"))).toHaveLength(2);
    expect(ids.filter((i) => i.startsWith("stn_heat_exchanger_"))).toHaveLength(2);
    expect(ids.filter((i) => i.startsWith("stn_pic_tank_nostat"))).toHaveLength(1);
    expect(ids.some((i) => i.startsWith("arrow_r_"))).toBe(true);
    expect(plan.elements.find((e) => e.goto === "Visu_Process" && e.name?.startsWith("Station_"))).toBeDefined();
    expect(plan.elements.some((e) => e.text === "RUNNING" || e.text === "STOPPED" || e.text === "OPEN")).toBe(false);
    const signs = (kind: string) => plan.elements.filter((e) => String(e.props?.["Static ID"]).includes(`.sign_${kind}_`));
    // ▶ shows while running, ■ while stopped (the pump and the heat exchanger; valves have none).
    expect(signs("run").map((e) => e.invisible).sort()).toEqual(["NOT (PLC_PRG.xHeat)", "NOT (PLC_PRG.xPump)"]);
    expect(signs("stop").map((e) => e.invisible).sort()).toEqual(["PLC_PRG.xHeat", "PLC_PRG.xPump"]);
    // The alarm badge while faulted; the warning only without an alarm.
    expect(signs("alarm").map((e) => e.invisible)).toEqual(["NOT (PLC_PRG.xFault)"]);
    expect(signs("warning").map((e) => e.invisible)).toEqual(["NOT ((PLC_PRG.xWarn) AND NOT (PLC_PRG.xFault))"]);
    expect(plan.elements.some((e) => String(e.props?.["Static ID"]).includes(".ic_manual_") && e.invisible === "NOT (PLC_PRG.xHand)")).toBe(true);
    // The top edge shows the condition only: amber and red bars over the neutral one.
    expect(plan.elements.filter((e) => e.fill === paletteFor({}).tones.warn && e.invisible === "NOT (PLC_PRG.xWarn)")).toHaveLength(1);
  });

  it("keeps the tiles inside the card on every panel size", async () => {
    const { lineLayout } = await import("../src/hmi/render.js");
    for (const [w, h, n] of [[1216, 220, 8], [600, 160, 12], [760, 120, 4]] as const) {
      const L = lineLayout({ stations: Array.from({ length: n }, (_, i) => (i === 1 ? { feed: {} } : {})) }, w, h, 1);
      expect(L.xs[0]!).toBeGreaterThanOrEqual(0);
      expect(L.xs[n - 1]! + L.tw).toBeLessThanOrEqual(w);
      expect(L.fy).toBeGreaterThanOrEqual(-0.01);
      expect(L.y + L.th).toBeLessThanOrEqual(h + 0.01);
    }
  });
});

describe("texts on a process diagram", () => {
  const items = (list: unknown[]) => (screenSchema.parse({ name: "P", title: "P", widgets: [{ type: "process", at: [1, 1, 12, 8], items: list }] }).widgets[0] as { items: ProcessItem[] }).items;

  it("puts a label clear of pipes and inside the diagram, and says when there is no room", async () => {
    const { placeTexts, textWarnings } = await import("../src/hmi/labels.js");
    const { routed } = await import("../src/hmi/route.js");
    const { BUILTIN_SYMBOLS } = await import("../src/hmi/symbols.js");
    // A pump near the bottom edge with a pipe leaving downwards: its name goes beside, not off the diagram.
    const list = items([
      { type: "pump", x: 50, y: 92, size: 8, running: "PLC_PRG.x", label: "P-1" },
      { type: "pipe", from: [0, 92], to: "P-1.in" },
      { type: "pipe", from: "P-1.out", to: [100, 92] },
    ]);
    const all = routed(list, 0.5, BUILTIN_SYMBOLS);
    const pl = placeTexts(all, 0.5, BUILTIN_SYMBOLS).labels.get("p-1")!;
    expect(pl.y + 1.2).toBeLessThanOrEqual(0.5 * 100 + 1);
    expect(Math.abs(pl.y - 92 * 0.5)).toBeGreaterThan(1.2); // not on the pipe's line
    // Two pumps squeezed together: hmi_save_screen names the label without room.
    const tight = items([
      { type: "pump", x: 50, y: 50, size: 8, running: "a", label: "P-1" },
      { type: "pump", x: 50, y: 58, size: 8, running: "b", label: "P-2" },
      { type: "pump", x: 42, y: 54, size: 8, running: "c", label: "P-3" },
      { type: "pump", x: 58, y: 54, size: 8, running: "d", label: "P-4" },
      { type: "pump", x: 50, y: 66, size: 8, running: "e", label: "P-5" },
    ]);
    expect(textWarnings(tight, 0.5, BUILTIN_SYMBOLS).join(" ")).toMatch(/has no free place/);
  });

  it("shows an equipment's own value under its name, as plain text, in the browser and CODESYS", () => {
    const s = screenSchema.parse({ name: "P", title: "P", widgets: [{ type: "process", at: [1, 1, 12, 8], items: [{ type: "symbol", symbol: "control_valve", x: 50, y: 40, size: 8, on: "PLC_PRG.xOpen", manual: "PLC_PRG.xHand", value: "PLC_PRG.rOpening", unit: "%", decimals: 0, label: "TCV-1" }, { type: "pipe", from: [0, 40], to: "TCV-1.in" }, { type: "pipe", from: "TCV-1.out", to: [100, 40] }] }] });
    expect(screenVariables(s)).toEqual(expect.arrayContaining(["PLC_PRG.rOpening", "PLC_PRG.xHand"]));
    const { html, bindings } = renderScreen(s);
    expect(html).toContain('class="p-val"');
    expect(bindings).toContainEqual({ kind: "text", v: "PLC_PRG.rOpening", decimals: 0, unit: "%" });
    // A valve has no run sign: its position is its fill (closed filled).
    expect(html).not.toMatch(/<g class="rs"/);
    expect(html).toContain('class="sym sym-control_valve vlv"');
    const plan = nativePlan(s);
    expect(plan.elements.some((e) => e.text === "%.0f %" && String(e.props?.["Text variables.Text variable"]).startsWith("PRG_HMI_P.rV"))).toBe(true);
  });

  it("catches mistakes of meaning: an equipment's value drawn as a sensor, a run state on passive equipment", () => {
    const list = items([
      { type: "symbol", symbol: "control_valve", x: 40, y: 40, size: 7, on: "PLC_PRG.xHeat", label: "TCV-201" },
      { type: "sensor", x: 30, y: 20, value: "PLC_PRG.rOpening", unit: "%", decimals: 0, label: "TCV-201 opening" },
      { type: "symbol", symbol: "filter", x: 60, y: 60, size: 7, on: "PLC_PRG.xRun", label: "F-201" },
      { type: "symbol", symbol: "motor", x: 80, y: 60, size: 6, on: "PLC_PRG.xMotor", label: "M-1" },
      { type: "sensor", x: 70, y: 20, value: "PLC_PRG.rTemp", label: "TT-201" },
    ]);
    const w = meaningWarnings(list);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/sensor 'TCV-201 opening' is a value of TCV-201: put it on TCV-201 instead \(\{value: 'PLC_PRG.rOpening', unit: '%', decimals: 0\}\)/);
    expect(w[1]).toMatch(/^filter F-201 has on, but it has no drive/);
    // A switch drawn as a bubble symbol with on: nothing would show it.
    const sw = meaningWarnings(items([{ type: "symbol", symbol: "pressure_switch", x: 30, y: 50, size: 8, on: "PLC_PRG.xPressureOk", label: "PS-201" }]));
    expect(sw).toHaveLength(1);
    expect(sw[0]).toMatch(/^pressure_switch PS-201 has on, which a bubble symbol doesn't show: draw it as \{type: 'instrument', tag: 'PS-201'/);
    // A real instrument (TT-201) and a driven motor are fine; connectionWarnings carries these notes too.
    expect(connectionWarnings(list, 0.5).some((m) => m.includes("TCV-201 opening"))).toBe(true);
  });

  it("the symbol sheet prints an instrument bubble's letters, as a screen does", () => {
    const { html } = symbolSheet([["level_switch", BUILTIN_SYMBOLS.level_switch], ["pressure_switch", BUILTIN_SYMBOLS.pressure_switch], ["filter", BUILTIN_SYMBOLS.filter]]);
    expect(html).toMatch(/class="inst-fn"[^>]*>LS</);
    expect(html).toMatch(/class="inst-fn"[^>]*>PS</);
    expect(html.match(/class="inst-fn"/g)).toHaveLength(2);
  });

  it("shows a tripped switch by the condition badge at its bubble, never by colouring it, in the browser and CODESYS", () => {
    const s = screenSchema.parse({ name: "P", title: "P", widgets: [{ type: "process", at: [1, 1, 12, 8], items: [
      { type: "pipe", from: [0, 60], to: [100, 60] },
      { type: "instrument", tag: "PSL-201", x: 30, y: 40, at: [30, 60], on: "PLC_PRG.xPressureLow", tone: "alarm" },
      { type: "instrument", tag: "LSH-201", x: 60, y: 40, at: [60, 60], on: "PLC_PRG.xHighLevel" },
      { type: "instrument", tag: "TT-201", x: 80, y: 40, at: [80, 60], value: "PLC_PRG.rTemp", unit: "°C" },
    ] }] });
    const { html, bindings } = renderScreen(s);
    // The bubble is never bound or tinted; the badge carries the state.
    expect(html).not.toMatch(/<g class="inst[^"]*" data-b/);
    expect(HMI_CSS).not.toContain(".inst.on");
    expect(bindings).toContainEqual({ kind: "fault", v: "PLC_PRG.xPressureLow" });
    expect(bindings).toContainEqual({ kind: "on", v: "PLC_PRG.xHighLevel" });
    expect(html.match(/<g class="cb"/g)).toHaveLength(2);
    const plan = nativePlan(s);
    const sign = (kind: string, v: string) => plan.elements.find((e) => String(e.props?.["Static ID"]).includes(`.sign_${kind}_`) && e.invisible === `NOT (${v})`);
    expect(sign("alarm", "PLC_PRG.xPressureLow")).toBeDefined();
    expect(sign("warning", "PLC_PRG.xHighLevel")).toBeDefined();
    expect(plan.elements.some((e) => e.kind === "circle" && e.props?.["Color variables.Toggle color"])).toBe(false);
    // A pressure switch symbol without a tag prints PS (ISA-5.1), not PI.
    const sym = renderScreen(screenSchema.parse({ name: "P", title: "P", widgets: [{ type: "process", at: [1, 1, 12, 8], items: [{ type: "symbol", symbol: "pressure_switch", x: 50, y: 50, size: 8 }] }] })).html;
    expect(sym).toContain(">PS<");
    expect(sym).not.toContain(">PI<");
  });

  it("gives an alarm's message room in a narrow alarms card in CODESYS (time and state on a second line)", () => {
    const s = screenSchema.parse({ name: "A", title: "A", widgets: [{ type: "alarms", at: [10, 1, 3, 4], items: [{ active: "PLC_PRG.xClog", text: "Filter F-201 clogged", severity: "warning" }] }] });
    const plan = nativePlan(s, [], {}, { "PLC_PRG.xClog": 1 });
    const msg = plan.elements.filter((e) => e.text === "Filter F-201 clogged");
    expect(msg.length).toBeGreaterThan(0);
    for (const m of msg) expect(m.w).toBeGreaterThan(120);
  });

  it("splits a long page title over two lines that fit the CODESYS rail", async () => {
    const { railLines } = await import("../src/hmi/native.js");
    expect(railLines("Heat treatment line", 64, 11).map((l) => l[1])).toEqual(["Heat", "treatment line"]);
    expect(railLines("Alarms", 64, 11)).toEqual([[0, "Alarms", 11]]);
    const [, , fs] = railLines("Wärmebehandlungslinie", 64, 11)[0]!;
    expect(fs).toBeLessThan(11);
  });
});

describe("P&ID sheet (hmi_pid)", () => {
  const s = screenSchema.parse({
    name: "Process",
    title: "Heat treatment",
    subtitle: "Line B",
    widgets: [
      {
        type: "process",
        title: "Process",
        at: [1, 1, 12, 8],
        items: [
          { type: "tank", x: 10, y: 20, w: 12, h: 50, level: "PLC_PRG.rLevel", label: "T-1" },
          { type: "pump", x: 40, y: 75, size: 8, running: "PLC_PRG.xRun", label: "P-1" },
          { type: "symbol", symbol: "control_valve", x: 70, y: 75, size: 8, on: "PLC_PRG.xOpen", value: "PLC_PRG.rPos", unit: "%", label: "TCV-1" },
          { type: "sensor", x: 55, y: 60, value: "PLC_PRG.rTemp", label: "TT-1" },
          { type: "pipe", from: "T-1.right", to: "P-1.in" },
          { type: "pipe", from: "P-1.out", to: "TCV-1.in" },
          { type: "pipe", from: "TCV-1.out", to: [100, 75], label: "Out" },
          { type: "pipe", from: "TT-1.c", to: "TCV-1.actuator", signal: true },
        ],
      },
    ],
  });

  it("draws the diagram on an A3 sheet with a legend of what it uses and a title block, nothing live", async () => {
    const { pidSheet, processOf, PID_SIZE } = await import("../src/hmi/pid.js");
    const w = processOf(s)!;
    expect(processOf(s, "process")).toBe(w);
    expect(processOf(s, "Other")).toBeUndefined();
    const { svg, symbols } = pidSheet(s, w, BUILTIN_SYMBOLS, { drawing: "PID-1", revision: "B", date: "2026-11-15" });
    expect(symbols).toEqual(["Vessel", "Centrifugal pump", "Control valve", "Instrument (ISA-5.1)", "Process line", "Signal line"]);
    expect(svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" class="pid" width="${PID_SIZE.w}" height="${PID_SIZE.h}"`));
    for (const t of ["Heat treatment", "Line B", "PID-1", ">B<", "2026-11-15", "HMI screen &#39;Process&#39;", "LEGEND"]) expect(svg).toContain(t);
    // A drawing, not an HMI: values, state signs and levels are hidden, valves hollow.
    expect(svg).toMatch(/\.pid \.tank-liq,[^{]*\.pid \.rs,[^{]*\.pid \.p-val[^{]*\{display:none\}/);
    expect(svg).toContain(".pid .sym.vlv{--state:#fff}");
    expect(svg).not.toContain("data-b=");
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
    expect(all).toContain("level_switch LS-1 isn't beside a tank");
    expect(all).toContain("sensor TT-1 isn't next to a pipe or tank");
    expect(all).toContain("pipe 10 ends at [60, 50], in the middle of the diagram");
    expect(all).not.toContain("P-1");
  });

  it("is quiet for a connected line, and the built-in templates pass", () => {
    const ok = P([
      { type: "tank", x: 5, y: 20, w: 10, h: 50, level: "a", label: "T-1" },
      { type: "symbol", symbol: "level_switch", x: 19, y: 25, size: 4, label: "LS-1" },
      { type: "pump", x: 30, y: 80, size: 8, running: "b", label: "P-1" },
      { type: "symbol", symbol: "motor", x: 30, y: 68, size: 6, rotate: 90, label: "M-1" },
      { type: "sensor", x: 45, y: 74, value: "c", label: "PT-1" },
      { type: "pipe", from: [0, 25], to: "T-1.left-high" },
      { type: "pipe", from: "T-1.right", to: "P-1.in" },
      { type: "pipe", from: "P-1.out", to: [100, 80] },
    ]);
    expect(connectionWarnings(ok, 0.5)).toEqual([]);
    // An instrument drawn inside the vessel is wrong (ISA-5.1: outside, joined to its nozzle).
    const inside = P([{ type: "tank", x: 5, y: 20, w: 10, h: 50, level: "a", label: "T-1" }, { type: "instrument", tag: "LSH-1", x: 10, y: 25 }, { type: "symbol", symbol: "level_switch", x: 10, y: 40, size: 4, label: "LS-2" }]);
    const msgs = connectionWarnings(inside, 0.5).join(" ");
    expect(msgs).toContain("instrument LSH-1 is drawn inside tank T-1");
    expect(msgs).toContain("level_switch LS-2 is drawn inside tank T-1");
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
    const spots = labelSpots(items, 0.5);
    expect(spots.get("t-1")?.side).toBe("below-left");
    expect(spots.get("m-1")?.side).toBe("beside");
    expect(spots.has("m-2")).toBe(false);
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
    expect(portsOf(items[1]!, 0.5).in).toEqual({ at: [55.9, 71], dir: "l" }); // the inlet on the casing, inside the nozzle's box
    expect(portsOf(items[2]!, 0.5).in).toEqual({ at: [85, 48], dir: "d" }); // vertical: 4 x units = 8 y units at aspect 0.5
  });

  it("routes pipes with right angles from port to port", () => {
    const [, , , a, b, c] = items;
    expect(routePipe(a as never, items, 0.5)).toEqual([[40, 71], [55.9, 71]]); // same height: straight
    expect(routePipe(b as never, items, 0.5)).toEqual([[64.1, 71], [85, 71], [85, 48]]); // out on the axis (ISO 10628-2 2322), right, up into the valve
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
    const ack = withIdx.elements.find((e) => e.click?.includes("m_xToAcknowledge"))!;
    expect(ack.click).toBe("__Alm__GVL.g_inst.gen_Inst_AG_HMI_AlarmGroup.gen_ArrAllAlarms[0].m_xToAcknowledge := TRUE;");
    expect(ack.invisible).toMatch(/^NOT PRG_HMI_Overview\.xAk\d+$/);
    // The acknowledge button shows a tick, hidden with it.
    expect(withIdx.elements.find((e) => e.kind === "image" && String(e.props?.["Static ID"]).includes(".ic_check_") && e.invisible === ack.invisible)).toBeDefined();
    expect(withIdx.elements.find((e) => e.text === "No active alarms")!.invisible).toMatch(/PRG_HMI_Overview\.xAo\d+/);
  });

  it("scales bars and tank levels in the helper program and binds them", () => {
    expect(plan.helper.implementation).toMatch(/ANY_TO_REAL\(PLC_PRG\.rLevel\)/);
    const moving = flat(plan.elements).filter((e) => e.props && Object.keys(e.props).some((k) => k.startsWith("Relative movement")));
    expect(moving.length).toBeGreaterThanOrEqual(1); // the tank fill (the gauge is pictures now)
    for (const e of moving) for (const v of Object.values(e.props!)) if (typeof v === "string" && v.startsWith("PRG_HMI_")) expect(plan.helper.declaration).toContain(v.split(".")[1]!);
  });

  it("uses SVG symbols for pumps, with buttons, alarms and texts bound to the program", () => {
    const pump = plan.elements.find((e) => e.kind === "image" && String(e.props?.["Static ID"]).includes(".pump_off_"))!;
    // one SVG per symbol size, drawn at exactly the box's size: stopped and running, no turning frames (ISA-101)
    expect(plan.images.filter((i) => i.id.startsWith("pump")).map((i) => i.id).sort()).toEqual([`pump_off_${pump.w}`, `pump_on_${pump.w}`]);
    for (const i of plan.images.filter((x) => x.id.startsWith("pump"))) expect(i.svg).toMatch(new RegExp(`^<svg xmlns="http://www.w3.org/2000/svg" width="${pump.w}" height="${pump.w}"`));
    expect(pump.props!["Static ID"]).toBe(`IP_Overview.pump_off_${pump.w}`);
    expect(pump.props!["Bitmap ID variable.Bitmap ID"]).toBe(`SEL(PLC_PRG.xRun, 'IP_Overview.pump_off_${pump.w}', 'IP_Overview.pump_on_${pump.w}')`);
    expect(plan.elements.some((e) => e.text === "Start")).toBe(true);
    expect(plan.elements.find((e) => e.props?.["Input configuration.Tap.Variable"] === "PLC_PRG.xStart")!.fill).toBeNull();
    expect(flat(plan.elements).find((e) => e.invisible === "NOT PLC_PRG.xHigh" && e.text)!.text).toMatch(/High level <T-101>/);
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
    expect(plan.elements.some((e) => e.text === "History")).toBe(true);
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
    expect(contrast.html).toContain("--bg:#000000;--surface:#000000;--surface2:#111111;--line:#ffffff;--fg:#ffffff");
    const red = renderScreen(screenSchema.parse({ ...SCREEN, accent: "#e30613" }));
    expect(red.html).toMatch(/--accent:#e30613;--accent-soft:#[0-9a-f]{6};--on-accent:#ffffff/);
    const yellow = renderScreen(screenSchema.parse({ ...SCREEN, accent: "#ffd400" }));
    expect(yellow.html).toMatch(/--accent:#ffd400;--accent-soft:#[0-9a-f]{6};--on-accent:#111820/);
    expect(() => screenSchema.parse({ ...SCREEN, accent: "red" })).toThrow();
  });

  it("a tank's level number reads on the liquid without a halo, and no unlabelled scale marks", () => {
    // WCAG 2 contrast: the number is large text (3:1); the contrast theme keeps 4.5:1.
    const lum = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    for (const [name, t] of Object.entries(THEMES)) {
      expect(ratio(t.text, t.liquid), name).toBeGreaterThanOrEqual(name === "contrast" ? 4.5 : 3);
      expect(ratio(t.liquid, t.surface), name).toBeGreaterThanOrEqual(1.5);
    }
    const html = renderScreen(screenSchema.parse({ ...SCREEN, widgets: [{ type: "process", at: [1, 1, 12, 8], items: [{ type: "tank", x: 10, y: 10, w: 10, h: 60, level: "PLC_PRG.rLevel", label: "T-1" }] }] })).html;
    expect(HMI_CSS.match(/\.tank-num\{[^}]*\}/)![0]).not.toContain("stroke");
    // Ticks at a quarter and three quarters had no labels and read as stray lines inside the vessel.
    expect(html).not.toContain("tank-ticks");
  });

  it("a status item can say what it is while off ('XV-101 closed', not a greyed 'XV-101 open')", () => {
    const items = [{ label: "XV-101 open", off: "XV-101 closed", on: "GVL_IO.xValveA" }, { label: "P-201 running", on: "GVL_IO.xPump" }];
    const screen = screenSchema.parse({ ...SCREEN, widgets: [{ type: "status", title: "Equipment", at: [1, 1, 4, 3], items }] });
    const html = renderScreen(screen).html;
    expect(html).toContain('<span class="l-on">XV-101 open</span><span class="l-off">XV-101 closed</span>');
    expect(html).toContain("<span>P-201 running</span>");
    expect(HMI_CSS).toContain(".led .l-on,.led.on .l-off{display:none}.led.on .l-on{display:inline}");
    // In CODESYS: one text each, hidden by the state.
    const els = nativePlan(screen, [{ name: "Overview", title: "A" }]).elements as NativeElement[];
    expect(els.find((e) => e.text === "XV-101 open")!.invisible).toBe("NOT (GVL_IO.xValveA)");
    expect(els.find((e) => e.text === "XV-101 closed")!.invisible).toBe("GVL_IO.xValveA");
  });

  it("a native setpoint card's actual value leaves room for its unit", () => {
    const screen = screenSchema.parse({ ...SCREEN, widgets: [{ type: "setpoint", title: "Ingredient A", at: [1, 5, 3, 2], variable: "GVL.rSet", actual: "GVL.rAct", min: 0, max: 900, step: 10, unit: "kg" }] });
    const els = nativePlan(screen, [{ name: "Overview", title: "A" }]).elements as NativeElement[];
    const num = els.find((e) => e.text === "%.1f" && String(e.props?.["Text variables.Text variable"] ?? "").length > 0)!;
    const unit = els.find((e) => e.text === "kg" && e.y > num.y)!;
    const minus = els.find((e) => e.text === "−")!;
    // The unit's text starts and (at its size) ends before the − button.
    const unitFs = Number(String(unit.font?.[1] ?? "").replace(/\D+$/, "")) || 12;
    expect(unit.x + 2 * unitFs).toBeLessThanOrEqual(minus.x);
  });

  it("a tank shows its fault and warning as the condition badge, in the browser and natively", () => {
    const items = [{ type: "tank", x: 10, y: 10, w: 10, h: 60, level: "PLC_PRG.rLevel", label: "T-1", fault: "PLC_PRG.xTankFault", warning: "PLC_PRG.xTankWarn" }];
    const screen = screenSchema.parse({ ...SCREEN, widgets: [{ type: "process", at: [1, 1, 12, 8], items }] });
    const r = renderScreen(screen);
    const bound = JSON.stringify(r.bindings);
    expect(bound).toContain("PLC_PRG.xTankFault");
    expect(bound).toContain("PLC_PRG.xTankWarn");
    expect(r.html.match(/class="cb/g)?.length).toBeGreaterThanOrEqual(1);
    const plan = nativePlan(screen, [{ name: "Overview", title: "A" }]);
    expect(JSON.stringify(plan.elements)).toContain("PLC_PRG.xTankFault");
  });

  it("a native tank's liquid reaches the vessel's rounded bottom", () => {
    const items = [{ type: "tank", x: 10, y: 10, w: 10, h: 60, level: "PLC_PRG.rLevel", max: 100, label: "T-1" }];
    const screen = screenSchema.parse({ ...SCREEN, widgets: [{ type: "process", at: [1, 1, 12, 8], items }] });
    const plan = nativePlan(screen, [{ name: "Overview", title: "A" }]);
    const helper = plan.helper.implementation;
    const els = plan.elements as NativeElement[];
    const i = els.findIndex((e) => e.kind === "rect" && e.props?.["Relative movement.Movement bottom-right.Y"]);
    const [vessel, liquid, strip, line] = [els[i - 2]!, els[i - 1]!, els[i]!, els[i + 1]!];
    // The liquid is the vessel's shape inside its line, down to its rounded bottom.
    expect(liquid).toMatchObject({ kind: "round", x: vessel.x + 1, y: vessel.y + 1, w: vessel.w - 2, h: vessel.h - 2, radius: vessel.radius! - 1 });
    expect(liquid.fill).not.toEqual(vessel.fill);
    // A strip in the tile's colour covers the empty part from the top, growing down by (1 - level / max).
    expect(strip).toMatchObject({ x: vessel.x + 1, y: vessel.y, w: vessel.w - 2, h: 1, fill: vessel.fill });
    const v = String(strip.props!["Relative movement.Movement bottom-right.Y"]).split(".").pop();
    expect(helper).toContain(`${v} := REAL_TO_INT(LIMIT(0.0, (ANY_TO_REAL(PLC_PRG.rLevel) - (100.0)) / (-100.0), 1.0) * ${vessel.h - 1}.0);`);
    // The vessel's line is drawn over both.
    expect(line).toMatchObject({ kind: "round", x: vessel.x, y: vessel.y, w: vessel.w, h: vessel.h, fill: null });
  });

  it("a machine state can show while its BOOL is FALSE (invert)", () => {
    const screen = screenSchema.parse({ ...SCREEN, machine: { states: [{ on: "PLC_PRG.xAuto", invert: true, text: "Manual", tone: "accent" }] } });
    expect(JSON.stringify(renderScreen(screen).bindings)).toContain('"invert":true');
    const plan = nativePlan(screen, [{ name: "Overview", title: "A" }]);
    expect(plan.helper.implementation).toContain("IF NOT (PLC_PRG.xAuto) THEN iMachine := 1;");
  });

  it("a top-bar value without decimals or unit shows as text natively (a STRING step name)", () => {
    const screen = screenSchema.parse({ ...SCREEN, info: [{ label: "Step", value: "GVL_Batch.sStep" }, { label: "Weight", value: "GVL_Batch.rWeight", unit: "kg", decimals: 1 }] });
    const plan = nativePlan(screen, [{ name: "Overview", title: "A" }]);
    expect(plan.helper.implementation).toMatch(/sV\d+ := TO_STRING\(GVL_Batch\.sStep\);/);
    expect(plan.helper.implementation).toMatch(/rV\d+ := ANY_TO_REAL\(GVL_Batch\.rWeight\);/);
    expect(plan.elements.some((e) => e.text === "%s")).toBe(true);
  });

  it("notes value cards too small for their number", () => {
    const small = screenSchema.parse({ ...SCREEN, widgets: [{ type: "value", title: "A", at: [1, 1, 2, 1], value: "PLC_PRG.rA", set: "PLC_PRG.rSetA", unit: "kg" }] });
    const notes = cardWarnings(small);
    expect(notes.join(" ")).toMatch(/runs into the title/);
    expect(notes.join(" ")).toMatch(/Actual and Set overlap/);
    const fine = screenSchema.parse({ ...SCREEN, widgets: [{ type: "value", title: "A", at: [1, 1, 4, 3], value: "PLC_PRG.rA", set: "PLC_PRG.rSetA", unit: "kg" }] });
    expect(cardWarnings(fine)).toEqual([]);
  });

  it("a tank's name inside the vessel has the text colour; other names stay quiet", () => {
    const items = [{ type: "tank", x: 10, y: 10, w: 10, h: 60, level: "PLC_PRG.rLevel", label: "T-1" }, { type: "pump", x: 60, y: 50, running: "PLC_PRG.xRun", label: "P-1" }];
    const screen = screenSchema.parse({ ...SCREEN, widgets: [{ type: "process", at: [1, 1, 12, 8], items }] });
    const html = renderScreen(screen).html;
    expect(html).toMatch(/class="p-label left in-vessel"[^>]*>T-1</);
    expect(html).toMatch(/class="p-label left"[^>]*>P-1</);
    expect(HMI_CSS).toContain(".p-label.in-vessel{fill:var(--fg)}");
    const plan = nativePlan(screen, [{ name: "Overview", title: "A" }]);
    const pal = paletteFor(screen);
    expect(plan.elements.find((e) => e.text === "T-1")!.color).toBe(pal.text);
    expect(plan.elements.find((e) => e.text === "P-1")!.color).toBe(pal.muted);
  });

  it("the native palette follows the theme and the brand colour", () => {
    expect(paletteFor({ theme: "contrast" }).bg).toBe(0xff000000);
    expect(paletteFor({ theme: "contrast" }).border).toBe(0xffffffff);
    expect(paletteFor({ theme: "light", accent: "#e30613" }).tones.accent).toBe(0xffe30613);
    expect(paletteFor({ theme: "dark" }).tones.accent).toBe(0xff00bde3);
    expect(onColor(0xffe30613)).toBe(0xffffffff);
    expect(onColor(0xffffd400)).toBe(0xff111820);
    const plan = nativePlan(screenSchema.parse({ ...SCREEN, theme: "contrast", accent: "#e30613" }), [{ name: "Overview", title: "A" }, { name: "Other", title: "B" }]);
    // The rail: the current page marked in the brand colour, the other one a link.
    expect(plan.elements.find((e) => e.kind === "round" && e.x === 0 && e.w === 3)!.fill).toBe(0xffe30613);
    expect(plan.elements.find((e) => e.text === "A")!.color).toBe(0xffe30613);
    expect(plan.elements.find((e) => e.name === "Nav_Other")!.goto).toBe("Visu_Other");
    expect(plan.elements.find((e) => e.name === "Nav_Overview")).toBeUndefined();
  });

  it("native pipes with flow turn dark, still (no moving dashes: ISA-101)", () => {
    const plan = nativePlan(screenSchema.parse(SCREEN));
    const pipes = plan.elements.filter((e) => e.props?.["Color variables.Toggle color"] === "PLC_PRG.xRun" && e.kind === "round" && e.fill === paletteFor({}).pipe);
    expect(pipes.length).toBeGreaterThan(0);
    expect(plan.elements.some((e) => Object.keys(e.props ?? {}).some((k) => k.startsWith("Relative movement.") && String(e.props![k]).includes("iFlow")))).toBe(false);
    expect(plan.helper.declaration).not.toContain("iFlow");
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

  it("exports the process diagram as a P&ID sheet next to the project", async () => {
    const r = await call("hmi_pid", { screen: "Overview", drawing: "PID-100-01", format: "svg" });
    expect(r.isError).toBe(false);
    const file = /as (.+\.pid\.svg) \(A3/.exec(r.text)![1]!;
    expect(file).toMatch(/\.Overview\.pid\.svg$/);
    const svg = readFileSync(file, "utf8");
    expect(svg).toContain("PID-100-01");
    expect(svg).toContain("Centrifugal pump");
    expect((await call("hmi_pid", { screen: "Overview", diagram: "Nope" })).text).toMatch(/has no process diagram titled 'Nope'/);
  });

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
    expect(list.text).toMatch(/heat_exchanger: Heat exchanger \(general\), ISO 10628-2 X8079/);
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
