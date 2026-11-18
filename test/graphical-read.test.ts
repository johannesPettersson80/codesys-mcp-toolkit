/** Reading LD, FBD and SFC back as create_graphical's description: CODESYS's own exports, and round trips. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfcXml, fbdSchema, fbdXml, ladderSchema, ladderXml, sfcSchema, sfcXml } from "../src/codesys/graphical.js";
import { describeGraphical, parseXml } from "../src/codesys/graphical-read.js";

const fixture = (n: string) => readFileSync(join(import.meta.dirname, "fixtures", "graphical", `${n}.xml`), "utf8");

describe("the XML reader", () => {
  it("reads elements, attributes, entities and CDATA, and skips comments", () => {
    const d = parseXml(`<?xml version="1.0"?><!-- c --><a x="1" y='2'><b>iLevel &gt;= 20 &amp; &#65;</b><c/><d><![CDATA[x < y]]></d></a>`);
    const a = d.children[0]!;
    expect(a.attrs).toEqual({ x: "1", y: "2" });
    expect(a.children.map((c) => c.name)).toEqual(["b", "c", "d"]);
    expect(a.children[0]!.text).toBe("iLevel >= 20 & A");
    expect(a.children[2]!.text).toBe("x < y");
  });
});

describe("graphical POUs exported by CODESYS SP22", () => {
  it("ladder: a latch with a parallel branch, and a second rung", () => {
    const d = describeGraphical(fixture("LD_Motor"))!;
    expect(d.kind).toBe("ladder");
    expect(d.notes).toEqual([]);
    const rungs = (d.spec as { rungs: { when: unknown; then: unknown[] }[] }).rungs;
    expect(rungs[0]).toEqual({ when: { and: [{ or: ["xStart", "xMotor"] }, "NOT xStop"] }, then: [{ coil: "xMotor", kind: "coil" }] });
    expect(rungs.length).toBeGreaterThanOrEqual(2);
    expect(rungs[1]!.when).toBe("xMotor");
  });

  it("FBD: an AND into a TON, with Q to a variable and ET written on the block", () => {
    const d = describeGraphical(fixture("FBD_Delay"))!;
    expect(d.kind).toBe("fbd");
    expect(d.spec).toEqual({
      networks: [{ expr: { fb: "TON", instance: "tonDelay", inputs: { IN: { fn: "AND", args: ["xA", "xB"] }, PT: "T#1S" }, output: "Q" }, to: "xQ", assign: { ET: "tEt" } }],
    });
  });

  it("SFC: three steps with actions and conditions, the last jumping back", () => {
    const d = describeGraphical(fixture("SFC_Tank"))!;
    expect(d.kind).toBe("sfc");
    expect(d.notes).toEqual([]);
    expect(d.spec).toEqual({
      steps: [
        { name: "Idle", initial: true, next: "Fill", when: "xStart" },
        { name: "Fill", actions: [{ name: "ACT_Fill", qualifier: "N", st: "iLevel := iLevel + 1;" }], next: "Drain", when: "iLevel >= 20" },
        { name: "Drain", actions: [{ name: "ACT_Drain", qualifier: "N", st: "iLevel := iLevel - 1;" }], next: "Idle", when: "iLevel <= 0" },
      ],
    });
  });
});

describe("round trips through create_graphical's generator", () => {
  it("ladder", () => {
    const spec = ladderSchema.parse({ rungs: [{ when: { and: [{ or: ["xStart", "xMotor"] }, "NOT xStop"] }, then: [{ coil: "xMotor" }, { coil: "xLamp", kind: "set" }] }, { when: "xFault", then: [{ coil: "xMotor", kind: "reset" }] }] });
    expect(describeGraphical(ladderXml("LD_X", "program", spec))!.spec).toEqual(spec);
  });

  it("FBD", () => {
    const spec = fbdSchema.parse({ networks: [{ expr: { fn: "OR", args: ["xA", { fn: "AND", args: ["xB", "xC"] }] }, to: "xOut" }, { expr: { fb: "TOF", instance: "tofOff", inputs: { IN: "xIn", PT: "T#3S" }, output: "Q" }, to: "xDelayed", assign: { ET: "tEt" } }] });
    expect(describeGraphical(fbdXml("FBD_X", "program", spec))!.spec).toEqual(spec);
  });

  it("SFC", () => {
    const spec = sfcSchema.parse({ steps: [{ name: "Init", initial: true, next: "Run", when: "xGo" }, { name: "Run", actions: [{ name: "A_Run", qualifier: "N", st: "nCount := nCount + 1;" }], next: "Init", when: "nCount > 10" }] });
    expect(describeGraphical(sfcXml("SFC_X", "program", spec))!.spec).toEqual(spec);
  });

  it("SFC step entry and exit actions, and P1/P0 turned into them", () => {
    const spec = sfcSchema.parse({ steps: [
      { name: "Idle", initial: true, entry: "nEntries := nEntries + 1;", next: "Run", when: "xGo" },
      { name: "Run", actions: [{ name: "A_Run", qualifier: "N", st: "nCount := nCount + 1;" }, { name: "A_Tare", qualifier: "P1", st: "rTare := rWeight;" }, { name: "A_Left", qualifier: "P0", st: "nExits := nExits + 1;" }], next: "Idle", when: "nCount > 10" },
    ] });
    const x = sfcXml("SFC_E", "program", spec);
    // As CODESYS SP21 exports them: attributes of the step that name an action of the POU.
    expect(x).toContain('<attribute guid="a6b08bd8-b696-47e3-9cbf-7408b61c9ff8">Idle_entry</attribute>');
    expect(x).toContain('<attribute guid="a6b08bd8-b696-47e3-9cbf-7408b61c9ff8">A_Tare</attribute>');
    expect(x).toContain('<attribute guid="a2621e18-7de3-4ea6-ae6d-89e9e0b7befd">A_Left</attribute>');
    expect(x).toContain('<action name="A_Tare"><body><ST><xhtml xmlns="http://www.w3.org/1999/xhtml">rTare := rWeight;</xhtml>');
    // P1 and P0 aren't associated with the step: CODESYS rejects those qualifiers.
    expect(x).not.toMatch(/qualifier="P[01]"/);
    expect(describeGraphical(x)!.spec).toEqual({ steps: [
      { name: "Idle", initial: true, entry: "nEntries := nEntries + 1;", next: "Run", when: "xGo" },
      { name: "Run", actions: [{ name: "A_Run", qualifier: "N", st: "nCount := nCount + 1;" }], entry: "rTare := rWeight;", exit: "nExits := nExits + 1;", next: "Idle", when: "nCount > 10" },
    ] });
  });

  it("SFC with branches as a chart, round trip included", () => {
    const chart = [
      { step: "Idle", initial: true },
      { when: "xStart" },
      { step: "Check", actions: [{ name: "ACT_Check", qualifier: "N", st: "nChecks := nChecks + 1;" }] },
      { alternative: [[{ when: "xFault" }, { step: "Alarm", actions: [{ name: "ACT_Alarm", qualifier: "N", st: "xAlarm := TRUE;" }] }, { when: "NOT xFault" }, { jump: "Idle" }], [{ when: "NOT xFault" }]] },
      { parallel: [[{ step: "Fill", actions: [{ name: "ACT_Fill", qualifier: "N", st: "nLevel := nLevel + 1;" }] }], [{ step: "Heat", actions: [{ name: "ACT_Heat", qualifier: "N", st: "nTemp := nTemp + 2;" }] }]] },
      { when: "nLevel >= 10 AND nTemp >= 20" },
      { step: "Done" },
      { when: "NOT xStart" },
      { jump: "Idle" },
    ];
    // CODESYS SP22's own export of the chart create_graphical made.
    const d = describeGraphical(fixture("SFC_Branches"))!;
    expect(d.notes).toEqual([]);
    expect(d.spec).toEqual({ chart });
    const spec = sfcSchema.parse({ chart });
    expect(describeGraphical(sfcXml("SFC_X", "program", spec))!.spec).toEqual({ chart });
  });

  it("an alternative whose paths all jump", () => {
    const chart = [{ step: "Idle", initial: true }, { when: "xGo" }, { step: "Check" }, { alternative: [[{ when: "xOk" }, { step: "Run" }, { when: "NOT xGo" }, { jump: "Idle" }], [{ when: "xFault" }, { jump: "Check" }]] }];
    const x = sfcXml("SFC_J", "program", sfcSchema.parse({ chart }));
    // The jumps feed the convergence (CODESYS drops the paths otherwise), and no jump is added after it.
    expect(x.match(/<jumpStep /g)).toHaveLength(2);
    expect(x).toMatch(/<selectionConvergence localId="\d+"><position x="0" y="\d+" \/><connectionPointIn><connection refLocalId="\d+" formalParameter="sfc" \/><\/connectionPointIn><connectionPointIn>/);
    expect(describeGraphical(x)!.spec).toEqual({ chart });
  });

  it("CFC: CODESYS's export read back through its connectors, round trip included", () => {
    const networks = [
      { expr: { fn: "AND", args: ["xA", { fn: "NOT", args: ["xB"] }] }, to: "xOut" },
      { expr: { fn: "LIMIT", args: ["0", { fn: "ADD", args: ["nIn", "5"] }, "100"] }, to: "nOut" },
      { expr: { fb: "TON", instance: "tonDelay", inputs: { IN: "xOut", PT: "T#300MS" }, output: "Q" }, to: "xLate", assign: { ET: "tEt" } },
    ];
    // CODESYS SP22's own export of the CFC create_graphical made (checked in the simulation).
    const d = describeGraphical(fixture("CFC_Logic"))!;
    expect(d.kind).toBe("cfc");
    expect(d.notes).toEqual([]);
    expect(d.spec).toEqual({ networks });
    const spec = fbdSchema.parse({ networks });
    const x = cfcXml("CFC_X", "program", spec);
    expect(x).toContain('<CallType xmlns="">operator</CallType>');
    expect(x).toContain('<CallType xmlns="">functionblock</CallType>');
    expect(x).toMatch(/<connector localId="\d+" name=""><position x="0" y="0" \/><connectionPointIn><connection refLocalId="\d+" formalParameter="" \/>/);
    expect(describeGraphical(x)!.spec).toEqual({ networks });
  });
});
