/** Recipes as generated ST, and the HMI's recipe widget. */
import { describe, expect, it } from "vitest";
import { recipeCode, recipeSchema, variableTypes } from "../src/codesys/recipes.js";
import type { TreeNode } from "../src/codesys/st.js";
import { nativePlan } from "../src/hmi/native.js";
import { renderScreen } from "../src/hmi/render.js";
import { plcValue, screenSchema, screenVariables } from "../src/hmi/spec.js";

const spec = recipeSchema.parse({
  name: "Pump",
  variables: ["PLC_PRG.rSetpoint", "PLC_PRG.xAuto", { path: "GVL.sMode", type: "STRING(20)" }],
  recipes: { Normal: { "PLC_PRG.rSetpoint": 75, "PLC_PRG.xAuto": true, "GVL.sMode": "full" }, Eco: { "PLC_PRG.rSetpoint": 60.5, "PLC_PRG.xAuto": false } },
});

describe("recipes as ST", () => {
  const code = recipeCode(spec, { "PLC_PRG.rSetpoint": "REAL", "PLC_PRG.xAuto": "BOOL" });

  it("declares a struct with a field per variable", () => {
    expect(code.dut.declaration).toBe("TYPE ST_Recipe_Pump :\nSTRUCT\n    rSetpoint : REAL; // PLC_PRG.rSetpoint\n    xAuto : BOOL; // PLC_PRG.xAuto\n    sMode : STRING(20); // GVL.sMode\nEND_STRUCT\nEND_TYPE");
  });

  it("keeps the recipes in a RETAIN array with ST literals, and their names", () => {
    expect(code.gvl.declaration).toContain("VAR_GLOBAL RETAIN\n    aRecipes : ARRAY[0..1] OF ST_Recipe_Pump := [(rSetpoint := 75.0, xAuto := TRUE, sMode := 'full'), (rSetpoint := 60.5, xAuto := FALSE)];");
    expect(code.gvl.declaration).toContain("asNames : ARRAY[0..1] OF STRING(32) := ['Normal', 'Eco'];");
  });

  it("applies and saves through the program", () => {
    expect(code.program.implementation).toContain("p0 := ADR(PLC_PRG.rSetpoint);");
    expect(code.program.declaration).toContain("p0 : POINTER TO REAL; // PLC_PRG.rSetpoint");
    expect(code.program.implementation).toContain("IF iApply >= 0 AND iApply < 2 THEN\n    p0^ := GVL_Recipe_Pump.aRecipes[iApply].rSetpoint;");
    expect(code.program.implementation).toContain("    sActive := GVL_Recipe_Pump.asNames[iApply];");
    expect(code.program.implementation).toContain("    GVL_Recipe_Pump.aRecipes[iSave].xAuto := p1^;");
  });

  it("asks for a type it can't find, and refuses values for unknown variables", () => {
    expect(() => recipeCode(spec, {})).toThrow(/No type for PLC_PRG\.rSetpoint/);
    expect(() => recipeCode({ ...spec, recipes: { X: { "PLC_PRG.nOther": 1 } } }, { "PLC_PRG.rSetpoint": "REAL", "PLC_PRG.xAuto": "BOOL" })).toThrow(/isn't one of the variables/);
  });

  it("looks up types in the declarations", () => {
    const nodes = [{ path: "PLC_PRG", name: "PLC_PRG", kind: "pou", depth: 0, declaration: "PROGRAM PLC_PRG\nVAR\n    rSetpoint : REAL := 75;\n    xAuto : BOOL;\nEND_VAR" }] as TreeNode[];
    expect(variableTypes(nodes, ["PLC_PRG.rSetpoint", "PLC_PRG.xAuto", "PLC_PRG.fb.x"])).toEqual({ "PLC_PRG.rSetpoint": "REAL", "PLC_PRG.xAuto": "BOOL" });
  });
});

describe("the recipe widget", () => {
  const screen = screenSchema.parse({ name: "R", title: "R", widgets: [{ type: "recipe", title: "Recipes", at: [1, 1, 4, 4], recipe: "Pump", recipes: ["Normal", "Eco"] }] });

  it("binds the recipe program's variables", () => {
    expect(screenVariables(screen)).toEqual(["PRG_Recipe_Pump.iApply", "PRG_Recipe_Pump.iSave", "PRG_Recipe_Pump.sActive"]);
  });

  it("renders Apply and Save per recipe in the browser", () => {
    const html = renderScreen(screen).html;
    expect(html).toContain('data-act="value" data-var="PRG_Recipe_Pump.iApply" data-val="1">Apply</button>');
    expect(html).toContain('data-var="PRG_Recipe_Pump.iSave" data-val="0">Save</button>');
  });

  it("renders buttons with ST in CODESYS", () => {
    const els = nativePlan(screen).elements;
    // The label is drawn on the button; a clear shape on top runs the ST.
    expect(els.filter((e) => e.text === "Apply")).toHaveLength(2);
    expect(els.find((e) => e.fill === null && e.click === "PRG_Recipe_Pump.iApply := 1;")).toBeDefined();
    expect(els.find((e) => e.props?.["Text variables.Text variable"] === "PRG_Recipe_Pump.sActive")).toBeDefined();
  });

  it("shows a STRING value without its quotes", () => {
    expect(plcValue("'Eco'")).toBe("Eco");
    expect(plcValue("STRING#'Normal'")).toBe("Normal");
  });
});
