/** Reading CODESYS's device tree and I/O mapping export. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describeDevices, deviceSubtree, mappedChannels, parseIoMappingCsv, shortVariable } from "../src/codesys/devices.js";
import { describeParam } from "../src/codesys/device-tools.js";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { fakeBridge, tempDir, viaCodesys } from "./helpers.js";

// Header as CODESYS V3.5 SP21 writes it (export_io_mappings_as_csv); the data rows follow its columns.
const CSV = [
  "//CoDeSys Mapping Export V1.2",
  "//Mapped variable,//Parameter name @ counter in device,//Unit,//Description,//IEC address,//Device name",
  "//Important: change only first, third or fourth column in Excel or add variables in the first column",
  "Application.GVL_IO.xLS101_High,Input@1,,Bit0,%IX0.0,EL1008",
  ",Input@1,,Bit1,%IX0.1,EL1008",
  '"Application.GVL_IO.rLevel",Value@2,m,"Level, scaled",%IW2,EL3062',
].join("\r\n");

describe("device I/O mapping", () => {
  it("parses CODESYS's CSV export", () => {
    expect(parseIoMappingCsv(CSV)).toEqual([
      { variable: "Application.GVL_IO.xLS101_High", parameter: "Input@1", unit: "", description: "Bit0", address: "%IX0.0", device: "EL1008" },
      { variable: "", parameter: "Input@1", unit: "", description: "Bit1", address: "%IX0.1", device: "EL1008" },
      { variable: "Application.GVL_IO.rLevel", parameter: "Value@2", unit: "m", description: "Level, scaled", address: "%IW2", device: "EL3062" },
    ]);
  });

  it("returns nothing for a device without channels", () => {
    expect(parseIoMappingCsv(CSV.split("\r\n").slice(0, 3).join("\n"))).toEqual([]);
  });

  it("takes the separator from the header", () => {
    const semi = "//Mapped variable;//Parameter name @ counter in device;//Unit;//Description;//IEC address;//Device name\nApplication.X;In@1;;Bit0;%IX0.0;D";
    expect(parseIoMappingCsv(semi)[0]).toMatchObject({ variable: "Application.X", address: "%IX0.0", device: "D" });
  });

  it("shortens variables to application paths", () => {
    expect(shortVariable("Application.GVL_IO.xValve")).toBe("GVL_IO.xValve");
    expect(shortVariable("GVL_IO.xValve")).toBe("GVL_IO.xValve");
  });

  it("describes the device tree with channels and mappings", () => {
    const text = describeDevices([
      { path: "PLCWinNT", name: "PLCWinNT", depth: 0, type: 4096, id: "0000 0001", version: "3.5.21.0", enabled: true },
      { path: "PLCWinNT/EK1100", name: "EK1100", depth: 1, enabled: false, io_csv: CSV },
    ]);
    expect(text).toContain("PLCWinNT (type 4096, id 0000 0001, version 3.5.21.0)");
    expect(text).toContain("  EK1100 [disabled]: 3 channel(s), 2 mapped");
    expect(text).toContain("    %IX0.0     Input@1 Bit0 -> GVL_IO.xLS101_High");
    expect(text).toContain("    %IX0.1     Input@1 Bit1 -> (not mapped)");
    expect(text).toContain("    %IW2       Value@2 Level, scaled [m] -> GVL_IO.rLevel");
  });

  it("shows each channel once, under its own device, though parents export their children's", () => {
    const devices = [
      { path: "PLC", name: "PLC", depth: 0, io_csv: CSV },
      { path: "PLC/EK1100", name: "EK1100", depth: 1, io_csv: CSV },
      { path: "PLC/EK1100/EL1008", name: "EL1008", depth: 2, io_csv: CSV },
      { path: "PLC/EK1100/EL3062", name: "EL3062", depth: 2, io_csv: CSV },
    ];
    expect(mappedChannels(devices).map((c) => `${c.device} ${c.address} ${c.variable}`)).toEqual(["EL1008 %IX0.0 Application.GVL_IO.xLS101_High", "EL3062 %IW2 Application.GVL_IO.rLevel"]);
    const text = describeDevices(devices);
    expect(text).toContain("PLC\n  EK1100\n    EL1008: 2 channel(s), 1 mapped");
    expect(text).toContain("    EL3062: 1 channel(s), 1 mapped");
    expect(text.match(/%IW2/g)).toHaveLength(1);
  });

  it("describes device parameters and channels for configure_device", () => {
    expect(describeParam({ key: "c1/4", name: "IPConfigMode", depth: 0, type: "Enumeration of BYTE", value: "1", choices: ["FIXED=FIXED", "DHCP=DHCP"] })).toBe("c1/4  IPConfigMode [Enumeration of BYTE] = 1 (one of FIXED=FIXED, DHCP=DHCP)");
    expect(describeParam({ key: "c0/1000/1000_0_0_0", name: "Holding Registers[0]", depth: 1, channel: "Input", mapping: { variable: "wSpeed", address: "%IW0", automatic_address: true } })).toBe("  c0/1000/1000_0_0_0  Holding Registers[0] [input channel] -> wSpeed at %IW0");
    expect(describeParam({ key: "c0/8000", name: "NewChannelConfig", depth: 0, type: "BOOL", value: "true", access: "Read" })).toBe("c0/8000  NewChannelConfig [BOOL] = true (read-only)");
    expect(describeParam({ key: "7", name: "Out", depth: 0, channel: "Output", mapping: { variable: "", address: "%QX4.0", automatic_address: false } })).toBe("7  Out [output channel] -> (not mapped) at %QX4.0 (fixed)");
  });

  it("counts the unmapped channels of a big device instead of listing them (#7: an adapter with 2363 channels)", () => {
    const header = CSV.split("\r\n").slice(0, 3);
    const rows = Array.from({ length: 2363 }, (_, i) => `${i % 139 === 5 ? `Application.GVL_IO.x${i}` : ""},Bit${i},,,%${i < 2000 ? "I" : "Q"}X${Math.floor((i % 2000) / 8)}.${i % 8},IO_Scan3D`);
    const devices = [
      { path: "LMC", name: "LMC", depth: 0, type: 4096, id: "1003 0082", version: "1.80.2.2" },
      { path: "LMC/EIPS_Scanner", name: "EIPS_Scanner", depth: 1 },
      { path: "LMC/EIPS_Scanner/IO_Scan3D", name: "IO_Scan3D", depth: 2, io_csv: [...header, ...rows].join("\r\n") },
      { path: "LMC/EIPS_Scanner/Small", name: "Small", depth: 2, io_csv: CSV.replace(/EL1008|EL3062/g, "Small") },
    ];
    const text = describeDevices(devices, { maxChannels: 64 });
    expect(text).toContain("    IO_Scan3D: 2363 channel(s), 17 mapped");
    expect(text.match(/-> GVL_IO\.x\d/g)).toHaveLength(17);
    expect(text).not.toMatch(/IO_Scan3D[\s\S]*not mapped[\s\S]*Small/);
    expect(text).toContain("      + 2346 unmapped channel(s) (%IX0.0 … %IX249.7, %QX0.0 … %QX45.2): get_devices with device 'LMC/EIPS_Scanner/IO_Scan3D' lists them all");
    // A small device keeps its full list.
    expect(text).toContain("      %IX0.1     Input@1 Bit1 -> (not mapped)");
    expect(text.split("\n").length).toBeLessThan(30);
    // Without the limit (export_sources), every channel is there.
    expect(describeDevices(devices).match(/not mapped/g)).toHaveLength(2346 + 1);
  });

  it("finds one device and those under it, by path or by name", () => {
    const devices = [
      { path: "PLC", name: "PLC", depth: 0 },
      { path: "PLC/Bus", name: "Bus", depth: 1 },
      { path: "PLC/Bus/IO_1", name: "IO_1", depth: 2 },
      { path: "PLC/Bus/IO_1/Mod", name: "Mod", depth: 3 },
      { path: "PLC/Bus/IO_2", name: "IO_2", depth: 2 },
      { path: "PLC/Other/Mod", name: "Mod", depth: 1 },
    ];
    expect(deviceSubtree(devices, "/PLC/Bus/IO_1").map((d) => d.name)).toEqual(["IO_1", "Mod"]);
    expect(deviceSubtree(devices, "bus").map((d) => d.name)).toEqual(["Bus", "IO_1", "Mod", "IO_2"]);
    expect(() => deviceSubtree(devices, "Mod")).toThrow("2 devices are named 'Mod': give the path, one of 'PLC/Bus/IO_1/Mod', 'PLC/Other/Mod'.");
    expect(() => deviceSubtree(devices, "Nope")).toThrow("No device 'Nope' in the project (get_devices lists them).");
  });

  it("names a module by its module id instead of its owner's type and id", () => {
    const text = describeDevices([
      { path: "LMC", name: "LMC", depth: 0, type: 4096, id: "1052 0001", version: "1.0.0.0", module: null },
      { path: "LMC/DM72F0", name: "DM72F0", depth: 1, type: 4096, id: "1052 0001", version: "1.0.0.0", module: "DM72F0_slot1" },
    ]);
    expect(text).toContain("LMC (type 4096, id 1052 0001, version 1.0.0.0)");
    expect(text).toContain("  DM72F0 (module DM72F0_slot1, version 1.0.0.0)");
  });
});

describe("get_devices on the fake CODESYS", () => {
  let client: Client | undefined;
  let ctx: AppContext | undefined;
  afterEach(async () => {
    await client?.close();
    await ctx?.bridge.stop();
    client = undefined;
    ctx = undefined;
  });

  it("tells modules apart, which report their owner's type and id (Machine Expert, #7)", async () => {
    const workspace = tempDir();
    const file = join(workspace, "Modules.project");
    writeFileSync(file, "MODULES");
    ctx = { bridge: fakeBridge({ staleHeartbeatMs: 30_000, hungGraceMs: 10_000 }), autosave: true, workspace, startWaitMs: 20_000 };
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      ((await client!.callTool(viaCodesys(name, args))) as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
    await call("open_project", { path: file });
    const text = await call("get_devices", { io: false });
    expect(text).toContain("Device (type 4096, id 0000 0001, version 3.5.21.0)");
    expect(text).toContain("  DM72F0 (module DM72F0_slot1, version 3.5.21.0)");
    expect(text).toContain("  Embedded_Encoder (module ENC_0, version 3.5.21.0)");
  });
});
