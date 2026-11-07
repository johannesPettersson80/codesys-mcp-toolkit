import { describe, expect, it } from "vitest";
import { checkDeclaration, declarationHeader } from "../src/codesys/st.js";
import { formatBuild } from "../src/tools.js";

describe("declarationHeader", () => {
  it("skips pragmas and comments", () => {
    expect(declarationHeader("{attribute 'qualified_only'}\n// c\n(* block *)\nTYPE E_Mode :\n(A);\nEND_TYPE")).toEqual({ keyword: "TYPE", name: "E_Mode" });
  });
  it("handles access modifiers", () => {
    expect(declarationHeader("METHOD PUBLIC Start : BOOL")).toEqual({ keyword: "METHOD", name: "Start" });
    expect(declarationHeader("FUNCTION_BLOCK ABSTRACT FB_Base")).toEqual({ keyword: "FUNCTION_BLOCK", name: "FB_Base" });
  });
  it("returns no name for VAR blocks", () => {
    expect(declarationHeader("VAR_GLOBAL\n x : INT;\nEND_VAR")).toEqual({ keyword: "VAR_GLOBAL", name: undefined });
    expect(declarationHeader("VAR\nEND_VAR")).toEqual({ keyword: "VAR", name: undefined });
  });
});

describe("checkDeclaration (issue #5)", () => {
  it("rejects a POU declaration without its header", () => {
    const err = checkDeclaration("pou", "program", "TestProgram", "VAR\n    bStart : BOOL;\nEND_VAR");
    expect(err).toMatch(/must start with 'PROGRAM TestProgram'/);
  });
  it("rejects changing the POU type or name", () => {
    expect(checkDeclaration("pou", "program", "P", "FUNCTION_BLOCK P\nEND_VAR")).toBeDefined();
    expect(checkDeclaration("pou", "program", "P", "PROGRAM Q\nVAR\nEND_VAR")).toBeDefined();
  });
  it("accepts matching headers, case-insensitively", () => {
    expect(checkDeclaration("pou", "program", "PLC_PRG", "program plc_prg\nVAR\nEND_VAR")).toBeUndefined();
    expect(checkDeclaration("pou", "function", "F", "FUNCTION F : INT\nVAR_INPUT\nEND_VAR")).toBeUndefined();
    expect(checkDeclaration("method", undefined, "Start", "METHOD PUBLIC Start : BOOL")).toBeUndefined();
    expect(checkDeclaration("dut", "enum", "E_Mode", "{attribute 'qualified_only'}\nTYPE E_Mode :\n(A);\nEND_TYPE")).toBeUndefined();
    expect(checkDeclaration("gvl", undefined, "GVL", "{attribute 'qualified_only'}\nVAR_GLOBAL\nEND_VAR")).toBeUndefined();
    expect(checkDeclaration("accessor", undefined, "Get", "VAR\nEND_VAR")).toBeUndefined();
    expect(checkDeclaration("accessor", undefined, "Get", "")).toBeUndefined();
  });
  it("rejects a GVL without VAR_GLOBAL", () => {
    expect(checkDeclaration("gvl", undefined, "GVL", "VAR\nEND_VAR")).toMatch(/VAR_GLOBAL/);
  });
});

describe("formatBuild", () => {
  it("lists errors with code, object and position", () => {
    const r = formatBuild([
      { category: "Build", severity: "Text", text: "Compile complete -- 1 errors" },
      { category: "Build", severity: "Error", text: "Cannot convert type", prefix: "C", number: 32, object: "FB_X", position: "Line 1, Column 1 (Impl)" },
      { category: "Build", severity: "Warning", text: "Unused", prefix: "C", number: 373, object: "PLC_PRG", position: null },
    ]);
    expect(r.errors).toBe(1);
    expect(r.text).toContain("Build: 1 error(s), 1 warning(s).");
    expect(r.text).toContain("ERROR C32 FB_X (Line 1, Column 1 (Impl)): Cannot convert type");
    expect(r.text).toContain("WARNING C373 PLC_PRG: Unused");
  });
  it("notes that unreferenced POUs are not compiled when clean", () => {
    expect(formatBuild([]).text).toMatch(/only compiles POUs reachable from a task/);
  });
});
