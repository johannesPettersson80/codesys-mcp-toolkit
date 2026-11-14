/** Process-diagram symbols: the library, the SVG check, import, ports, and both renderers. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nativePlan } from "../src/hmi/native.js";
import { renderScreen } from "../src/hmi/render.js";
import { routePipe, routeProblems, overlapWarnings } from "../src/hmi/route.js";
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
    expect(symbolPorts(hx, { x: 50, y: 50, size: 20 }, 0.5).in).toEqual({ at: [42.4, 50], dir: "l" });
    const turned = symbolPorts(hx, { x: 50, y: 50, size: 20, rotate: 90 }, 0.5).in!;
    expect(turned.dir).toBe("u");
    expect(turned.at[0]).toBeCloseTo(50);
    expect(turned.at[1]).toBeCloseTo(34.8); // 7.6 x units up = 15.2 y units at aspect 0.5
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
    expect(pts.at(-1)).toEqual([42.4, 50]);
  });

  it("know the project's own symbols, and warn when symbols overlap", () => {
    const own = { centrifuge: symbolSchema.parse({ svg: `<circle cx="50" cy="50" r="40" fill="var(--state)"/>`, ports: { in: { x: 10, y: 50, dir: "left" } } }) };
    const w = items([{ type: "symbol", symbol: "centrifuge", label: "C-1", x: 30, y: 50, size: 20 }, { type: "symbol", symbol: "motor", x: 38, y: 50, size: 12 }, { type: "pipe", from: [0, 50], to: "C-1.in" }]);
    expect(routeProblems(w.items, { ...BUILTIN_SYMBOLS, ...own })).toEqual([]);
    expect(overlapWarnings(w.items, 0.5, { ...BUILTIN_SYMBOLS, ...own }).join(" ")).toMatch(/centrifuge C-1 overlaps motor/);
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

  it("render in the browser with on and fault bindings, a faceplate and rotation", () => {
    const r = renderScreen(screen);
    expect(r.html).toMatch(/class="sym sym-motor"/);
    expect(r.html).toMatch(/rotate\(90\)/);
    expect(r.html).toMatch(/data-open="fp-1"/);
    expect(r.bindings).toEqual(expect.arrayContaining([{ kind: "on", v: "PLC_PRG.xRun" }, { kind: "fault", v: "PLC_PRG.xTrip" }, { kind: "on", v: "PLC_PRG.xBelt" }]));
    expect(r.css).toMatch(/\.fault \.sym\{--state:var\(--alarm\)/);
  });

  it("export to CODESYS as one picture per state, picked by the fault and on variables", () => {
    const plan = nativePlan(screen);
    const img = plan.elements.find((e) => e.kind === "image" && String(e.props?.["Static ID"]).includes("sym_motor_off"))!;
    expect(img.props!["Bitmap ID variable.Bitmap ID"]).toBe(`SEL(PLC_PRG.xTrip, SEL(PLC_PRG.xRun, 'IP_Plant.sym_motor_off_${img.w}x${img.h}', 'IP_Plant.sym_motor_on_${img.w}x${img.h}'), 'IP_Plant.sym_motor_fault_${img.w}x${img.h}')`);
    const ids = plan.images.map((i) => i.id);
    expect(ids.filter((i) => i.startsWith("sym_motor_"))).toHaveLength(3);
    expect(ids.some((i) => /^sym_conveyor_on_r90_\d+x\d+$/.test(i))).toBe(true);
    for (const i of plan.images.filter((x) => x.id.startsWith("sym_"))) expect(i.svg).not.toMatch(/var\(--/);
    expect(plan.images.find((i) => i.id.startsWith("sym_motor_on"))!.svg).toMatch(/#22c55e/);
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
