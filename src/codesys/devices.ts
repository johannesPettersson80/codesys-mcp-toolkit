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

export function describeDevices(devices: DeviceInfo[]): string {
  if (!devices.length) return "No devices in the project.";
  const lines: string[] = [];
  for (const d of devices) {
    const ident = d.module
      ? ` (module ${d.module}${d.version ? `, version ${d.version}` : ""})`
      : d.id
        ? ` (type ${d.type ?? "?"}, id ${d.id}, version ${d.version ?? "?"})`
        : "";
    const channels = d.io_csv ? parseIoMappingCsv(d.io_csv) : [];
    const mapped = channels.filter((c) => c.variable).length;
    lines.push(
      `${"  ".repeat(d.depth)}${d.name}${ident}${d.enabled === false ? " [disabled]" : ""}${channels.length ? `: ${channels.length} channel(s), ${mapped} mapped` : ""}${d.io_error ? ` (I/O mapping not readable: ${d.io_error})` : ""}`,
    );
    for (const c of channels) {
      lines.push(`${"  ".repeat(d.depth + 1)}${(c.address || "-").padEnd(10)} ${c.parameter}${c.description ? ` ${c.description}` : ""}${c.unit ? ` [${c.unit}]` : ""} -> ${c.variable ? shortVariable(c.variable) : "(not mapped)"}`);
    }
  }
  return lines.join("\n");
}
