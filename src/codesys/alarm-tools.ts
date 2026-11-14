/**
 * CODESYS alarm management, read and operated in the simulation: the Alarm
 * Configuration's groups and alarms (watcher op alarms.list), each alarm's
 * state from CODESYS's alarm manager, and acknowledging.
 *
 * The code CODESYS generates for an Alarm Configuration holds one instance per
 * group, __Alm__GVL.g_inst.gen_Inst_<group>_AlarmGroup, whose gen_ArrAllAlarms[k]
 * is the k-th alarm of the group (checked on SP21: m_uiId = k). m_eState is its
 * AlarmState; writing TRUE to m_xToAcknowledge acknowledges or confirms it in
 * the next cycle, as an alarm table's Acknowledge button does. Writes go only
 * to CODESYS's own simulation.
 */
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import type { AppContext } from "../tools.js";
import { currentCodesysSim } from "./simulation.js";
import { HISTORY, historyCode, installHistory, readHistory } from "./alarm-history.js";

export interface AlarmDef {
  id: string;
  kind: string;
  expression: string;
  comparison: string;
  compare_to: string;
  cls: string;
  text: string;
}
export interface AlarmGroupDef {
  name: string;
  alarms: AlarmDef[];
}

/** The PLC variable of the k-th alarm of a group. */
export const alarmPath = (group: string, k: number) => `__Alm__GVL.g_inst.gen_Inst_${group}_AlarmGroup.gen_ArrAllAlarms[${k}]`;

export type AlarmStateName = "normal" | "pending" | "active" | "waiting" | "acknowledged" | "unacknowledged" | "unknown";

