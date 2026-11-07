/**
 * Shared session: two server processes started with the same options (as
 * Claude Desktop does for different chat surfaces) talk to one owner, so they
 * see the same state. Needs the build (dist/cli.js).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { ROOT, tempDir } from "./helpers.js";

const CLI = join(ROOT, "dist", "cli.js");
const UI = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } };

describe.skipIf(!existsSync(CLI))("shared session", () => {
  const state = tempDir("cmcp-state-");
  const work = tempDir("cmcp-work-");
  const clients: Client[] = [];

  const start = async (ui: boolean) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      // No CODESYS is started (--no-autostart); node stands in for its executable.
      args: [CLI, "--codesys-path", process.execPath, "--codesys-profile", "Test", "--no-autostart", "--no-viewer", "--workspace", work],
      env: { ...process.env, CODESYS_MCP_STATE_DIR: state, CODESYS_MCP_IDLE_MS: "1500" } as Record<string, string>,
      cwd: work,
      stderr: "pipe",
    });
    const c = new Client({ name: "t", version: "1" }, ui ? { capabilities: UI as never } : undefined);
    await c.connect(transport);
    clients.push(c);
    return c;
  };
  const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((x) => x.text).join("\n");

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
  });

  it("starts one owner for several processes, which share its state", async () => {
    const [a, b] = await Promise.all([start(true), start(false)]);
    expect(readdirSync(state).filter((f) => /^daemon-.*\.json$/.test(f))).toHaveLength(1);
    // capabilities pass through: the UI client gets the panel's tools, the other doesn't
    expect((await a.listTools()).tools.map((t) => t.name)).toContain("ui_hold");
    expect((await b.listTools()).tools.map((t) => t.name)).not.toContain("ui_hold");
    // the user pauses Claude in A's panel; B's tools see it
    expect((await a.callTool({ name: "ui_hold", arguments: { on: true } })).structuredContent).toMatchObject({ ok: true });
    expect(text(await b.callTool({ name: "run_scans", arguments: { n: 1 } }))).toMatch(/^paused_by_user:/);
    await a.callTool({ name: "ui_hold", arguments: { on: false } });
    expect(text(await b.callTool({ name: "run_scans", arguments: { n: 1 } }))).not.toMatch(/paused_by_user/);
  }, 60_000);

  it("stops the owner once no process is connected", async () => {
    for (const c of clients.splice(0)) await c.close();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && readdirSync(state).some((f) => /^daemon-.*\.json$/.test(f))) await new Promise((r) => setTimeout(r, 200));
    expect(readdirSync(state).filter((f) => /^daemon-.*\.json$/.test(f))).toEqual([]);
  }, 30_000);
});
