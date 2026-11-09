/** CODESYS conditional compilation, resolved for the simulation mirror. */
import { describe, expect, it } from "vitest";
import { evaluateCondition, resolveConditionals } from "../src/sim/conditionals.js";

const SRC = ["PROGRAM P", "VAR", "    n : INT;", "END_VAR", "{IF defined (FAST)}", "n := 1;", "{ELSIF defined (SLOW) AND NOT project_defined (DEMO)}", "n := 2;", "{ELSE}", "n := 3;", "{END_IF}", "n := n + 1;"].join("\n");

describe("conditional compilation", () => {
  it("keeps the active branch and blanks the rest, line for line", () => {
    const fast = resolveConditionals(SRC, { defines: ["fast"] });
    const lines = fast.text.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[5]).toBe("n := 1;");
    expect([lines[4], lines[6], lines[7], lines[8], lines[9], lines[10]]).toEqual(["", "", "", "", "", ""]);
    expect(lines[11]).toBe("n := n + 1;");
    expect(fast.changed).toBe(true);
    expect(fast.unresolved).toEqual([]);

    expect(resolveConditionals(SRC, { defines: ["SLOW"], projectDefines: [] }).text.split("\n")[7]).toBe("n := 2;");
    expect(resolveConditionals(SRC, { defines: ["SLOW"], projectDefines: ["DEMO"] }).text.split("\n")[9]).toBe("n := 3;");
    expect(resolveConditionals(SRC, { projectDefines: [] }).text.split("\n")[9]).toBe("n := 3;");
  });

  it("doesn't guess project defines it can't read (Scripting 4.1)", () => {
    const r = resolveConditionals(SRC, { defines: ["SLOW"] });
    expect(r.text).toBe(SRC);
    expect(r.changed).toBe(false);
    expect(r.unresolved).toEqual(["defined (SLOW) AND NOT project_defined (DEMO)"]);
  });

  it("ignores conditions after the branch CODESYS takes", () => {
    const src = ["{IF defined (A)}", "a();", "{ELSIF hastype (variable: x, INT)}", "b();", "{END_IF}"].join("\n");
    const r = resolveConditionals(src, { defines: ["A"], projectDefines: [] });
    expect(r.text.split("\n").filter(Boolean)).toEqual(["a();"]);
    expect(r.unresolved).toEqual([]);
  });

  it("honours {define} and {undefine} in the object", () => {
    const src = ["{define FAST}", "PROGRAM P", "{IF defined (FAST)}", "a();", "{END_IF}", "{undefine FAST}", "{IF defined (FAST)}", "b();", "{END_IF}"].join("\n");
    const lines = resolveConditionals(src).text.split("\n");
    expect(lines[3]).toBe("a();");
    expect(lines[7]).toBe("");
    expect(lines[0]).toBe("");
  });

  it("resolves nested blocks", () => {
    const src = ["{IF defined (A)}", "{IF defined (B)}", "ab();", "{ELSE}", "a();", "{END_IF}", "{END_IF}"].join("\n");
    expect(resolveConditionals(src, { defines: ["A"] }).text.split("\n").filter(Boolean)).toEqual(["a();"]);
    expect(resolveConditionals(src, { defines: ["A", "B"] }).text.split("\n").filter(Boolean)).toEqual(["ab();"]);
    expect(resolveConditionals(src, { defines: ["B"] }).text.split("\n").filter(Boolean)).toEqual([]);
  });

  it("leaves conditions it can't evaluate for truST, and reports them", () => {
    const src = ["{IF hastype (variable: x, INT)}", "a();", "{END_IF}"].join("\n");
    const r = resolveConditionals(src, { defines: ["A"] });
    expect(r.text).toBe(src);
    expect(r.unresolved).toEqual(["hastype (variable: x, INT)"]);
  });

  it("leaves unbalanced pragmas alone", () => {
    const r = resolveConditionals("{IF defined (A)}\na();", { defines: ["A"] });
    expect(r.text).toBe("{IF defined (A)}\na();");
    expect(r.unresolved[0]).toMatch(/without \{END_IF\}/);
  });

  it("evaluates conditions", () => {
    const d = (x: string) => ["A", "B"].includes(x.toUpperCase());
    const p = (x: string) => x === "P";
    expect(evaluateCondition("defined (A) AND NOT defined (C)", d, p)).toBe(true);
    expect(evaluateCondition("defined(C) OR project_defined(P)", d, p)).toBe(true);
    expect(evaluateCondition("NOT (defined(A) AND defined(B))", d, p)).toBe(false);
    expect(evaluateCondition("defined (variable: x)", d, p)).toBeUndefined();
    expect(evaluateCondition("hasvalue (A, '1')", d, p)).toBeUndefined();
  });

  it("leaves text without pragmas untouched", () => {
    expect(resolveConditionals("x := 1;", { defines: ["A"] })).toEqual({ text: "x := 1;", unresolved: [], changed: false });
  });
});
