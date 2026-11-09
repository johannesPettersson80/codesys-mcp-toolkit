/** Every action behind the one `codesys` tool, so a client asks for approval once. */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { tempDir, viaCodesys } from "./helpers.js";

const UI = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };

async function connect(withUi = false) {
  const ctx = { bridge: { health: () => ({}), waitReady: async () => false } as unknown as AppContext["bridge"], autosave: false, workspace: tempDir(), startWaitMs: 0 } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" }, withUi ? { capabilities: UI as never } : undefined);
  await client.connect(b);
  await new Promise((r) => setTimeout(r, 20));
  const call = async (action: string, args?: Record<string, unknown>) => {
    const r = (await client.callTool({ name: "codesys", arguments: { action, ...(args ? { args } : {}) } })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join("\n"), isError: !!r.isError };
  };
  return { client, call };
}

describe("the codesys tool", () => {
  it("is the only tool the model needs, plus the card", async () => {
    const plain = (await (await connect()).client.listTools()).tools;
    expect(plain.map((t) => t.name)).toEqual(["codesys", "open_sim_panel"]);
    const withUi = (await (await connect(true)).client.listTools()).tools;
    const forModel = withUi.filter((t) => !(t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility?.every((v) => v === "app"));
    expect(forModel.map((t) => t.name).sort()).toEqual(["codesys", "open_sim_panel"]);
  });

  it("carries no panel, which would mount on every call", async () => {
    const tool = (await (await connect(true)).client.listTools()).tools.find((t) => t.name === "codesys")!;
    expect(tool._meta).toBeUndefined();
  });

  it("says it can destroy project code, since it can", async () => {
    const tool = (await (await connect()).client.listTools()).tools[0]!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
  });

  it("documents every action and its arguments", async () => {
    const tool = (await (await connect()).client.listTools()).tools[0]!;
    const actions = (tool.inputSchema.properties!.action as { enum: string[] }).enum.filter((a) => a !== "help");
    expect(actions.length).toBeGreaterThan(30);
    for (const a of actions) expect(tool.description, a).toContain(`\n${a}: `);
    expect(tool.description).toMatch(/\n {2}path: string - Path to the \.project or \.projectarchive file/);
    expect(tool.description).toMatch(/\n {2}discardChanges\?: boolean/);
    expect(tool.description).toMatch(/\n {2}names: string\[\] - Variables as CODESYS expressions/);
    expect(tool.description).toMatch(/\n {2}values: \{ \[name\]: string \} - Variable to value/);
    expect(tool.description).toMatch(/\n {2}priority\?: string \| number - 0 \(highest\)/);
    expect(tool.description).toMatch(/\n {2}kind\?: "cyclic" \| "freewheeling"/);
  });

  it("gives the same list through help", async () => {
    const { client, call } = await connect();
    const description = (await client.listTools()).tools[0]!.description!;
    const all = await call("help");
    expect(all.isError).toBe(false);
    expect(description.endsWith(all.text)).toBe(true);
    const one = await call("help", { action: "open_project" });
    expect(one.text).toMatch(/^open_project: Open a CODESYS \.project file/);
    expect(one.text).not.toContain("write_object:");
    expect(await call("help", { action: "nope" })).toMatchObject({ isError: true, text: expect.stringMatching(/^Unknown action 'nope'\. Actions: .*open_project/) });
  });

  it("refuses bad arguments and shows what the action takes", async () => {
    const { call } = await connect();
    const missing = await call("open_project");
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/^Invalid arguments for open_project:/);
    expect(missing.text).toMatch(/at path/);
    expect(missing.text).toContain("open_project: Open a CODESYS");
  });

  it("refuses a misspelt argument instead of ignoring it", async () => {
    const r = await (await connect()).call("write_object", { path: "PLC_PRG", implemntation: "x := 1;" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/implemntation/);
  });

  it("refuses an unknown action", async () => {
    const { client } = await connect();
    const r = (await client.callTool(viaCodesys("write_everything"))) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/write_object/);
  });

  it("runs an action", async () => {
    const r = await (await connect()).call("codesys_status");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^CODESYS: /);
  });

  it("says when the browser workspace is switched off", async () => {
    expect(await (await connect()).call("open_workspace")).toMatchObject({ isError: true, text: expect.stringContaining("--no-viewer") });
  });
});
