/** The handover report: summary, tables and a commissioning checklist from the project's own content. */
import { describe, expect, it } from "vitest";
import { projectReport } from "../src/codesys/report.js";
import type { TreeNode } from "../src/codesys/st.js";

const node = (path: string, kind: TreeNode["kind"], declaration: string): TreeNode => ({ path, name: path.split("/").pop()!, kind, depth: 1, declaration });

describe("project report", () => {
  const md = projectReport({
    project: "C:\\PLC\\Projects\\Station.project",
    application: "Application",
    compiler: "3.5.21.0",
    generated: "2026-11-14 12:00",
    nodes: [
      node("PLC_PRG", "pou", "PROGRAM PLC_PRG\nVAR\nEND_VAR"),
      node("PRG_Unused", "pou", "PROGRAM PRG_Unused\nVAR\nEND_VAR"),
      node("FB_Pump", "pou", "FUNCTION_BLOCK FB_Pump\nVAR_INPUT\nEND_VAR"),
      node("GVL_IO", "gvl", "VAR_GLOBAL\n  xStart AT %IX0.0 : BOOL;\nEND_VAR"),
      node("PersistentVars", "gvl", "VAR_GLOBAL PERSISTENT RETAIN\n  rTotal : REAL;\nEND_VAR"),
    ],
    outline: "PLC_PRG (PROGRAM)",
    tasks: [{ name: "MainTask", kind: "cyclic", interval: "t#20ms", priority: "1", watchdog: { enabled: true, time: "t#100ms" }, pous: ["PLC_PRG"] }],
    io: [
      { owner: "GVL_IO", name: "xStart", at: "%IX0.0", type: "BOOL", direction: "input", comment: "Start | button", placeholder: false },
      { owner: "GVL_IO", name: "xPump", at: "%QX0.0", type: "BOOL", direction: "output", placeholder: false },
    ],
    mapped: [{ variable: "Application.GVL_IO.xLevelHigh", parameter: "Input@1", unit: "", description: "DI 1", address: "%IX1.0", device: "EL1008" }],
    devices: "PLCWinNT\n  EtherCAT_Master\n    EL1008",
    libraries: [{ name: "Standard, * (System)", resolution: "Standard, 3.5.21.0" }],
    alarms: [{ name: "AG_HMI", alarms: [{ id: "1", kind: "digital", expression: "PLC_PRG.xFault", comparison: "Equal", compare_to: "TRUE", cls: "Error", text: "Pump fault" }] }],
    hmi: [{ name: "Overview", title: "Pump Station", widgets: 9, variables: 12 }],
    compile: { errors: 0, warnings: 2 },
  });

  it("summarises the project", () => {
    expect(md).toMatch(/^# Station: project report/);
    expect(md).toMatch(/2 programs, 1 function blocks, 0 functions, 0 data types, 2 global variable lists/);
    expect(md).toMatch(/\*\*Programs no task calls:\*\* PRG_Unused\. They never run\./);
    expect(md).toMatch(/1 inputs and 1 outputs declared with AT addresses; 1 channels mapped in the device tree/);
    expect(md).toMatch(/\*\*Last compile:\*\* 0 errors, 2 warnings/);
  });

  it("has tables, escaping pipes in cells", () => {
    expect(md).toMatch(/\| MainTask \| cyclic \| t#20ms \| 1 \| t#100ms \| PLC_PRG \|/);
    expect(md).toMatch(/\| %IX0\.0 \| GVL_IO\.xStart \| BOOL \| input \| Start \\\| button \|/);
    expect(md).toMatch(/\| AG_HMI \| 1 \| Error \| Pump fault \| PLC_PRG\.xFault = TRUE \|/);
    expect(md).toMatch(/\| %IX1\.0 \| GVL_IO\.xLevelHigh \| EL1008 \| Input@1 \| DI 1 \|/);
  });

  it("ends with a commissioning checklist from the project's own I/O, alarms, pages and tasks", () => {
    const list = md.split("## Commissioning checklist")[1]!;
    expect(list).toMatch(/- \[ \] Safety functions .* are designed and verified separately/);
    expect(list).toMatch(/- \[ \] Task MainTask: the cycle time and watchdog hold/);
    expect(list).toMatch(/- \[ \] Programs no task calls \(PRG_Unused\)/);
    expect(list).toMatch(/- \[ \] Input %IX0\.0 GVL_IO\.xStart \(Start \| button\): changes when the field device does/);
    expect(list).toMatch(/- \[ \] Output %QX0\.0 GVL_IO\.xPump: drives the right actuator, and is safe when the controller stops/);
    expect(list).toMatch(/- \[ \] Channel %IX1\.0 of EL1008 -> GVL_IO\.xLevelHigh/);
    expect(list).toMatch(/- \[ \] Alarm AG_HMI\/1 "Pump fault": raise PLC_PRG\.xFault = TRUE on the machine/);
    expect(list).toMatch(/- \[ \] HMI page Pump Station/);
    expect(list).toMatch(/- \[ \] Persistent\/retain variables \(PersistentVars\)/);
  });
});
