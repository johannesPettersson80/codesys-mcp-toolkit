/** Ladder, FBD and SFC as PLCopenXML (the import rules CODESYS needs). */
import { describe, expect, it } from "vitest";
import { fbdXml, ladderXml, sfcProblems, sfcXml } from "../src/codesys/graphical.js";

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

  it("refuses SFC branches it can't draw yet", () => {
    const p = sfcProblems({ steps: [{ name: "A", next: "C", when: "x" }, { name: "B", next: "A", when: "y" }, { name: "C", next: "A", when: "z" }] });
    expect(p[0]).toMatch(/step A must go to the next step listed \(B\)/);
  });
});
