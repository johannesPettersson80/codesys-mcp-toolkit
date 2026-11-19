/** Process-diagram symbols: the library, the SVG check, import, ports, and both renderers. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativePlan } from "../src/hmi/native.js";
import { renderScreen } from "../src/hmi/render.js";
import { routed, routePipe, routeProblems, overlapWarnings } from "../src/hmi/route.js";
import { HmiService } from "../src/hmi/service.js";
import { layoutProblems, screenSchema, screenVariables, type ProcessItem } from "../src/hmi/spec.js";
import { BUILTIN_SYMBOLS, importSvg, svgProblems, symbolPicture, symbolPorts, symbolSchema } from "../src/hmi/symbols.js";
import type { AppContext } from "../src/tools.js";

const items = (xs: unknown[]) => screenSchema.parse({ name: "S", title: "S", widgets: [{ type: "process", at: [1, 1, 8, 5], items: xs }] }).widgets[0]! as { items: ProcessItem[] };

describe("the standard symbols", () => {
  it("all pass the SVG check, with their ports on their box", () => {
    expect(Object.keys(BUILTIN_SYMBOLS).length).toBeGreaterThanOrEqual(11);
    for (const [name, d] of Object.entries(BUILTIN_SYMBOLS)) {
      expect(svgProblems(d.svg), name).toEqual([]);
      for (const [k, p] of Object.entries(d.ports)) {
        expect(p.x, `${name}.${k}`).toBeGreaterThanOrEqual(0);
        expect(p.x, `${name}.${k}`).toBeLessThanOrEqual(d.viewBox[0]);
        expect(p.y, `${name}.${k}`).toBeLessThanOrEqual(d.viewBox[1]);
      }
    }
  });
});

describe("custom symbol SVG", () => {
  it("accepts shapes, gradients, text, the colour variables and spin", () => {
    const ok = `<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><g class="spin"><rect x="1" y="2" width="3" height="4" fill="url(#g)" stroke="var(--state)"/></g><text x="5" y="5" font-size="8">P1</text>`;
    expect(svgProblems(ok)).toEqual([]);
  });

  it.each([
    ["a script", `<script>alert(1)</script>`, /<script> is not allowed/],
    ["an event handler", `<rect onload="x()" width="1" height="1"/>`, /onload/],
    ["a style attribute", `<rect style="fill:red" width="1" height="1"/>`, /style/],
    ["a link", `<a href="http://x"><rect/></a>`, /<a> is not allowed/],
    ["an external url", `<rect fill="url(http://x/y)"/>`, /character or word|url\(#id\)/],
    ["an image", `<image href="x.png"/>`, /<image> is not allowed/],
    ["foreignObject", `<foreignObject><div/></foreignObject>`, /foreignObject/],
    ["a comment", `<!-- hi --><rect/>`, /can't read/],
    ["an unknown variable", `<rect fill="var(--evil)"/>`, /colour variables/],
    ["another class", `<g class="big"/>`, /class may only be "spin"/],
    ["an unclosed element", `<g><rect/>`, /never closed/],
    ["javascript in a value", `<rect transform="javascript(1)"/>`, /isn't allowed/],
  ])("refuses %s", (_, svg, msg) => {
    expect(svgProblems(svg).join(" ")).toMatch(msg);
  });

  it("imports an editor's SVG file: viewBox, no metadata, style as attributes", () => {
    const file = `<?xml version="1.0"?>
<!-- Created with Inkscape -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="64" height="32" viewBox="10 20 64 32" version="1.1">
  <metadata><rdf:RDF/></metadata>
  <sodipodi:namedview id="nv" pagecolor="#fff"/>
  <title>Centrifuge</title>
  <g inkscape:label="Layer 1" inkscape:groupmode="layer" id="layer1">
    <rect style="fill:#334155;stroke:#22c55e;stroke-width:2;mix-blend-mode:normal" x='12' y="22" width="60" height="28" rx="4"/>
  </g>
</svg>`;
    const r = importSvg(file);
    expect(r.viewBox).toEqual([64, 32]);
    expect(r.svg).not.toMatch(/metadata|namedview|inkscape|style=|title/);
    expect(r.svg).toMatch(/fill="#334155" stroke="#22c55e" stroke-width="2"/);
    expect(r.svg).toMatch(/^<g transform="translate\(-10 -20\)">/);
    expect(svgProblems(r.svg)).toEqual([]);
  });
});

describe("symbols on a diagram", () => {
  it("place their ports with size, rotation and the diagram's aspect", () => {
    const hx = BUILTIN_SYMBOLS.heat_exchanger!;
    expect(symbolPorts(hx, { x: 50, y: 50, size: 20 }, 0.5).in).toEqual({ at: [42, 50], dir: "l" }); // on the circle
    const turned = symbolPorts(hx, { x: 50, y: 50, size: 20, rotate: 90 }, 0.5).in!;
    expect(turned.dir).toBe("u");
    expect(turned.at[0]).toBeCloseTo(50);
    expect(turned.at[1]).toBeCloseTo(34); // 8 x units up (on the circle) = 16 y units at aspect 0.5
  });

  it("route pipes to symbol ports, and name unknown symbols and ports", () => {
    const w = items([
      { type: "symbol", symbol: "heat_exchanger", label: "E-201", x: 50, y: 50, size: 20 },
      { type: "pipe", from: [0, 50], to: "E-201.in" },
      { type: "pipe", from: "E-201.out", to: "E-201.side" },
      { type: "symbol", symbol: "centrifuge", x: 10, y: 10 },
    ]);
    const problems = routeProblems(w.items);
    expect(problems.join(" ")).toMatch(/heat_exchanger 'E-201' has no port 'side' \(ports: in, out, top, bottom\)/);
    expect(problems.join(" ")).toMatch(/no symbol 'centrifuge' in the library/);
    const pts = routePipe(w.items[1] as Extract<ProcessItem, { type: "pipe" }>, w.items, 0.5);
    expect(pts.at(-1)).toEqual([42, 50]);
  });

  it("know the project's own symbols, and warn when symbols overlap", () => {
    const own = { centrifuge: symbolSchema.parse({ svg: `<circle cx="50" cy="50" r="40" fill="var(--state)"/>`, ports: { in: { x: 10, y: 50, dir: "left" } } }) };
    const w = items([{ type: "symbol", symbol: "centrifuge", label: "C-1", x: 30, y: 50, size: 20 }, { type: "symbol", symbol: "filter", x: 38, y: 50, size: 12 }, { type: "symbol", symbol: "motor", x: 20, y: 50, size: 12 }, { type: "pipe", from: [0, 50], to: "C-1.in" }]);
    expect(routeProblems(w.items, { ...BUILTIN_SYMBOLS, ...own })).toEqual([]);
    expect(overlapWarnings(w.items, 0.5, { ...BUILTIN_SYMBOLS, ...own }).join(" ")).toMatch(/centrifuge C-1 overlaps filter/);
    // A motor touches the machine it drives: no overlap warning for it.
    expect(overlapWarnings(w.items, 0.5, { ...BUILTIN_SYMBOLS, ...own }).join(" ")).not.toMatch(/motor \S+ overlaps|overlaps motor/);
  });

  it("route pipes round equipment they aren't connected to, and name a pipe that can't", () => {
    // The MixingUnit take's first diagram (aspect 0.45): two feed tanks with vertical valves
    // under them, both into the mixing tank's top. XV-101's line ran through XV-102.
    const lib = BUILTIN_SYMBOLS;
    const take = items([
      { type: "tank", label: "T-101", level: "GVL.r", x: 4, y: 6, w: 12, h: 26 },
      { type: "tank", label: "T-102", level: "GVL.r", x: 24, y: 6, w: 12, h: 26 },
      { type: "valve", label: "XV-101", open: "GVL.x", x: 10, y: 40, size: 7, vertical: true },
      { type: "valve", label: "XV-102", open: "GVL.x", x: 30, y: 40, size: 7, vertical: true },
      { type: "tank", label: "T-201", level: "GVL.r", x: 50, y: 46, w: 18, h: 42 },
      { type: "pipe", from: "T-101.bottom", to: "XV-101.in" },
      { type: "pipe", from: "T-102.bottom", to: "XV-102.in" },
      { type: "pipe", from: "XV-101.out", to: "T-201.top" },
      { type: "pipe", from: "XV-102.out", to: "T-201.top" },
    ]);
    // The valves sit against the tanks' bottoms, so every level between them crosses XV-102:
    // there is no way round, and the save names it instead of drawing it silently.
    expect(overlapWarnings(take.items, 0.45, lib).join(" ")).toMatch(/pipe 8 \(XV-101\.out to T-201\.top\) runs through valve XV-102/);
    // With room, the vertical run moves off the valve in its way.
    const room = items([
      { type: "valve", label: "XV-1", open: "GVL.x", x: 10, y: 30, size: 6 },
      { type: "valve", label: "XV-2", open: "GVL.x", x: 41.5, y: 50, size: 6, vertical: true },
      { type: "tank", label: "T-1", level: "GVL.r", x: 70, y: 20, w: 16, h: 58.8 },
      { type: "pipe", from: "XV-1.out", to: "T-1.left" },
    ]);
    const around = routePipe(room.items[3] as Extract<ProcessItem, { type: "pipe" }>, room.items, 0.45);
    expect(around.some((p) => Math.abs(p[0] - 41.5) < 1e-6)).toBe(false);
    expect(overlapWarnings(room.items, 0.45, lib).join(" ")).not.toMatch(/runs through/);
    // A straight run blocked by a valve on it steps round it.
    const straight = items([
      { type: "valve", label: "XV-1", open: "GVL.x", x: 10, y: 50, size: 6 },
      { type: "valve", label: "XV-2", open: "GVL.x", x: 40, y: 50, size: 6 },
      { type: "tank", label: "T-1", level: "GVL.r", x: 70, y: 20, w: 16, h: 35.3 },
      { type: "pipe", from: "XV-1.out", to: "T-1.left" },
    ]);
    const pts = routePipe(straight.items[3] as Extract<ProcessItem, { type: "pipe" }>, straight.items, 0.45);
    expect(pts.length).toBeGreaterThan(2);
    expect(overlapWarnings(straight.items, 0.45, lib).join(" ")).not.toMatch(/runs through/);
    // Wall to wall: no way round, so it is named.
    const blocked = items([
      { type: "tank", label: "T-1", level: "GVL.r", x: 0, y: 0, w: 10, h: 100 },
      { type: "tank", label: "T-2", level: "GVL.r", x: 40, y: 0, w: 10, h: 100 },
      { type: "tank", label: "T-3", level: "GVL.r", x: 80, y: 0, w: 10, h: 100 },
      { type: "pipe", from: "T-1.right", to: "T-3.left" },
    ]);
    expect(overlapWarnings(blocked.items, 0.45, lib).join(" ")).toMatch(/pipe 4 \(T-1\.right to T-3\.left\) runs through tank T-2/);
  });

  it("seat an agitator on its tank, motor on the top", () => {
    const w = items([
      { type: "tank", label: "T-201", level: "GVL.r", x: 50, y: 26, w: 16, h: 60 },
      { type: "symbol", symbol: "mixer", label: "M-201", x: 58, y: 60, size: 12 },
    ]);
    const m = routed(w.items, 0.45).find((p) => p.type === "symbol")! as Extract<ProcessItem, { type: "symbol" }>;
    const h = 12 / 0.45;
    expect(m.y - h / 2 + 0.3 * h).toBeCloseTo(26); // the motor's circle ends on the tank's top
  });

  const screen = screenSchema.parse({
    name: "Plant",
    title: "Plant",
    widgets: [{ type: "process", at: [1, 1, 8, 5], items: [{ type: "symbol", symbol: "motor", label: "M-1", x: 30, y: 50, size: 14, on: "PLC_PRG.xRun", fault: "PLC_PRG.xTrip", faceplate: { start: "PLC_PRG.xStart" } }, { type: "symbol", symbol: "conveyor", x: 65, y: 50, size: 30, rotate: 90, on: "PLC_PRG.xBelt" }] }],
  });

  it("bind their state variables", () => {
    expect(screenVariables(screen)).toEqual(expect.arrayContaining(["PLC_PRG.xRun", "PLC_PRG.xTrip", "PLC_PRG.xBelt", "PLC_PRG.xStart"]));
    expect(layoutProblems(screen)).toEqual([]);
  });

  it("render in the browser with the state signs, a faceplate and rotation", () => {
    const r = renderScreen(screen);
    expect(r.html).toMatch(/class="sym sym-motor"/);
    expect(r.html).toMatch(/rotate\(90\)/);
    expect(r.html).toMatch(/data-open="fp-1"/);
    expect(r.bindings).toEqual(expect.arrayContaining([{ kind: "on", v: "PLC_PRG.xRun" }, { kind: "fault", v: "PLC_PRG.xTrip" }, { kind: "on", v: "PLC_PRG.xBelt" }]));
    // The run state is the sign before the name, even without a name (the conveyor); the alarm a badge at the corner, not a red symbol (ISA-101).
    expect(r.html.match(/<g class="rs"/g)).toHaveLength(2);
    expect(r.html).toMatch(/class="cb"/);
    expect(r.css).not.toMatch(/\.fault \.sym\{/);
    expect(r.html).not.toMatch(/fault-mark|RUNNING|STOPPED/);
  });

  it("export to CODESYS as one picture per state, picked by the on variable, with the state signs", () => {
    const plan = nativePlan(screen);
    const img = plan.elements.find((e) => e.kind === "image" && String(e.props?.["Static ID"]).includes("sym_motor_off"))!;
    expect(img.props!["Bitmap ID variable.Bitmap ID"]).toBe(`SEL(PLC_PRG.xRun, 'IP_Plant.sym_motor_off_${img.w}x${img.h}', 'IP_Plant.sym_motor_on_${img.w}x${img.h}')`);
    const sign = (kind: string) => plan.elements.filter((e) => String(e.props?.["Static ID"]).includes(`.sign_${kind}_`));
    expect(sign("alarm").map((e) => e.invisible)).toEqual(["NOT (PLC_PRG.xTrip)"]);
    expect(sign("run").map((e) => e.invisible).sort()).toEqual(["NOT (PLC_PRG.xBelt)", "NOT (PLC_PRG.xRun)"]);
    const ids = plan.images.map((i) => i.id);
    expect(ids.filter((i) => i.startsWith("sym_motor_"))).toHaveLength(2);
    // The outline keeps 2 px at any size: the stroke is converted to box units for the picture's size.
    const motor = plan.images.find((i) => i.id.startsWith("sym_motor_on"))!.svg;
    expect(motor).not.toMatch(/vector-effect/);
    expect(motor).toContain(`stroke-width="${Math.round(2 * (100 / img.w) * 100) / 100}"`);
    expect(ids.some((i) => /^sym_conveyor_on_r90_\d+x\d+$/.test(i))).toBe(true);
    for (const i of plan.images.filter((x) => x.id.startsWith("sym_"))) expect(i.svg).not.toMatch(/var\(--/);
    expect(plan.images.find((i) => i.id.startsWith("sym_motor_on"))!.svg).toMatch(/#ffffff/); // the surface, whatever the state (the sign shows it)
    expect(plan.dialogs.map((d) => d.name)).toEqual(["Dlg_Plant_M_1"]);
    // A conveyor turned upright is taller than wide.
    const belt = plan.elements.find((e) => String(e.props?.["Static ID"]).includes("sym_conveyor"))!;
    expect(belt.h).toBeGreaterThan(belt.w);
  });

  it("draw a rotated picture in a box with width and height swapped", () => {
    const svg = symbolPicture(BUILTIN_SYMBOLS.conveyor!, "conveyor", { state: "#0f0", body: "#111", body2: "#222", line: "#999", accent: "#00f" }, 90, 30, 100);
    expect(svg).toMatch(/width="30" height="100" viewBox="0 0 60 200"/);
    expect(svg).toMatch(/<g transform="translate\(60 0\) rotate\(90\)">/);
  });
});

describe("the project's symbol library", () => {
  it("is stored next to the screens, and neither overwrites the other", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-sym-"));
    const hmi = new HmiService({ project: { path: join(dir, "Plant.project") } } as unknown as AppContext);
    const own = symbolSchema.parse({ svg: `<rect width="100" height="100" fill="var(--body)"/>`, description: "box" });
    hmi.save(screenSchema.parse({ name: "A", title: "A", widgets: [{ type: "text", at: [1, 1, 2, 2], text: "x" }] }));
    expect(hmi.saveSymbol("box", own).replaced).toBe(false);
    hmi.save(screenSchema.parse({ name: "B", title: "B", widgets: [{ type: "text", at: [1, 1, 2, 2], text: "y" }] }));
    expect(Object.keys(hmi.symbols())).toEqual(["box"]);
    expect(hmi.screens().map((s) => s.name)).toEqual(["A", "B"]);
    expect(hmi.page().symbols).toEqual({ box: own });
    expect(Object.keys(hmi.library())).toEqual(expect.arrayContaining(["motor", "box"]));
    expect(hmi.removeSymbol("box")).toBe(true);
    expect(hmi.page().symbols).toBeUndefined();
    expect(hmi.screens()).toHaveLength(2);
  });
});
