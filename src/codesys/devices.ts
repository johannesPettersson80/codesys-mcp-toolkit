/** The device tree and its I/O mapping, as CODESYS exports it. Pure: parsing and formatting only. */

export interface DeviceInfo {
  /** Path from the project root, e.g. "Device/Plc Logic/..." or "PLCWinNT/EtherCAT_Master/EL1008". */
  path: string;
  name: string;
  depth: number;
  type?: number | null;
  id?: string;
  version?: string;
  /** Module id of a module (a device inside its owner, e.g. local I/O); its type and id are the owner's. */
  module?: string | null;
  enabled?: boolean | null;
  /** The device's I/O mapping in CODESYS's CSV export format (only when it has channels). */
  io_csv?: string;
  io_error?: string;
}

export interface IoChannel {
  /** The mapped variable, e.g. "Application.GVL_IO.xValve"; empty when nothing is mapped. */
  variable: string;
  /** "Parameter name @ counter in device", e.g. "Input@1" or "Bit0@3". */
  parameter: string;
  unit: string;
  description: string;
  /** IEC address, e.g. "%IX0.0". */
  address: string;
  device: string;
}

/** Split one CSV line, honouring double quotes. */
function splitCsv(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parse CODESYS's I/O mapping export ("//CoDeSys Mapping Export V1.2"): comment lines start
 * with "//"; the column header names "Mapped variable", "Parameter name @ counter in device",
 * "Unit", "Description", "IEC address", "Device name". The separator is taken from that header.
 */
export function parseIoMappingCsv(text: string): IoChannel[] {
  const lines = text.split(/\r?\n/);
  const header = lines.find((l) => /mapped variable/i.test(l)) ?? "";
  const sep = [";", "\t", ","].find((s) => header.includes(s)) ?? ",";
  const names = splitCsv(header, sep).map((h) => h.replace(/^\/\//, "").trim().toLowerCase());
  const col = (re: RegExp, fallback: number) => {
    const i = names.findIndex((n) => re.test(n));
    return i >= 0 ? i : fallback;
  };
  const at = {
    variable: col(/^mapped variable/, 0),
    parameter: col(/^parameter/, 1),
    unit: col(/^unit/, 2),
    description: col(/^description/, 3),
    address: col(/address$/, 4),
    device: col(/^device/, 5),
  };
  const out: IoChannel[] = [];
  for (const l of lines) {
    if (!l.trim() || l.startsWith("//")) continue;
    const c = splitCsv(l, sep);
    out.push({
      variable: c[at.variable] ?? "",
      parameter: c[at.parameter] ?? "",
      unit: c[at.unit] ?? "",
      description: c[at.description] ?? "",
      address: c[at.address] ?? "",
      device: c[at.device] ?? "",
    });
  }
  return out;
}

/** "Application.GVL_IO.xValve" -> "GVL_IO.xValve" (the toolkit's paths are relative to the application). */
export const shortVariable = (v: string) => v.replace(/^[A-Za-z_][A-Za-z0-9_]*\.(?=[A-Za-z_][A-Za-z0-9_]*\.)/, "");

/**
 * The channels mapped to variables across the device tree, each once: a device's
 * export of its I/O mapping also contains its children's, so the same channel
 * shows up under every device above it.
 */
export function mappedChannels(devices: DeviceInfo[]): IoChannel[] {
  const seen = new Set<string>();
  const out: IoChannel[] = [];
  for (const d of devices)
    for (const c of d.io_csv ? parseIoMappingCsv(d.io_csv) : []) {
      if (!c.variable) continue;
      const k = `${c.device}|${c.parameter}|${c.address}|${c.variable}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  return out;
}

/** A device and the devices under it, found by path ("/PLC/EK1100" or "PLC/EK1100") or by a unique name. */
export function deviceSubtree(devices: DeviceInfo[], device: string): DeviceInfo[] {
  const want = device.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  let i = devices.findIndex((d) => d.path.toLowerCase() === want);
  if (i < 0) {
    const byName = devices.flatMap((d, j) => (d.name.toLowerCase() === want ? [j] : []));
    if (byName.length > 1) throw new Error(`${byName.length} devices are named '${device}': give the path, one of ${byName.map((j) => `'${devices[j]!.path}'`).join(", ")}.`);
    i = byName[0] ?? -1;
  }
  if (i < 0) throw new Error(`No device '${device}' in the project (get_devices lists them).`);
  const root = devices[i]!;
  const out = [root];
  for (const d of devices.slice(i + 1)) {
    if (d.depth <= root.depth) break;
    out.push(d);
  }
  return out;
}

export interface DescribeOptions {
  /**
   * List every channel of a device only up to this many; a bigger device lists its mapped
   * channels and counts the rest. A fieldbus adapter can have thousands of unmapped channels.
   */
  maxChannels?: number;
}

export function describeDevices(devices: DeviceInfo[], opts: DescribeOptions = {}): string {
  if (!devices.length) return "No devices in the project.";
  const max = opts.maxChannels ?? Infinity;
  const lines: string[] = [];
  for (const d of devices) {
    const ident = d.module
      ? ` (module ${d.module}${d.version ? `, version ${d.version}` : ""})`
      : d.id
        ? ` (type ${d.type ?? "?"}, id ${d.id}, version ${d.version ?? "?"})`
        : "";
    // A device's export also lists its children's channels: keep its own (the export names the device of each).
    const all = d.io_csv ? parseIoMappingCsv(d.io_csv) : [];
    const own = all.filter((c) => !c.device || c.device === d.name);
    const channels = own.length || !all.length ? own : all.filter((c) => !devices.some((o) => o !== d && o.name === c.device));
    const mapped = channels.filter((c) => c.variable).length;
    lines.push(
      `${"  ".repeat(d.depth)}${d.name}${ident}${d.enabled === false ? " [disabled]" : ""}${channels.length ? `: ${channels.length} channel(s), ${mapped} mapped` : ""}${d.io_error ? ` (I/O mapping not readable: ${d.io_error})` : ""}`,
    );
    const pad = "  ".repeat(d.depth + 1);
    const big = channels.length > max;
    for (const c of big ? channels.filter((c) => c.variable) : channels) {
      lines.push(`${pad}${(c.address || "-").padEnd(10)} ${c.parameter}${c.description ? ` ${c.description}` : ""}${c.unit ? ` [${c.unit}]` : ""} -> ${c.variable ? shortVariable(c.variable) : "(not mapped)"}`);
    }
    if (big) {
      // First and last address per area (%I, %Q, %M), in the export's order.
      const areas = new Map<string, string[]>();
      for (const c of channels) {
        const area = !c.variable && c.address.match(/^%([IQM])/i)?.[1]?.toUpperCase();
        if (area) areas.set(area, [...(areas.get(area) ?? []), c.address]);
      }
      const span = (xs: string[]) => (xs.length > 1 ? `${xs[0]} … ${xs[xs.length - 1]}` : xs[0]!);
      const range = areas.size ? ` (${[...areas.values()].map(span).join(", ")})` : "";
      lines.push(`${pad}+ ${channels.length - mapped} unmapped channel(s)${range}: get_devices with device '${d.path}' lists them all`);
    }
  }
  return lines.join("\n");
}
