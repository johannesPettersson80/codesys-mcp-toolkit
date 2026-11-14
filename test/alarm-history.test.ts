import { describe, expect, it } from "vitest";
import { dtText, historyCode } from "../src/codesys/alarm-history.js";

const groups = [
  { name: "AG_HMI", alarms: [{ id: "1", kind: "digital", expression: "PLC_PRG.xHigh", comparison: "Equal", compare_to: "TRUE", cls: "Warning", text: "Level high" }, { id: "2", kind: "digital", expression: "PLC_PRG.xFault", comparison: "Equal", compare_to: "TRUE", cls: "Error", text: "Pump fault" }] },
  { name: "AG_Line", alarms: [{ id: "7", kind: "digital", expression: "GVL.xDoor", comparison: "Equal", compare_to: "TRUE", cls: "Error", text: "Door open" }] },
];

describe("alarm history", () => {
  it("generates a ring buffer and a program that records each alarm's changes", () => {
    const c = historyCode(groups, 50);
    expect(c.alarms).toBe(3);
    expect(c.gvl.declaration).toContain("VAR_GLOBAL RETAIN");
    expect(c.gvl.declaration).toContain("aEvents : ARRAY[0..49] OF ST_AlarmEvent;");
    expect(c.gvl.declaration).toContain("iSize : INT := 50;");
    expect(c.program.declaration).toContain("aPrev : ARRAY[0..2] OF INT;");
    // The third alarm is the first of the second group.
    expect(c.program.implementation).toContain("iNow := TO_INT(__Alm__GVL.g_inst.gen_Inst_AG_Line_AlarmGroup.gen_ArrAllAlarms[0].m_eState);");
    expect(c.program.implementation).toContain("F_AlarmHistoryAdd(sGroup := 'AG_Line', sAlarm := '7', iState := iNow, liTimestamp := __Alm__GVL.g_inst.gen_Inst_AG_Line_AlarmGroup.gen_ArrAllAlarms[0].m_liTimestampLast, iOffset := __Alm__GVL.g_inst.gen_Inst_AG_Line_AlarmGroup.gen_ArrAllAlarms[0].m_iOffsetLast);");
    expect(c.program.implementation).toContain("IF xInit AND iNow <> aPrev[2] THEN");
    expect(c.fn.implementation).toContain("LINT_TO_DT(liTimestamp / 10000000 - 11644473600 + INT_TO_LINT(iOffset) * 60)");
    expect(() => historyCode([], 10)).toThrow(/no alarms/);
  });

  it("formats CODESYS's DT text", () => {
    expect(dtText("2026-11-14-18:5:5")).toBe("2026-11-14 18:05:05");
    expect(dtText("2026-01-02-03:04:05")).toBe("2026-01-02 03:04:05");
  });
});
