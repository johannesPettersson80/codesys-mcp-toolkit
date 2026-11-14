/**
 * Devices from CODESYS's device repository: find installed device descriptions
 * (fieldbus masters and slaves, I/O modules) and add them to the device tree
 * (watcher/mcp_devices.py). Offline: nothing goes online.
 */
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import type { AppContext } from "../tools.js";

interface Desc {
  name: string;
  vendor: string;
  description: string;
  type?: number;
  id?: string;
  version?: string;
  order_number?: string;
}

export interface DeviceParam {
  key: string;
  name: string;
  depth: number;
  description?: string;
  unit?: string;
  section?: string;
  type?: string;
  access?: string;
  channel?: string;
  value?: string;
  default?: string;
  choices?: string[];
  mapping?: { variable: string; address: string; automatic_address: boolean };
}

/** One parameter or channel as a line: key, name, value (and choices), mapping. */
export function describeParam(p: DeviceParam): string {
  const pad = "  ".repeat(p.depth);
  const val = p.value !== undefined ? ` = ${p.value}${p.unit ? ` ${p.unit}` : ""}` : "";
  const choices = p.choices?.length ? ` (one of ${p.choices.slice(0, 12).join(", ")}${p.choices.length > 12 ? ", ..." : ""})` : "";
  const map = p.mapping ? ` -> ${p.mapping.variable || "(not mapped)"}${p.mapping.address ? ` at ${p.mapping.address}${p.mapping.automatic_address ? "" : " (fixed)"}` : ""}` : "";
  const ch = p.channel ? ` [${p.channel.toLowerCase()} channel${p.type ? ` ${p.type}` : ""}]` : p.type && p.depth === 0 ? ` [${p.type}]` : "";
  const ro = p.access && /^read$|readonly|none/i.test(p.access) ? " (read-only)" : "";
  return `${pad}${p.key}  ${p.name}${ch}${val}${choices}${map}${ro}`;
}

