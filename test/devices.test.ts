/** Reading CODESYS's device tree and I/O mapping export. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describeDevices, parseIoMappingCsv, shortVariable } from "../src/codesys/devices.js";
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
