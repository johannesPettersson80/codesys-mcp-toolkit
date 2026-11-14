/** MCP progress for long actions: steps reported deep inside an action, and a heartbeat. */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { reportProgress, withProgress } from "../src/progress.js";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { tempDir } from "./helpers.js";

describe("progress", () => {
  it("sends reported steps and a heartbeat, numbered, while the action runs", async () => {
    const got: { progress: number; message?: string }[] = [];
    const notify = async (n: { params: { progress: number; message?: string } }) => void got.push(n.params);
    const r = await withProgress({ progressToken: "t1", notify }, "hmi_export_codesys", async () => {
      reportProgress("page 1/2: Visu_Overview");
      await new Promise((res) => setTimeout(res, 70));
      reportProgress("compiling");
      return 42;
    }, 25);
    expect(r).toBe(42);
    expect(got[0]).toEqual({ progressToken: "t1", progress: 1, message: "page 1/2: Visu_Overview" });
    expect(got.some((g) => /hmi_export_codesys: still working/.test(g.message ?? ""))).toBe(true);
    expect(got.map((g) => g.progress)).toEqual(got.map((_, i) => i + 1));
    expect(got.at(-1)!.message).toBe("compiling");
    const after = got.length;
    await new Promise((res) => setTimeout(res, 60));
    expect(got.length).toBe(after); // the heartbeat stops with the action
  });

  it("does nothing without a progress token", async () => {
    expect(await withProgress(undefined, "x", async () => (reportProgress("ignored"), 1))).toBe(1);
  });

  it("reaches the client through the codesys tool: a batch reports its steps", async () => {
    const ctx = { bridge: { health: () => ({}), waitReady: async () => false } as unknown as AppContext["bridge"], autosave: false, workspace: tempDir(), startWaitMs: 0 } as AppContext;
    const server = createServer(ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    const seen: string[] = [];
    const r = await client.callTool(
      { name: "codesys", arguments: { action: "batch", args: { calls: [{ action: "wait", args: { ms: 10 } }, { action: "wait", args: { ms: 10 } }] } } },
      { onprogress: (p) => void seen.push(p.message ?? "") },
    );
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual(["step 1/2: wait", "step 2/2: wait"]);
    await client.close();
  });
});