/** AlarmState as read from the simulation ('AlarmState.Active', or the number). */
export function alarmState(raw: string | undefined): AlarmStateName {
  const v = (raw ?? "").replace(/^AlarmState\./, "").replace(/^[A-Z_]+#/, "").trim();
  const by: Record<string, AlarmStateName> = { Normal: "normal", "0": "normal", Pending: "pending", "1": "pending", Active: "active", "2": "active", WaitingForConfirmation: "waiting", "3": "waiting", ActiveAcknowledged: "acknowledged", "4": "acknowledged", InactiveUnacknowledged: "unacknowledged", "5": "unacknowledged" };
  return by[v] ?? "unknown";
}

export const STATE_TEXT: Record<AlarmStateName, string> = {
  normal: "normal",
  pending: "pending (on-delay running)",
  active: "ACTIVE",
  waiting: "cleared, waiting for confirmation",
  acknowledged: "ACTIVE, acknowledged",
  unacknowledged: "cleared, not acknowledged",
  unknown: "unknown",
};

const OPS: Record<string, string> = { Equal: "=", NotEqual: "<>", Greater: ">", GreaterOrEqual: ">=", Less: "<", LessOrEqual: "<=" };
export const condition = (a: AlarmDef) => `${a.expression} ${OPS[a.comparison] ?? a.comparison} ${a.compare_to}`;

export async function listAlarms(ctx: AppContext): Promise<AlarmGroupDef[]> {
  return (await ctx.bridge.call<{ groups: AlarmGroupDef[] }>("alarms.list", {}, { timeoutMs: 60_000 })).groups;
}

/** Each alarm's state from the running simulation. */
export async function readAlarmStates(ctx: AppContext, groups: AlarmGroupDef[]): Promise<Map<string, AlarmStateName>> {
  const names = groups.flatMap((g) => g.alarms.map((_, k) => `${alarmPath(g.name, k)}.m_eState`));
  const out = new Map<string, AlarmStateName>();
  if (!names.length) return out;
  const r = await ctx.bridge.call<{ values: Record<string, string | undefined> }>("sim.read", { names }, { timeoutMs: 10_000 });
  for (const g of groups) g.alarms.forEach((a, k) => out.set(`${g.name}/${a.id}`, alarmState(r.values?.[`${alarmPath(g.name, k)}.m_eState`])));
  return out;
}

/** Acknowledge (or confirm) alarms in the simulation; returns the keys written. */
export async function acknowledgeAlarms(ctx: AppContext, groups: AlarmGroupDef[], keys: Set<string>): Promise<string[]> {
  const values: Record<string, string> = {};
  const done: string[] = [];
  for (const g of groups)
    g.alarms.forEach((a, k) => {
      const key = `${g.name}/${a.id}`;
      if (keys.has(key)) (values[`${alarmPath(g.name, k)}.m_xToAcknowledge`] = "TRUE"), done.push(key);
    });
  if (done.length) await ctx.bridge.call("sim.write", { values }, { timeoutMs: 10_000 });
  return done;
}

export function registerAlarmActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const pick = (groups: AlarmGroupDef[], group?: string) => (group ? groups.filter((g) => g.name.toLowerCase() === group.toLowerCase()) : groups);
  const needSim = () => {
    if (!currentCodesysSim(ctx)) throw new Error("The simulation isn't running: start it with codesys_sim_start and codesys_sim_control (run).");
  };

  reg(
    "alarm_list",
    {
      description: "The project's CODESYS alarm management (Alarm Configuration): each alarm group with its alarms' IDs, conditions, classes and messages. hmi_export_codesys puts an HMI's alarms in group AG_HMI.",
      inputSchema: z.object({}),
    },
    async () =>
      run(async () => {
        const groups = await listAlarms(ctx);
        if (!groups.length) return "This project has no Alarm Configuration (or no alarm groups in it).";
        return groups.map((g) => [`${g.name} (${g.alarms.length} alarms):`, ...g.alarms.map((a) => `  ${a.id}  [${a.cls || "?"}] ${a.text || "(no message)"}  when ${condition(a)}`)].join("\n")).join("\n");
      }),
  );

  reg(
    "create_alarm_history",
    {
      description:
        "Record the alarms' history in the PLC: generated ST (ST_AlarmEvent, GVL_AlarmHistory with a RETAIN ring buffer, F_AlarmHistoryAdd, PRG_AlarmHistory called from MainTask) that logs every state change of every alarm (active, cleared, acknowledged, normal) with CODESYS's own time of the change. CODESYS's runtime alarm forgets its times once it is normal again. alarm_history reads it; hmi_export_codesys adds it on its own. Recreate it after adding alarms.",
      inputSchema: z.object({ size: z.number().int().min(10).max(1000).default(100).describe("Events kept (oldest dropped first)") }),
    },
    async ({ size }) =>
      run(async () => {
        const groups = await listAlarms(ctx);
        const code = historyCode(groups, size);
        const task = await installHistory(ctx, code, ctx.autosave);
        return `Alarm history for ${code.alarms} alarm(s) in ${groups.map((g) => g.name).join(", ")}: ${HISTORY.program}${task ? ` (called from ${task})` : " (add it to a task with configure_task)"} records each state change in ${HISTORY.gvl}.aEvents (RETAIN, ${size} events). Compile, start the simulation, then alarm_history.`;
      }),
  );

  reg(
    "alarm_history",
    {
      description: "The recorded alarm events from the running simulation, newest first: time, alarm, message and the state it went to (needs create_alarm_history, or an HMI exported with hmi_export_codesys).",
      inputSchema: z.object({ limit: z.number().int().min(1).max(1000).default(30) }),
    },
    async ({ limit }) =>
      run(async () => {
        needSim();
        const [h, groups] = await Promise.all([readHistory(ctx, limit), listAlarms(ctx)]);
        if (!h.events.length) return "No alarm events recorded yet.";
        const text = (g: string, id: string) => groups.find((x) => x.name === g)?.alarms.find((a) => a.id === id)?.text ?? "";
        return [
          `Alarm history (${h.events.length} of ${h.stored} stored, newest first; the buffer keeps ${h.size}):`,
          ...h.events.map((e) => `  ${e.time}  ${`${e.group}/${e.alarm}`.padEnd(12)} ${STATE_TEXT[e.state].padEnd(34)} ${text(e.group, e.alarm)}`),
        ].join("\n");
      }),
  );

  reg(
    "alarm_status",
    {
      description:
        "The state of every CODESYS alarm in the running simulation, from CODESYS's own alarm manager: normal, pending, ACTIVE, ACTIVE acknowledged, or cleared but not yet acknowledged/confirmed. Use it to test alarms: force the condition, run, check it's ACTIVE, clear it, acknowledge, check it's normal. The state variables are listed for codesys_sim_test (expect 'AlarmState.Active' etc.).",
      inputSchema: z.object({ group: z.string().optional().describe("One alarm group (default: all)") }),
    },
    async ({ group }) =>
      run(async () => {
        needSim();
        const groups = pick(await listAlarms(ctx), group);
        if (!groups.length) return group ? `No alarm group named '${group}'.` : "This project has no CODESYS alarms.";
        const states = await readAlarmStates(ctx, groups);
        const lines: string[] = [];
        let open = 0;
        for (const g of groups) {
          lines.push(`${g.name}:`);
          g.alarms.forEach((a) => {
            const s = states.get(`${g.name}/${a.id}`) ?? "unknown";
            if (s !== "normal") open++;
            lines.push(`  ${a.id.padEnd(4)} ${STATE_TEXT[s].padEnd(34)} [${a.cls || "?"}] ${a.text || "(no message)"}  (${condition(a)})`);
          });
        }
        lines.push(open ? `${open} alarm(s) not normal. alarm_acknowledge acknowledges them (an alarm whose condition is still true stays active).` : "All alarms normal.");
        lines.push(`State variables: ${alarmPath(groups[0]!.name, 0)}.m_eState and so on (index = position in the group, from 0).`);
        return lines.join("\n");
      }),
  );

  reg(
    "alarm_acknowledge",
    {
      description: "Acknowledge (or confirm) CODESYS alarms in the simulation, as an operator would at the alarm table: by default every alarm that isn't normal. Returns each alarm's state before and after. Only CODESYS's own simulation is written.",
      inputSchema: z.object({
        group: z.string().optional(),
        ids: z.array(z.string()).optional().describe("Alarm IDs in the group (default: all that aren't normal)"),
      }),
    },
    async ({ group, ids }) =>
      run(async () => {
        needSim();
        const groups = pick(await listAlarms(ctx), group);
        if (!groups.length) return group ? `No alarm group named '${group}'.` : "This project has no CODESYS alarms.";
        const before = await readAlarmStates(ctx, groups);
        const wanted = new Set<string>();
        for (const g of groups) for (const a of g.alarms) if (ids ? ids.includes(a.id) : before.get(`${g.name}/${a.id}`) !== "normal") wanted.add(`${g.name}/${a.id}`);
        if (!wanted.size) return "Nothing to acknowledge: every alarm is normal.";
        const done = await acknowledgeAlarms(ctx, groups, wanted);
        await new Promise((r) => setTimeout(r, 500));
        const after = await readAlarmStates(ctx, groups);
        return [`Acknowledged ${done.length} alarm(s):`, ...done.map((k) => `  ${k}: ${STATE_TEXT[before.get(k) ?? "unknown"]} -> ${STATE_TEXT[after.get(k) ?? "unknown"]}`)].join("\n");
      }),
  );
}
