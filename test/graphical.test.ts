/** Ladder, FBD and SFC as PLCopenXML (the import rules CODESYS needs). */
import { describe, expect, it } from "vitest";
import { chartProblems, fbdXml, ladderXml, sfcProblems, sfcXml, type SfcElement } from "../src/codesys/graphical.js";

describe("graphical code as PLCopenXML", () => {
  it("ladder: series and parallel contacts feed every coil", () => {
    const x = ladderXml("LD_Motor", "program", { rungs: [{ when: { and: [{ or: ["xStart", "xMotor"] }, "NOT xStop"] }, then: [{ coil: "xMotor", kind: "coil" }] }] });
    expect(x).toMatch(/<pou name="LD_Motor" pouType="program">/);
    // xStop's contact has both parallel branches as inputs
    expect(x).toMatch(/<contact localId="4" negated="true"><position x="0" y="0" \/><connectionPointIn><connection refLocalId="2" \/><connection refLocalId="3" \/><\/connectionPointIn><connectionPointOut \/><variable>xStop<\/variable>/);
    expect(x).toMatch(/<coil localId="5" negated="false">.*<connection refLocalId="4" \/>.*<variable>xMotor<\/variable>/s);
    const ids = [...x.matchAll(/localId="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("fbd: functions feed function blocks, outputs go to variables", () => {
    const x = fbdXml("FBD_Delay", "program", { networks: [{ expr: { fb: "TON", instance: "tonDelay", inputs: { IN: { fn: "AND", args: ["xA", "xB"] }, PT: "T#1S" }, output: "Q" }, to: "xQ", assign: { ET: "tEt" } }] });
    expect(x).toMatch(/<block localId="\d+" typeName="AND">/);
    expect(x).toMatch(/<block localId="\d+" typeName="TON" instanceName="tonDelay">/);
    expect(x).toMatch(/<variable formalParameter="IN"><connectionPointIn><connection refLocalId="\d+" formalParameter="Out1" \/>/);
    expect(x).toMatch(/<connection refLocalId="\d+" formalParameter="ET" \/><\/connectionPointIn><expression>tEt<\/expression>/);
  });

  it("sfc: steps, connected conditions, actions with relPosition first, and a jump back", () => {
    const spec = {
      steps: [
        { name: "Idle", initial: true, next: "Fill", when: "xStart" },
        { name: "Fill", actions: [{ name: "ACT_Fill", qualifier: "N" as const, st: "iLevel := iLevel + 1;" }], next: "Idle", when: "iLevel >= 20" },
      ],
    };
    expect(sfcProblems(spec)).toEqual([]);
    const x = sfcXml("SFC_Tank", "program", spec);
    expect(x).toMatch(/<step localId="1" initialStep="true" name="Idle">/);
    expect(x).toMatch(/<action localId="\d+" qualifier="N"><relPosition x="0" y="0" \/><reference name="ACT_Fill" \/>/);
    expect(x).toMatch(/<condition><connectionPointIn><connection refLocalId="\d+" \/><\/connectionPointIn><\/condition>/);
    expect(x).toMatch(/<expression>iLevel &gt;= 20<\/expression>/);
    expect(x).toMatch(/<jumpStep localId="\d+" targetName="Idle">/);
    expect(x).toMatch(/<action name="ACT_Fill"><body><ST><xhtml xmlns="http:\/\/www.w3.org\/1999\/xhtml">iLevel := iLevel \+ 1;/);
  });

  it("the steps format stays one sequence and points to the chart for branches", () => {
    const p = sfcProblems({ steps: [{ name: "A", next: "C", when: "x" }, { name: "B", next: "A", when: "y" }, { name: "C", next: "A", when: "z" }] });
    expect(p[0]).toMatch(/step A must go to the next step listed \(B\).*sfc.chart/);
  });

  it("checks a chart's structure", () => {
    const problems = (chart: unknown[]) => chartProblems(chart as SfcElement[]);
    expect(problems([{ step: "A" }, { when: "x" }])).toEqual([]);
    expect(problems([{ step: "A" }, { step: "B" }, { when: "x" }])[0]).toMatch(/two steps in a row/);
    expect(problems([{ step: "A" }, { when: "x" }, { when: "y" }])[0]).toMatch(/two transitions in a row/);
    expect(problems([{ step: "A" }, { when: "x" }, { jump: "Nowhere" }])[0]).toMatch(/isn't a step/);
    expect(problems([{ step: "A" }, { when: "x" }, { step: "A" }, { when: "y" }])[0]).toMatch(/appears twice/);
    expect(problems([{ step: "A" }, { alternative: [[{ step: "B" }, { when: "x" }], [{ when: "y" }]] }, { step: "C" }, { when: "z" }]).join()).toMatch(/starts with a \{when\}/);
    expect(problems([{ step: "A" }, { when: "x" }, { parallel: [[{ step: "B" }, { when: "y" }], [{ step: "C" }]] }, { when: "z" }]).join()).toMatch(/parallel path 1 must end with a step/);
    expect(problems([{ step: "A" }, { parallel: [[{ step: "B" }], [{ step: "C" }]] }, { when: "z" }]).join()).toMatch(/must follow a \{when\}/);
    expect(problems([{ step: "A" }, { when: "x" }, { step: "B" }]).join()).toMatch(/ends with a step/);
    expect(problems([{ step: "A" }, { when: "x" }, { jump: "A" }, { step: "B" }]).join()).toMatch(/nothing can follow a jump/);
  });
});