export function registerDeviceActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const b = ctx.bridge;
  reg(
    "device_parameters",
    {
      description:
        "A device's parameters and I/O channels from its device description (the device and its connectors' parameters, nested elements indented): key, name, value with unit and allowed choices, and for each I/O channel the variable it is mapped to. Use the keys with configure_device. Offline; nothing goes online.",
      inputSchema: z.object({
        device: z.string().describe("Device path from get_devices, e.g. '/PLCWinNT/Ethernet/Modbus_TCP_Server'"),
        filter: z.string().optional().describe("Only parameters whose key, name or section contains this text"),
        channels: z.boolean().optional().describe("Only I/O channels"),
        depth: z.number().int().min(0).max(8).optional().describe("Nesting shown: 0 = parameters only, 1 (default) = also their elements (e.g. each register), 2 = also bits"),
      }),
    },
    async ({ device, filter, channels, depth }) =>
      run(async () => {
        const r = await b.call<{ path: string; parameters: DeviceParam[]; truncated: boolean }>("devices.params", { path: device, limit: 3000 }, { timeoutMs: 120_000 });
        let ps = r.parameters;
        if (channels) ps = ps.filter((p) => p.mapping);
        const max = depth ?? (filter ? 8 : 1);
        const hidden = ps.filter((p) => p.depth > max).length;
        ps = ps.filter((p) => p.depth <= max);
        if (filter) {
          const f = filter.toLowerCase();
          ps = ps.filter((p) => `${p.key} ${p.name} ${p.section ?? ""}`.toLowerCase().includes(f));
        }
        if (!ps.length) return `${r.path}: no ${channels ? "I/O channels" : "parameters"}${filter ? ` matching '${filter}'` : ""}.`;
        const nChan = ps.filter((p) => p.mapping).length;
        return [
          `${r.path}: ${ps.length} parameter element(s)${nChan ? `, ${nChan} I/O channel(s)` : ""}${r.truncated ? " (the first 3000)" : ""}:`,
          ...ps.map(describeParam),
          ...(hidden ? [`(${hidden} nested element(s) deeper than ${max} not shown: pass depth or filter)`] : []),
        ].join("\n");
      }),
  );
  reg(
    "configure_device",
    {
      description:
        "Set a device's parameters and map its I/O channels to variables (keys from device_parameters). values: {key: value} (an enumeration takes its identifier or name). mappings: [{channel: key, variable, address?}]: variable is an existing variable as 'Application.GVL_IO.xValve', or a plain name to let CODESYS create one; '' unmaps; address fixes the IEC address (e.g. '%IX10.0'), null makes it automatic. Offline; compile afterwards.",
      inputSchema: z.object({
        device: z.string(),
        values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        mappings: z.array(z.object({ channel: z.string(), variable: z.string(), address: z.string().nullable().optional() })).optional(),
      }),
    },
    async ({ device, values, mappings }) =>
      run(async () => {
        const r = await b.call<{ path: string; done: { key: string; value?: string; variable?: string; address?: string }[]; errors: { key: string; error: string }[]; saved?: boolean }>(
          "devices.configure",
          {
            path: device,
            values: Object.entries(values ?? {}).map(([key, value]) => ({ key, value: String(value) })),
            mappings: (mappings ?? []).map((m) => ({ key: m.channel, variable: m.variable, ...(m.address !== undefined ? { address: m.address } : {}) })),
            save: ctx.autosave,
          },
          { timeoutMs: 120_000 },
        );
        return [
          `${r.path}: ${r.done.length} change(s)${r.errors.length ? `, ${r.errors.length} failed` : ""}.`,
          ...r.done.map((d) => (d.variable !== undefined ? `  ${d.key} -> ${d.variable || "(not mapped)"}${d.address ? ` at ${d.address}` : ""}` : `  ${d.key} = ${d.value}`)),
          ...r.errors.map((e) => `  FAILED ${e.key}: ${e.error}`),
          r.done.length ? "Compile to check." : "",
        ].filter(Boolean).join("\n");
      }),
  );
  reg(
    "find_device",
    {
      description: "Search the device descriptions installed in CODESYS (fieldbus masters and slaves such as Modbus TCP, EtherCAT, CANopen, PROFINET; I/O modules; drives) by name. Returns type, id and version to pass to add_device.",
      inputSchema: z.object({ text: z.string().describe("Part of the device name, e.g. 'Modbus TCP', 'EtherCAT Master', 'CANopen'"), limit: z.number().int().min(1).max(100).default(30) }),
    },
    async ({ text, limit }) =>
      run(async () => {
        const r = await b.call<{ devices: Desc[]; more: boolean }>("devices.search", { text, limit }, { timeoutMs: 120_000 });
        if (!r.devices.length) return `No installed device description matches '${text}'. Install it with the CODESYS Installer or Tools > Device Repository.`;
        return [
          `${r.devices.length}${r.more ? "+" : ""} device(s) matching '${text}':`,
          ...r.devices.map((d) => `- ${d.name} (${d.vendor}${d.version ? `, ${d.version}` : ""}) type=${d.type} id='${d.id}' version='${d.version}'${d.description ? `: ${d.description}` : ""}`),
        ].join("\n");
      }),
  );
  reg(
    "add_device",
    {
      description: "Add a device from the repository to the device tree, under a device: the controller (its name from get_devices, e.g. '/Device' or '/PLCWinNT') for an Ethernet adapter or bus interface, the adapter for a fieldbus master, the master for its slaves. Use type, id and version from find_device. 'plug' fills a slot of a device with fixed slots. Then map its I/O channels (get_devices shows them) and compile.",
      inputSchema: z.object({
        parent: z.string().describe("Device to add under, e.g. '/PLCWinNT' or '/PLCWinNT/Ethernet'"),
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe("Name of the new device, e.g. 'Modbus_TCP_Master'"),
        type: z.number().int(),
        id: z.string(),
        version: z.string(),
        module: z.string().optional(),
        how: z.enum(["add", "insert", "plug"]).default("add"),
        index: z.number().int().optional().describe("Position for insert"),
      }),
    },
    async (a) =>
      run(async () => {
        const r = await b.call<{ path: string }>("devices.add", { ...a, save: ctx.autosave }, { timeoutMs: 120_000 });
        return `Added ${a.name} at ${r.path}. Call get_devices to see its I/O channels, and compile.`;
      }),
  );
}
