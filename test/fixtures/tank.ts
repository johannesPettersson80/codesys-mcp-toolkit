/**
 * The acceptance-demo tank as a CODESYS export (TreeNode list), in plain
 * CODESYS ST (E.X enum literals, which the mirror rewrites for truST).
 *
 * T101 gravity tank, LT101 level, XV101 inlet valve (open feedback after 2 s),
 * P101 outlet pump (running feedback after 0.5 s), PI level loop, high-high
 * interlock that closes XV101.
 */
import type { TreeNode } from "../../src/codesys/st.js";
import type { TaskInfo } from "../../src/sim/mirror.js";

const n = (path: string, kind: TreeNode["kind"], declaration?: string, implementation?: string, sub?: string): TreeNode => ({
  path,
  name: path.split("/").pop()!,
  kind,
  sub,
  st: true,
  depth: path.split("/").length - 1,
  declaration,
  implementation,
});

export const PRG_TANK_IMPL = `IF bInit THEN
    fbPI.Kp := 50.0;
    fbPI.Ti := 60.0;
    bInit := FALSE;
END_IF

tonHiHi(IN := GVL_IO.lrLT101_Level > GVL_Par.rLevelHiHi, PT := T#2S);
rtInterlock(CLK := tonHiHi.Q);
IF rtInterlock.Q THEN
    GVL_Par.eMode := E_TankMode.INTERLOCKED;
    nTrips := nTrips + 1;
    itfReset := fbPI;
    itfReset.Reset();
END_IF

GVL_IO.xXV101_Open := GVL_Par.eMode = E_TankMode.AUTO;
GVL_IO.xP101_Run := GVL_IO.lrLT101_Level > 0.1;
fbPI(bEnable := GVL_Par.eMode = E_TankMode.AUTO AND GVL_IO.xXV101_Opened,
     rPV := LREAL_TO_REAL(GVL_IO.lrLT101_Level),
     rSP := GVL_Par.rLevelSP);

IF GVL_IO.xXV101_Opened THEN
    GVL_IO.lrFV101_FlowCmd := REAL_TO_LREAL(fbPI.rY / 100.0 * GVL_Par.rMaxInflow);
ELSE
    GVL_IO.lrFV101_FlowCmd := 0.0;
END_IF
IF GVL_Par.eMode = E_TankMode.INTERLOCKED THEN
    sStatus := CONCAT('INTERLOCKED, trips=', UDINT_TO_STRING(nTrips));
ELSE
    sStatus := 'OK';
END_IF`;

/** 1-based implementation lines of PRG_Tank used by tests. */
export const LINES = { trip: 11, valve: 16, piCall: 18, status: 30 };

