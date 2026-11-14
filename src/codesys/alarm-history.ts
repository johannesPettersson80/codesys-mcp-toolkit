/**
 * An alarm history in the PLC, as generated ST: CODESYS's runtime alarm keeps only its
 * current state (its timestamps go back to 0 once it is normal again), and its alarm
 * storage is a database scripts can't read. PRG_AlarmHistory watches every alarm's
 * state each cycle and, on a change, records the time of that transition
 * (m_liTimestampLast, a FILETIME with the local offset in m_iOffsetLast; checked on
 * SP21) with the group, the alarm ID and the new state in a RETAIN ring buffer.
 */
import type { AppContext } from "../tools.js";
import { alarmPath, alarmState, type AlarmGroupDef, type AlarmStateName } from "./alarm-tools.js";
import type { TreeNode } from "./st.js";

export const HISTORY = { dut: "ST_AlarmEvent", gvl: "GVL_AlarmHistory", fn: "F_AlarmHistoryAdd", program: "PRG_AlarmHistory" } as const;

export interface HistoryCode {
  dut: { name: string; declaration: string };
  gvl: { name: string; declaration: string };
  fn: { name: string; declaration: string; implementation: string };
  program: { name: string; declaration: string; implementation: string };
  alarms: number;
}

/** The ST for a history of these groups' alarms, `size` events long. */
export function historyCode(groups: AlarmGroupDef[], size = 100): HistoryCode {
  const all = groups.flatMap((g) => g.alarms.map((a, k) => ({ group: g.name, id: a.id, path: alarmPath(g.name, k) })));
  if (!all.length) throw new Error("There are no alarms to record: configure alarms first (alarm groups in the Alarm Configuration).");
  const q = (s: string) => `'${s.replace(/'/g, "$$'")}'`;
  const dut = {
    name: HISTORY.dut,
    declaration: [
      `TYPE ${HISTORY.dut} :`,
      "STRUCT",
      "    dtTime : DT;          // local time of the state change",
      "    sGroup : STRING(40);  // alarm group",
      "    sAlarm : STRING(40);  // alarm ID in the group",
      "    iState : INT;         // 0 normal, 1 pending, 2 active, 3 cleared waiting for confirmation, 4 active acknowledged, 5 cleared unacknowledged",
      "END_STRUCT",
      "END_TYPE",
    ].join("\n"),
  };
  const gvl = {
    name: HISTORY.gvl,
    declaration: [
      "{attribute 'qualified_only'}",
      "VAR_GLOBAL RETAIN",
      `    aEvents : ARRAY[0..${size - 1}] OF ${HISTORY.dut};  // ring buffer`,
      "    iNext : INT;   // where the next event goes",
      "    iCount : INT;  // events stored",
      "END_VAR",
      "VAR_GLOBAL CONSTANT",
      `    iSize : INT := ${size};`,
      "END_VAR",
    ].join("\n"),
  };
  const fn = {
    name: HISTORY.fn,
    declaration: [
      `FUNCTION ${HISTORY.fn} : BOOL`,
      "VAR_INPUT",
      "    sGroup : STRING(40);",
      "    sAlarm : STRING(40);",
      "    iState : INT;",
      "    liTimestamp : LINT;  // FILETIME: 100 ns since 1601, UTC",
      "    iOffset : INT;       // minutes to local time",
      "END_VAR",
    ].join("\n"),
    implementation: [
      `IF ${HISTORY.gvl}.iNext < 0 OR ${HISTORY.gvl}.iNext >= ${HISTORY.gvl}.iSize THEN`,
      `    ${HISTORY.gvl}.iNext := 0;`,
      "END_IF",
      "IF liTimestamp > 0 THEN",
      `    ${HISTORY.gvl}.aEvents[${HISTORY.gvl}.iNext].dtTime := LINT_TO_DT(liTimestamp / 10000000 - 11644473600 + INT_TO_LINT(iOffset) * 60);`,
      "ELSE",
      `    ${HISTORY.gvl}.aEvents[${HISTORY.gvl}.iNext].dtTime := DT#1970-01-01-00:00:00;`,
      "END_IF",
      `${HISTORY.gvl}.aEvents[${HISTORY.gvl}.iNext].sGroup := sGroup;`,
      `${HISTORY.gvl}.aEvents[${HISTORY.gvl}.iNext].sAlarm := sAlarm;`,
      `${HISTORY.gvl}.aEvents[${HISTORY.gvl}.iNext].iState := iState;`,
      `${HISTORY.gvl}.iNext := (${HISTORY.gvl}.iNext + 1) MOD ${HISTORY.gvl}.iSize;`,
      `IF ${HISTORY.gvl}.iCount < ${HISTORY.gvl}.iSize THEN`,
      `    ${HISTORY.gvl}.iCount := ${HISTORY.gvl}.iCount + 1;`,
      "END_IF",
      `${HISTORY.fn} := TRUE;`,
    ].join("\n"),
  };
  const impl: string[] = ["// Generated: records each alarm's state changes (see GVL_AlarmHistory)."];
  all.forEach((a, k) => {
    impl.push(
      `iNow := TO_INT(${a.path}.m_eState);`,
      `IF xInit AND iNow <> aPrev[${k}] THEN`,
      `    ${HISTORY.fn}(sGroup := ${q(a.group)}, sAlarm := ${q(a.id)}, iState := iNow, liTimestamp := ${a.path}.m_liTimestampLast, iOffset := ${a.path}.m_iOffsetLast);`,
      "END_IF",
      `aPrev[${k}] := iNow;`,
    );
  });
  impl.push("xInit := TRUE;  // the first cycle only takes the states as they are");
  const program = {
    name: HISTORY.program,
    declaration: [`PROGRAM ${HISTORY.program}`, "VAR", `    aPrev : ARRAY[0..${all.length - 1}] OF INT;`, "    iNow : INT;", "    xInit : BOOL;", "END_VAR"].join("\n"),
    implementation: impl.join("\n"),
  };
  return { dut, gvl, fn, program, alarms: all.length };
}

