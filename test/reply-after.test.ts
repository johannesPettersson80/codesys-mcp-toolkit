/** A call that runs past the client's time limit replies "still running"; result hands over its result. */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";
import type { AppContext } from "../src/tools.js";
import { tempDir } from "./helpers.js";

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
});

async function connect(replyAfterMs: number) {
  const ctx = { bridge: { health: () => ({}), waitReady: async () => false } as unknown as AppContext["bridge"], autosave: false, workspace: tempDir(), startWaitMs: 0, replyAfterMs } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const call = async (action: string, args?: Record<string, unknown>) => {
    const r = await client!.callTool({ name: "codesys", arguments: { action, ...(args ? { args } : {}) } });
    return { text: (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n"), isError: !!r.isError };
  };
  return call;
}

describe("reply before the client gives up", () => {
  it("replies 'still running' and hands the result over through result", async () => {
    const call = await connect(40);
    const first = await call("wait", { ms: 150 });
    expect(first.isError).toBe(false);
    expect(first.text).toMatch(/^wait is still running in CODESYS \(\d+ s so far\)/);
    expect(first.text).toContain('{"action": "result"}');
    let done = await call("result");
    let polls = 1;
    while (/still running/.test(done.text) && polls < 20) (done = await call("result")), polls++;
    expect(polls).toBeGreaterThan(1); // result waits at most 40 ms too
    expect(done.text).toMatch(/^wait finished after \d+ s:/);
    expect(done.text).toMatch(/Waited 150 ms/);
    expect((await call("result")).text).toBe("Nothing is running: every call has returned its result.");
  });

  it("doesn't run a new call while one is running, and brings the earlier result along", async () => {
    const call = await connect(40);
    await call("wait", { ms: 60 });
    // Within 40 ms the earlier wait finishes: its result comes first, then this call's.
    const next = await call("wait", { ms: 5 });
    expect(next.text).toMatch(/^wait finished after \d+ s:[\s\S]*Waited 60 ms[\s\S]*\nwait:[\s\S]*Waited 5 ms/);
    await call("wait", { ms: 300 });
    const refused = await call("wait", { ms: 5 });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Not run: wait is still running/);
  });

  it("answers quick calls as before", async () => {
    const call = await connect(1_000);
    const r = await call("wait", { ms: 5 });
    expect(r.text).not.toMatch(/still running/);
    expect((await call("result")).text).toMatch(/^Nothing is running/);
  });
});