export function tankNodes(): TreeNode[] {
  return [
    n("E_TankMode", "dut", "{attribute 'qualified_only'}\nTYPE E_TankMode :\n(\n    MANUAL := 0,\n    AUTO := 1,\n    INTERLOCKED := 2\n);\nEND_TYPE", undefined, "enum"),
    n("I_Resettable", "interface", "INTERFACE I_Resettable EXTENDS __System.IQueryInterface"),
    n("I_Resettable/Reset", "interface_method", "METHOD Reset : BOOL"),
    n(
      "FB_PI",
      "pou",
      `FUNCTION_BLOCK FB_PI IMPLEMENTS I_Resettable
VAR_INPUT
    bEnable : BOOL;
    rPV : REAL;             // process value
    rSP : REAL;             // setpoint
    rCycleS : REAL := 0.01; // scan time [s]
END_VAR
VAR_OUTPUT
    rY : REAL;              // output 0..100 %
END_VAR
VAR
    _rKp : REAL := 50.0;
    _rTi : REAL := 60.0;
    rI : REAL;
    rE : REAL;
END_VAR`,
      `IF bEnable THEN
    rE := rSP - rPV;
    rI := LIMIT(0.0, rI + _rKp * rE * rCycleS / _rTi, 100.0);
    rY := LIMIT(0.0, _rKp * rE + rI, 100.0);
ELSE
    rY := 0.0;
END_IF`,
      "function_block",
    ),
    n("FB_PI/Reset", "method", "METHOD Reset : BOOL", "rI := 0.0;\nrY := 0.0;\nReset := TRUE;"),
    n("FB_PI/Kp", "property", "PROPERTY PUBLIC Kp : REAL"),
    n("FB_PI/Kp/Get", "accessor", "VAR\nEND_VAR", "Kp := _rKp;"),
    n("FB_PI/Kp/Set", "accessor", "VAR\nEND_VAR", "IF Kp > 0.0 THEN\n    _rKp := Kp;\nEND_IF"),
    n("FB_PI/Ti", "property", "PROPERTY PUBLIC Ti : REAL"),
    n("FB_PI/Ti/Get", "accessor", "VAR\nEND_VAR", "Ti := _rTi;"),
    n("FB_PI/Ti/Set", "accessor", "VAR\nEND_VAR", "IF Ti > 0.0 THEN\n    _rTi := Ti;\nEND_IF"),
    n(
      "GVL_IO",
      "gvl",
      `{attribute 'qualified_only'}
VAR_GLOBAL
    lrLT101_Level : LREAL;     // tank level [m]
    lrFV101_FlowCmd : LREAL;   // inlet flow command [m3/s]
    xXV101_Open : BOOL;        // inlet valve command
    xXV101_Opened : BOOL;      // inlet valve open limit switch
    xP101_Run : BOOL;          // outlet pump command
    xP101_Running : BOOL;      // outlet pump running feedback
END_VAR`,
    ),
    n(
      "GVL_Par",
      "gvl",
      `{attribute 'qualified_only'}
VAR_GLOBAL
    rLevelSP : REAL := 1.0;      // level setpoint [m]
    rLevelHiHi : REAL := 2.0;    // high-high trip [m]
    rMaxInflow : REAL := 0.05;   // inlet flow at 100 % [m3/s]
    eMode : E_TankMode := E_TankMode.AUTO;
END_VAR`,
    ),
    n(
      "PRG_Tank",
      "pou",
      `PROGRAM PRG_Tank
VAR
    fbPI : FB_PI;
    tonHiHi : TON;
    rtInterlock : R_TRIG;
    itfReset : I_Resettable;
    nTrips : UDINT;
    sStatus : STRING(80) := 'Nivå åäö';
    bInit : BOOL := TRUE;
END_VAR`,
      PRG_TANK_IMPL,
      "program",
    ),
    { path: "Taskkonfiguration", name: "Taskkonfiguration", kind: "task_config", depth: 0 },
    { path: "Taskkonfiguration/MainTask", name: "MainTask", kind: "task", depth: 1 },
    { path: "SEQ_Fill", name: "SEQ_Fill", kind: "pou", sub: "program", st: false, depth: 0, declaration: "PROGRAM SEQ_Fill" },
  ];
}

export function tankTasks(): TaskInfo[] {
  return [{ name: "MainTask", interval: "t#10ms", interval_unit: "ms", priority: "1", kind: "Cyclic", pous: ["PRG_Tank"] }];
}

export const TANK_PLANT = `[[plant]]
id = "T101"
model = "gravity_tank"
inputs = ["GVL_IO.lrFV101_FlowCmd"]
outputs = ["GVL_IO.lrLT101_Level"]
initial_state = [0.2]

[plant.parameters]
area_m2 = 1.0
outflow_coefficient_m2_sqrt_m_per_s = 0.03

[[feedback]]
signal = "GVL_IO.xXV101_Opened"
follows = "GVL_IO.xXV101_Open"
delay_ms = 2000

[[feedback]]
signal = "GVL_IO.xP101_Running"
follows = "GVL_IO.xP101_Run"
delay_ms = 500
`;

/** Unit tests for the tank, as CODESYS programs marked {attribute 'test'}. */
export function tankTestNodes(o: { failing?: boolean } = {}): TreeNode[] {
  const t = (name: string, decl: string, impl: string): TreeNode => ({
    path: `Tests/${name}`,
    name,
    kind: "pou",
    sub: "program",
    st: true,
    depth: 1,
    declaration: `{attribute 'test'}\nPROGRAM ${name}\n${decl}`,
    implementation: impl,
  });
  const nodes: TreeNode[] = [
    { path: "Tests", name: "Tests", kind: "folder", depth: 0 },
    t("T_PI_Proportional", "VAR\n    fb : FB_PI;\nEND_VAR", "fb.Kp := 10.0;\nfb(bEnable := TRUE, rPV := 0.5, rSP := 1.0);\nASSERT_NEAR(EXPECTED := 5.0, ACTUAL := fb.rY, DELTA := 0.2);"),
    t("T_PI_ResetViaInterface", "VAR\n    fb : FB_PI;\n    itf : I_Resettable;\nEND_VAR", "fb(bEnable := TRUE, rPV := 0.0, rSP := 1.0);\nitf := fb;\nitf.Reset();\nASSERT_EQUAL(EXPECTED := 0.0, ACTUAL := fb.rY);"),
    t("T_Mode_DefaultsToAuto", "", "ASSERT_TRUE(IN := GVL_Par.eMode = E_TankMode.AUTO);\nASSERT_FALSE(IN := GVL_Par.eMode = E_TankMode.INTERLOCKED);"),
  ];
  if (o.failing) nodes.push(t("T_Deliberately_Failing", "", "ASSERT_EQUAL(EXPECTED := 1, ACTUAL := 2);"));
  return nodes;
}
