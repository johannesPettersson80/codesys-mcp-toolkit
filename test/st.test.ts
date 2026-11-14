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

describe("signatures", () => {
  it("formats an FB's interface and drops the doc markup", async () => {
    const { formatSignature, plainComment } = await import("../src/codesys/lang.js");
    expect(plainComment("Implements a timer .. code-block:: codesys (* x *)")).toBe("Implements a timer");
    const t = formatSignature({
      name: "TON",
      kind: "FunctionBlock",
      library: "standard, 3.5.22.0 (system)",
      comment: "Implements a timer with a turn-on delay .. image:: @(Ton)",
      variables: [
        { name: "IN", type: "BOOL", section: "input", comment: "Rising edge: starts delay counter" },
        { name: "PT", type: "TIME", section: "input" },
        { name: "Q", type: "BOOL", section: "output" },
        { name: "M", type: "BOOL", section: "other", hidden: true },
      ],
    });
    expect(t).toBe(
      [
        "TON (FunctionBlock, standard, 3.5.22.0 (system)): Implements a timer with a turn-on delay",
        "VAR_INPUT",
        "  IN : BOOL  // Rising edge: starts delay counter",
        "  PT : TIME",
        "VAR_OUTPUT",
        "  Q : BOOL",
        "Hidden (internal): M",
      ].join("\n"),
    );
    expect(formatSignature({ name: "X", error: "not found" })).toBe("X: not found");
  });
});

describe("rename from cross-references", () => {
  it("reads CODESYS's reference locations", async () => {
    const { parseLocation } = await import("../src/codesys/lang.js");
    expect(parseLocation("Line 3, Column 22 (Impl)")).toEqual({ line: 3, col: 22, part: "implementation" });
    expect(parseLocation("Line 7 (Decl)")).toEqual({ line: 7, part: "declaration" });
    expect(parseLocation("somewhere")).toBeUndefined();
  });

  it("replaces whole identifiers at each spot, right to left on a line", async () => {
    const { renameAt } = await import("../src/codesys/lang.js");
    const impl = ["IF fbPump.xRunning AND NOT xRunningOld THEN", "    x := fbPump.xRunning OR fbPump.xRunning;", "END_IF"].join("\r\n");
    const r = renameAt(impl, [{ line: 1, col: 4 }, { line: 2, col: 10 }, { line: 2, col: 29 }], "xRunning", "xIsRunning");
    expect(r.done).toBe(3);
    expect(r.text).toBe(["IF fbPump.xIsRunning AND NOT xRunningOld THEN", "    x := fbPump.xIsRunning OR fbPump.xIsRunning;", "END_IF"].join("\r\n"));
  });
});
