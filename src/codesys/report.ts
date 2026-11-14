/**
 * A project report for the handover: what the project contains (tasks, POUs,
 * I/O, devices, libraries, alarms, HMI pages) as a readable Markdown document,
 * ending with a commissioning checklist built from the project itself. Pure:
 * the project_report action gathers the data and writes the file.
 */
import type { AlarmGroupDef } from "./alarm-tools.js";
import type { IoChannel } from "./devices.js";
import type { IoEntry } from "./outline.js";
import type { TreeNode } from "./st.js";
import { condition } from "./alarm-tools.js";

export interface ReportTask {
  name: string;
  kind?: string;
  interval?: string;
  interval_unit?: string;
  priority?: string;
  watchdog?: { enabled?: boolean; time?: string; time_unit?: string } | null;
  pous: string[];
}

export interface ReportInput {
  project: string;
  application?: string;
  compiler?: string;
  generated: string;
  nodes: TreeNode[];
  outline: string;
  tasks: ReportTask[];
  io: IoEntry[];
  mapped: IoChannel[];
  devices: string;
  libraries: { name: string; resolution?: string }[];
  alarms: AlarmGroupDef[];
  hmi: { name: string; title: string; widgets: number; variables: number }[];
  compile?: { errors: number; warnings: number };
}