/** Create or replace the generated objects and call the program from MainTask. Returns the task it runs in. */
export async function installHistory(ctx: AppContext, code: HistoryCode, save: boolean): Promise<string> {
  const b = ctx.bridge;
  const nodes = (await b.call<{ nodes: TreeNode[] }>("export", {}, { timeoutMs: 120_000 })).nodes;
  const exists = (name: string) => nodes.some((x) => x.name.toLowerCase() === name.toLowerCase());
  const put = async (kind: string, o: { name: string; declaration: string; implementation?: string }) => {
    if (exists(o.name)) await b.call("object.write", { path: o.name, declaration: o.declaration, ...(o.implementation ? { implementation: o.implementation } : {}), save: false });
    else await b.call("object.create", { kind, name: o.name, declaration: o.declaration, ...(o.implementation ? { implementation: o.implementation } : {}), ...(kind === "function" ? { return_type: "BOOL" } : {}), save: false });
  };
  await put("dut", code.dut);
  await put("gvl", code.gvl);
  await put("function", code.fn);
  await put("program", code.program);
  for (const t of ["MainTask", "Task"]) {
    try {
      await b.call("task.configure", { name: t, add_calls: [code.program.name], save });
      return t;
    } catch {
      /* try the next */
    }
  }
  return "";
}

export interface HistoryEvent {
  time: string;
  group: string;
  alarm: string;
  state: AlarmStateName;
}

/** 'YYYY-MM-DD hh:mm:ss' from CODESYS's DT text, which leaves out leading zeros ('2026-11-14-18:5:5'). */
export function dtText(t: string): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2}):(\d{1,2}):(\d{1,2})/.exec(t);
  if (!m) return t;
  const p = (x: string) => x.padStart(2, "0");
  return `${m[1]}-${p(m[2]!)}-${p(m[3]!)} ${p(m[4]!)}:${p(m[5]!)}:${p(m[6]!)}`;
}

/** The recorded events from the running simulation, newest first. */
export async function readHistory(ctx: AppContext, limit = 50): Promise<{ events: HistoryEvent[]; stored: number; size: number }> {
  const b = ctx.bridge;
  const head = await b.call<{ values: Record<string, string | undefined>; errors?: Record<string, string> }>(
    "sim.read",
    { names: [`${HISTORY.gvl}.iNext`, `${HISTORY.gvl}.iCount`, `${HISTORY.gvl}.iSize`] },
    { timeoutMs: 10_000 },
  );
  if (head.errors?.[`${HISTORY.gvl}.iCount`]) throw new Error("No alarm history in this project: create_alarm_history adds it (hmi_export_codesys does too), then start the simulation again.");
  const num = (v?: string) => Number(String(v ?? "0").replace(/^[A-Z_]+#/i, ""));
  const next = num(head.values[`${HISTORY.gvl}.iNext`]);
  const count = num(head.values[`${HISTORY.gvl}.iCount`]);
  const size = num(head.values[`${HISTORY.gvl}.iSize`]) || 1;
  const n = Math.min(count, limit);
  const idx = Array.from({ length: n }, (_, k) => (((next - 1 - k) % size) + size) % size);
  const names = idx.flatMap((i) => ["dtTime", "sGroup", "sAlarm", "iState"].map((f) => `${HISTORY.gvl}.aEvents[${i}].${f}`));
  const r = names.length ? await b.call<{ values: Record<string, string | undefined> }>("sim.read", { names }, { timeoutMs: 15_000 }) : { values: {} as Record<string, string | undefined> };
  const unq = (v?: string) => String(v ?? "").replace(/^'(.*)'$/, "$1");
  const events = idx.map((i) => {
    const f = (x: string) => r.values[`${HISTORY.gvl}.aEvents[${i}].${x}`];
    const t = String(f("dtTime") ?? "").replace(/^(DT|DATE_AND_TIME)#/i, "");
    return { time: dtText(t), group: unq(f("sGroup")), alarm: unq(f("sAlarm")), state: alarmState(String(num(f("iState")))) };
  });
  return { events, stored: count, size };
}
