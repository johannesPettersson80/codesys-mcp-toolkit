/** CFC as elements and wires, on pages (page-oriented CFC) or not: checks, layout, the XML, and reading CODESYS's own export back. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfcChartSchema, cfcChartXml, planCfc, signalWidth, type CfcChart } from "../src/codesys/cfc.js";
import { describeGraphical } from "../src/codesys/graphical-read.js";

const fixture = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "graphical", `${n}.xml`), "utf8");

/** Two pages joined by a connection mark: start delay on page 1, a latch and a feedback loop on page 2. */
const paged: CfcChart = {
  pages: [{ name: "Start" }, { name: "Motor", description: "Latch and hold" }],
  elements: [
    { id: "start", input: "xStart", page: 1 },
    { id: "stop", input: "xStop", page: 1 },
    { id: "t2s", input: "T#2S", page: 1 },
    { id: "not1", box: "NOT", page: 1 },
    { id: "and1", box: "AND", page: 1 },
    { id: "tonDelay", box: "TON", instance: "tonDelay", page: 1 },
    { id: "run", mark: "Run", page: 1 },
    { id: "note1", comment: "Start after 2 s unless stopped", page: 1 },
    { id: "runIn", mark: "Run", page: 2 },
    { id: "fault", input: "xFault", page: 2 },
    { id: "rsLatch", box: "RS", instance: "rsLatch", page: 2 },
    { id: "motor", output: "xMotor", page: 2 },
    { id: "or1", box: "OR", page: 2 },
    { id: "hold", output: "xHold", page: 2 },
  ],
  wires: [
    { from: "stop", to: "not1.In1" },
    { from: "start", to: "and1.In1" },
    { from: "not1", to: "and1.In2" },
    { from: "and1", to: "tonDelay.IN" },
    { from: "t2s", to: "tonDelay.PT" },
    { from: "tonDelay.Q", to: "run" },
    { from: "runIn", to: "rsLatch.SET" },
    { from: "fault", to: "rsLatch.RESET1" },
    { from: "rsLatch.Q1", to: "motor" },
    { from: "runIn", to: "or1.In1" },
    { from: "or1", to: "or1.In2" },
    { from: "or1", to: "hold" },
  ],
};