const cell = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const table = (head: string[], rows: string[][]) => (rows.length ? [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n") : "_None._");
const interval = (t: ReportTask) => (t.interval ? `${t.interval}${t.interval_unit && !/[a-z]/i.test(t.interval) ? ` ${t.interval_unit}` : ""}` : "");

export function projectReport(r: ReportInput): string {
  const name = r.project.replace(/\\/g, "/").split("/").pop()!.replace(/\.project$/i, "");
  const count = (k: string) => r.nodes.filter((n) => n.kind === k).length;
  const pous = r.nodes.filter((n) => n.kind === "pou");
  const kindOf = (n: TreeNode) => /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION|INTERFACE)\b/i.exec(n.declaration ?? "")?.[1]?.toUpperCase();
  const programs = pous.filter((n) => kindOf(n) === "PROGRAM").length;
  const fbs = pous.filter((n) => kindOf(n) === "FUNCTION_BLOCK").length;
  const functions = pous.filter((n) => kindOf(n) === "FUNCTION").length;
  const called = new Set(r.tasks.flatMap((t) => t.pous.map((p) => p.toLowerCase())));
  const uncalled = pous.filter((n) => kindOf(n) === "PROGRAM" && !called.has(n.name.toLowerCase())).map((n) => n.name);
  const inputs = r.io.filter((x) => x.direction === "input");
  const outputs = r.io.filter((x) => x.direction === "output");
  const alarmCount = r.alarms.reduce((s, g) => s + g.alarms.length, 0);
  const persistent = r.nodes.filter((n) => /VAR_GLOBAL\s+(PERSISTENT|RETAIN)/i.test(n.declaration ?? "") || /persistent/i.test(n.sub ?? ""));

  const out: string[] = [];
  out.push(`# ${name}: project report`);
  out.push("");
  out.push(`Generated ${r.generated} by codesys-mcp-toolkit from \`${r.project}\`${r.compiler ? ` (compiler ${r.compiler})` : ""}. It describes the project as it is; check it against the machine before commissioning.`);
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push(`- **Application:** ${r.application ?? "?"}: ${programs} programs, ${fbs} function blocks, ${functions} functions, ${count("dut")} data types, ${count("gvl")} global variable lists.`);
  out.push(`- **Tasks:** ${r.tasks.map((t) => `${t.name} (${[t.kind, interval(t)].filter(Boolean).join(", ")})`).join("; ") || "none"}.`);
  if (uncalled.length) out.push(`- **Programs no task calls:** ${uncalled.join(", ")}. They never run.`);
  out.push(`- **I/O:** ${inputs.length} inputs and ${outputs.length} outputs declared with AT addresses${r.mapped.length ? `; ${r.mapped.length} channels mapped in the device tree` : ""}.`);
  out.push(`- **Alarms:** ${alarmCount ? `${alarmCount} in ${r.alarms.length} group(s) of CODESYS alarm management` : "none in CODESYS alarm management"}.`);
  out.push(`- **HMI:** ${r.hmi.length ? `${r.hmi.length} page(s): ${r.hmi.map((h) => h.title).join(", ")}` : "none"}.`);
  out.push(`- **Libraries:** ${r.libraries.length}.`);
  if (r.compile) out.push(`- **Last compile:** ${r.compile.errors} errors, ${r.compile.warnings} warnings.`);
  out.push("");

  out.push("## Tasks");
  out.push("");
  out.push(table(["Task", "Kind", "Interval", "Priority", "Watchdog", "Calls"], r.tasks.map((t) => [t.name, t.kind ?? "", interval(t), t.priority ?? "", t.watchdog?.enabled ? `${t.watchdog.time ?? ""}${t.watchdog.time_unit && t.watchdog.time && !/[a-z]/i.test(t.watchdog.time) ? ` ${t.watchdog.time_unit}` : ""}` : "off", t.pous.join(", ")])));
  out.push("");

  out.push("## I/O");
  out.push("");
  out.push(table(["Address", "Variable", "Type", "Direction", "Comment"], r.io.map((x) => [x.at, `${x.owner}.${x.name}`, x.type, x.direction, x.comment ?? ""])));
  if (r.mapped.length) {
    out.push("");
    out.push("Mapped in the device tree:");
    out.push("");
    out.push(table(["Address", "Variable", "Device", "Channel", "Description"], r.mapped.map((c) => [c.address, c.variable.replace(/^Application\./, ""), c.device, c.parameter, c.description])));
  }
  out.push("");

  out.push("## Alarms");
  out.push("");
  out.push(table(["Group", "ID", "Class", "Message", "Condition"], r.alarms.flatMap((g) => g.alarms.map((a) => [g.name, a.id, a.cls, a.text, condition(a)]))));
  out.push("");

  out.push("## HMI pages");
  out.push("");
  out.push(table(["Page", "Title", "Widgets", "Variables"], r.hmi.map((h) => [h.name, h.title, String(h.widgets), String(h.variables)])));
  out.push("");

  out.push("## Libraries");
  out.push("");
  out.push(table(["Library", "Resolved to"], r.libraries.map((l) => [l.name, l.resolution ?? ""])));
  out.push("");

  out.push("## Devices");
  out.push("");
  out.push("```text", r.devices.trim() || "No devices.", "```");
  out.push("");

  out.push("## Program structure");
  out.push("");
  out.push("```text", r.outline.trim(), "```");
  out.push("");

  out.push("## Commissioning checklist");
  out.push("");
  out.push("Tested so far only in CODESYS's simulation. On the machine, with the responsible engineer:");
  out.push("");
  const box = (s: string) => out.push(`- [ ] ${s}`);
  box("Safety functions (emergency stop, guards, interlocks) are designed and verified separately; this program is not a safety controller.");
  box("The controller, its runtime version and the device tree match the real hardware; the project compiles with 0 errors for the real target.");
  for (const t of r.tasks) box(`Task ${t.name}: ${t.watchdog?.enabled ? "the cycle time and watchdog hold" : "the cycle time holds"} on the real controller (${[t.kind, interval(t)].filter(Boolean).join(", ")}).`);
  if (uncalled.length) box(`Programs no task calls (${uncalled.join(", ")}): intended, or add them to a task.`);
  for (const x of inputs) box(`Input ${x.at} ${x.owner}.${x.name}${x.comment ? ` (${x.comment})` : ""}: changes when the field device does.`);
  for (const x of outputs) box(`Output ${x.at} ${x.owner}.${x.name}${x.comment ? ` (${x.comment})` : ""}: drives the right actuator, and is safe when the controller stops.`);
  for (const c of r.mapped) box(`Channel ${c.address || c.parameter} of ${c.device} -> ${c.variable.replace(/^Application\./, "")}: wired and scaled correctly.`);
  for (const g of r.alarms) for (const a of g.alarms) box(`Alarm ${g.name}/${a.id} "${a.text}": raise ${condition(a)} on the machine; it shows with class ${a.cls || "?"} and can be acknowledged.`);
  for (const h of r.hmi) box(`HMI page ${h.title}: every value matches the machine and every button does what its label says.`);
  if (persistent.length) box(`Persistent/retain variables (${persistent.map((p) => p.name).join(", ")}): keep their values over a power cycle and a download.`);
  box("Setpoints, limits and timers are set for the real process, not the simulation's.");
  box("The project is archived (Project Archive) and versioned after commissioning.");
  out.push("");
  return out.join("\n");
}
