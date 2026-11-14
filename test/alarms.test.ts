/** CODESYS alarms in the simulation: states, paths, and the HMI's alarm rows. */
import { describe, expect, it } from "vitest";
import { alarmPath, alarmState, condition, STATE_TEXT } from "../src/codesys/alarm-tools.js";
import { renderScreen } from "../src/hmi/render.js";
import { screenSchema } from "../src/hmi/spec.js";

describe("alarm states", () => {
  it("read AlarmState as CODESYS's simulation shows it, by name or number", () => {
    expect(alarmState("AlarmState.Normal")).toBe("normal");
    expect(alarmState("AlarmState.Active")).toBe("active");
    expect(alarmState("AlarmState.WaitingForConfirmation")).toBe("waiting");
    expect(alarmState("AlarmState.ActiveAcknowledged")).toBe("acknowledged");
    expect(alarmState("AlarmState.InactiveUnacknowledged")).toBe("unacknowledged");
    expect(alarmState("AlarmState.Pending")).toBe("pending");
    expect(alarmState("BYTE#2")).toBe("active");
    expect(alarmState("5")).toBe("unacknowledged");
    expect(alarmState(undefined)).toBe("unknown");
    expect(STATE_TEXT.waiting).toBe("cleared, waiting for confirmation");
  });

  it("find the k-th alarm of a group in CODESYS's generated alarm code", () => {
    expect(alarmPath("AG_HMI", 1)).toBe("__Alm__GVL.g_inst.gen_Inst_AG_HMI_AlarmGroup.gen_ArrAllAlarms[1]");
  });

  it("describe the condition", () => {
    expect(condition({ id: "1", kind: "digital", expression: "PLC_PRG.xFault", comparison: "Equal", compare_to: "TRUE", cls: "Error", text: "" })).toBe("PLC_PRG.xFault = TRUE");
    expect(condition({ id: "2", kind: "upperlimit", expression: "PLC_PRG.rTemp", comparison: "Greater", compare_to: "80", cls: "Warning", text: "" })).toBe("PLC_PRG.rTemp > 80");
  });
});

describe("the HMI's alarm rows", () => {
  it("carry an acknowledge button and a state label for CODESYS alarms", () => {
    const s = screenSchema.parse({ name: "A", title: "A", widgets: [{ type: "alarms", at: [1, 1, 4, 4], items: [{ active: "PLC_PRG.xFault", text: "Pump fault" }] }] });
    const r = renderScreen(s);
    expect(r.html).toMatch(/<span class="al-st"><\/span><button class="al-ack" data-ack="PLC_PRG.xFault">ACK<\/button>/);
    expect(r.css).toMatch(/\.al\.can-ack \.al-ack\{display:inline-block\}/);
  });
});