const problems = (chart: CfcChart) => {
  try {
    planCfc(cfcChartSchema.parse(chart));
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("CFC chart checks", () => {
  it("accepts the two-page chart", () => {
    expect(problems(paged)).toBe("");
  });

  it("names every problem at once", () => {
    const m = problems({
      pages: [{}],
      elements: [
        { id: "a", input: "xA" },
        { id: "a", output: "xB" },
        { id: "both", input: "x", output: "y" },
        { id: "and1", box: "AND" },
        { id: "ton1", box: "TON", instance: "ton1" },
        { id: "far", input: "xF", page: 3 },
        { id: "lost", mark: "Nowhere" },
        { id: "o", output: "xO" },
      ],
      wires: [
        { from: "a", to: "and1.In2" },
        { from: "a", to: "ton1" },
        { from: "ghost", to: "o" },
        { from: "a", to: "o" },
        { from: "far", to: "o" },
        { from: "lost", to: "and1.In3" },
      ],
    });
    expect(m).toContain("element id a is used twice");
    expect(m).toContain("element both must be exactly one of box, input, output, mark or comment (it has input and output)");
    expect(m).toContain("element far is on page 3, but there are 1 page");
    expect(m).toContain("wire to 'ton1': name the box input, e.g. 'ton1.IN'");
    expect(m).toContain("wire from 'ghost': there is no element ghost");
    expect(m).toContain("o has 2 wires going into it");
    expect(m).toContain("and1.In1 has no wire");
    expect(m).toContain("connection mark lost (Nowhere) has no source mark of that name");
  });

  it("refuses pages on a chart without pages, and pins on inputs", () => {
    const m = problems({ elements: [{ id: "a", input: "xA", page: 1 }, { id: "o", output: "xO" }], wires: [{ from: "a.Q", to: "o" }] });
    expect(m).toContain("element a names a page or area, but the chart has no pages");
    expect(m).toContain("wire from 'a.Q': an input has no named pins; write 'a'");
  });
});

describe("CFC layout", () => {
  it("puts inputs in the left margin level with their pin, boxes in columns, outputs in the right margin", () => {
    const plan = planCfc(cfcChartSchema.parse(paged));
    const at = (id: string) => {
      const n = plan.nodes.find((x) => x.e.id === id)!;
      return { x: n.x, y: n.y, page: n.page, area: n.area };
    };
    // An operator's first pin is at y + 1, a function block's at y + 2 (CODESYS SP21's editor).
    expect(at("not1")).toEqual({ x: 16, y: 4, page: 1, area: "content" });
    expect(at("stop")).toEqual({ x: 2, y: 5, page: 1, area: "left" }); // level with not1.In1
    // and1 moves down so xStart's wire doesn't run through not1
    expect(at("and1")).toMatchObject({ x: 34, y: 5 });
    expect(at("start")).toMatchObject({ x: 2, y: 6 });
    expect(at("tonDelay").x).toBeGreaterThan(at("and1").x);
    expect(at("tonDelay").x).toBeLessThanOrEqual(52); // inside the content area (12..60)
    expect(at("run")).toEqual({ x: 62, y: 7, page: 1, area: "right" }); // level with tonDelay.Q
    expect(at("runIn")).toMatchObject({ x: 2, page: 2, area: "left" });
    expect(at("motor")).toEqual({ x: 62, y: 6, page: 2, area: "right" }); // level with rsLatch.Q1
    // a comment goes below the page's elements
    expect(at("note1").y).toBeGreaterThan(at("tonDelay").y + 3);
  });

  it("keeps the positions given, and puts signals next to their box when there are no margins", () => {
    const plan = planCfc(
      cfcChartSchema.parse({
        elements: [{ id: "a", input: "xA" }, { id: "t", input: "T#2S" }, { id: "ton", box: "TON", instance: "ton", x: 40, y: 6 }, { id: "o", output: "xO" }],
        wires: [{ from: "a", to: "ton.IN" }, { from: "t", to: "ton.PT" }, { from: "ton.Q", to: "o" }],
      }),
    );
    const [a, t, ton, o] = plan.nodes;
    expect([ton!.x, ton!.y]).toEqual([40, 6]);
    // level with the pin, ending 3 units before the box (both are 4 wide)
    expect([a!.x, a!.y]).toEqual([33, 8]);
    expect([t!.x, t!.y]).toEqual([33, 9]);
    expect([o!.x, o!.y]).toEqual([47, 8]); // the TON is 4 wide
  });

  it("gives signals CODESYS's own widths, so the ones before a box end at one right edge", () => {
    // Widths measured in CODESYS SP21's CFC editor, in grid units.
    const measured = { a: 3, xA: 4, "T#2S": 4, xStart: 5, "T#250MS": 6, xEmergencyStop: 8, rTemperatureSetpoint: 10, xOut0: 5 };
    for (const [text, units] of Object.entries(measured)) expect(signalWidth(text), text).toBe(units);
    const texts = ["a", "xA", "xStart", "xEmergencyStop", "xTemperatureHighAlarm", "b", "xDoorClosed"];
    const plan = planCfc(
      cfcChartSchema.parse({
        elements: [...texts.map((t, i) => ({ id: `i${i}`, input: t })), { id: "or1", box: "OR", x: 40, y: 4 }],
        wires: texts.map((_, i) => ({ from: `i${i}`, to: `or1.In${i + 1}` })),
      }),
    );
    const inputs = plan.nodes.filter((n) => n.kind === "input");
    expect(new Set(inputs.map((n) => n.x + signalWidth(n.e.input!)))).toEqual(new Set([37]));
    expect(inputs.map((n) => n.y)).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  it("puts a signal in a page's content area next to its box too", () => {
    const plan = planCfc(
      cfcChartSchema.parse({
        pages: [{}],
        elements: [{ id: "a", input: "xA", area: "content" }, { id: "and1", box: "AND", x: 30, y: 10 }, { id: "b", input: "xB" }, { id: "o", output: "xO" }],
        wires: [{ from: "a", to: "and1.In1" }, { from: "b", to: "and1.In2" }, { from: "and1", to: "o" }],
      }),
    );
    const [a, , b, o] = plan.nodes;
    expect([a!.x, a!.y]).toEqual([23, 11]);
    expect([b!.x, b!.y]).toEqual([2, 12]); // in the left margin
    expect([o!.x, o!.y]).toEqual([62, 11]);
  });
});

describe("CFC XML", () => {
  const xml = cfcChartXml("CFC_Motor", "program", cfcChartSchema.parse(paged));

  it("writes a page-oriented CFC as CODESYS imports it", () => {
    expect(xml).toContain('<CFC page-oriented="true">');
    expect(xml).toContain('<page name="Start" description="" marginwidth="12" width="72" height="96" index="0" xmlns="" />');
    expect(xml).toContain('<page name="Motor" description="Latch and hold" marginwidth="12" width="72" height="96" index="1" xmlns="" />');
    expect(xml).toMatch(/<inVariable localId="\d+"><position x="2" y="5" \/>[\s\S]*?<pageInfo pageId="0" pageArea="leftmargin" xmlns="" \/>/);
    // the connection mark: source with its one input named Run, sink with its one output named Run
    expect(xml).toMatch(/<vendorElement localId="\d+" executionOrderId="\d+"><position x="62" y="7" \/><alternativeText><xhtml xmlns="http:\/\/www.w3.org\/1999\/xhtml">Run<\/xhtml><\/alternativeText><inputVariables><variable formalParameter="Run">/);
    expect(xml).toContain("<ElementType xmlns=\"\">sourceConnectionMark</ElementType>");
    expect(xml).toContain("<ElementType xmlns=\"\">sinkConnectionMark</ElementType>");
    // wires run through unnamed connectors naming the source's output
    expect(xml).toMatch(/<connector localId="\d+" name=""><position x="0" y="0" \/><connectionPointIn><connection refLocalId="\d+" formalParameter="Q1" \/>/);
    expect(xml).toMatch(/<connector localId="\d+" name=""><position x="0" y="0" \/><connectionPointIn><connection refLocalId="\d+" formalParameter="Run" \/>/);
    expect(xml).toContain('<CallType xmlns="">operator</CallType>');
    expect(xml).toContain('<CallType xmlns="">functionblock</CallType>');
  });

  it("writes a plain CFC without pages", () => {
    const plain = cfcChartXml("CFC_P", "program", cfcChartSchema.parse({ elements: [{ id: "a", input: "xA" }, { id: "o", output: "xO" }], wires: [{ from: "a", to: "o" }] }));
    expect(plain).toContain("<CFC><");
    expect(plain).not.toContain("pageInfo");
  });

  it("reads its own XML back as the same chart, with the positions it got", () => {
    const d = describeGraphical(xml)!;
    expect(d.kind).toBe("cfc");
    expect(d.notes).toEqual([]);
    const spec = d.spec as CfcChart;
    expect(spec.pages).toEqual([{ name: "Start" }, { name: "Motor", description: "Latch and hold" }]);
    expect(spec.elements).toHaveLength(14);
    expect(spec.wires).toHaveLength(12);
    // sending the read chart again gives the same chart: positions and pages stay
    expect(describeGraphical(cfcChartXml("CFC_Motor", "program", cfcChartSchema.parse(spec)))!.spec).toEqual(spec);
  });
});

describe("reading CODESYS's own export", () => {
  it("reads the page-oriented CFC CODESYS SP21 exported after importing the chart", () => {
    // The chart above, imported into CODESYS V3.5 SP21, exported again (and built: 0 errors).
    const d = describeGraphical(fixture("CFC_Pages"))!;
    expect(d.kind).toBe("cfc");
    expect(d.notes).toEqual([]);
    const spec = d.spec as CfcChart;
    expect(spec.pages).toEqual([{ name: "Start" }, { name: "Motor", description: "Latch and hold" }]);
    const el = (id: string) => spec.elements.find((e) => e.id === id);
    expect(el("src_Run")).toEqual({ id: "src_Run", mark: "Run", page: 1, area: "right", x: 62, y: 7 });
    expect(el("sink_Run")).toEqual({ id: "sink_Run", mark: "Run", page: 2, area: "left", x: 2, y: 6 });
    expect(el("tonDelay")).toMatchObject({ box: "TON", instance: "tonDelay", page: 1, area: "content" });
    expect(el("note1")).toEqual({ id: "note1", comment: "Start after 2 s unless stopped", page: 1, area: "content", x: 14, y: 11 });
    expect(spec.wires).toEqual(
      expect.arrayContaining([
        { from: "sink_Run", to: "rsLatch.SET" },
        { from: "or1", to: "or1.In2" },
        { from: "tonDelay.Q", to: "src_Run" },
        { from: "rsLatch.Q1", to: "out_xMotor" },
        { from: "in_T_2S", to: "tonDelay.PT" },
      ]),
    );
    // runnable elements in CODESYS's execution order
    expect(spec.elements.filter((e) => e.box).map((e) => e.id)).toEqual(["not1", "and1", "tonDelay", "rsLatch", "or1"]);
    expect(problems(spec)).toBe("");
  });

  it("reads an older CFC (made from the FBD-style description) as a chart", () => {
    const d = describeGraphical(fixture("CFC_Logic"))!;
    expect(d.kind).toBe("cfc");
    expect(d.notes).toEqual([]);
    const spec = d.spec as CfcChart;
    expect(spec.pages).toBeUndefined();
    expect(spec.elements.filter((e) => e.box).map((e) => e.box)).toEqual(expect.arrayContaining(["AND", "NOT", "LIMIT", "ADD", "TON"]));
    expect(problems(spec)).toBe("");
    expect(describeGraphical(cfcChartXml("CFC_Logic", "program", cfcChartSchema.parse(spec)))!.spec).toEqual(spec);
  });
});
