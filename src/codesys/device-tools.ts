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

export function registerDeviceActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const b = ctx.bridge;
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
