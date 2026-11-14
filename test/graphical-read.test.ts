/** Reading LD, FBD and SFC back as create_graphical's description: CODESYS's own exports, and round trips. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fbdSchema, fbdXml, ladderSchema, ladderXml, sfcSchema, sfcXml } from "../src/codesys/graphical.js";
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

  it("reports SFC branches instead of hiding them", () => {
    const xml = `<project><types><pous><pou name="S"><body><SFC><step localId="1" name="A" initialStep="true"/><selectionDivergence localId="2"><connectionPointIn><connection refLocalId="1"/></connectionPointIn></selectionDivergence></SFC></body></pou></pous></types></project>`;
    expect(describeGraphical(xml)!.notes.join(" ")).toMatch(/selectionDivergence \(a branch\)/);
  });
});
