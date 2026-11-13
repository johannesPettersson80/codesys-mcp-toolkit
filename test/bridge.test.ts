import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeError, startupHint, type CodesysBridge } from "../src/bridge/bridge.js";
import { fakeBridge, fakeProjectFile, tempDir } from "./helpers.js";

let bridge: CodesysBridge | undefined;
afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

describe("CodesysBridge with the real watcher (fake scriptengine)", () => {
  it("starts, answers ping and reports health", async () => {
    bridge = fakeBridge();
    await bridge.start();
    const r = await bridge.call<{ engine: string }>("ping");
    expect(r.engine).toBe("fake");
    const h = bridge.health();
    expect(h.state).toBe("ready");
    expect(h.verdict).toBe("healthy");
    expect(h.heartbeat?.state).toBe("idle");
    // The watcher goes idle before it publishes a result, so a health check right
    // after any call never sees the finished op as still busy.
    for (let i = 0; i < 20; i++) {
      await bridge.call("ping");
      expect(bridge.health()).toMatchObject({ verdict: "healthy", heartbeat: { state: "idle" } });
    }
  });

  it("survives the heartbeat file being held open (Windows sharing violation)", async () => {
    // On Windows, replacing a file another process has open fails with "access denied".
    // The server reads heartbeat.json while the watcher rewrites it every second; under
    // load the two collide. The watcher must retry, not crash.
    bridge = fakeBridge();
    await bridge.start();
    const { sessionDir, pid } = bridge.health();
    const hbPath = join(sessionDir!, "heartbeat.json");
    const before = bridge.readHeartbeat()!.ts;
    const fd = openSync(hbPath, "r");
    try {
      await new Promise((r) => setTimeout(r, 1_500));
    } finally {
      closeSync(fd);
    }
    const r = await bridge.call<{ engine: string }>("ping");
    expect(r.engine).toBe("fake");
    // Same watcher process, no silent restart.
    expect(bridge.health()).toMatchObject({ state: "ready", restarts: 0, sessionDir, pid });
    expect(bridge.readHeartbeat()!.ts).toBeGreaterThan(before);
    expect(bridge.logTail(50)).not.toMatch(/crashed|heartbeat write failed/);
  });

  it.runIf(process.platform === "win32")("waits for a request file another process holds (Windows sharing violation)", async () => {
    // An antivirus scan or the indexer can hold a new request file for a moment. The
    // watcher used to answer "bad_request: Unreadable request" and drop the call.
    bridge = fakeBridge();
    await bridge.start();
    const dir = bridge.health().sessionDir!;
    const UV_FS_O_EXLOCK = 0x10000000; // libuv: open with no sharing at all
    const fd = openSync(join(dir, "requests", "zz-held.json"), constants.O_CREAT | constants.O_WRONLY | constants.O_EXCL | UV_FS_O_EXLOCK);
    try {
      writeSync(fd, JSON.stringify({ id: "zz-held", op: "ping", args: {}, deadline_ms: 10_000 }));
      await new Promise((r) => setTimeout(r, 400)); // long enough for the watcher to find it
    } finally {
      closeSync(fd);
    }
    const result = join(dir, "results", "zz-held.json");
    for (let i = 0; i < 100 && !existsSync(result); i++) await new Promise((r) => setTimeout(r, 50));
    expect(JSON.parse(readFileSync(result, "utf8").replace(/^﻿/, ""))).toMatchObject({ ok: true, result: { engine: "fake" } });
  });

  it("returns watcher errors as BridgeError with code", async () => {
    bridge = fakeBridge();
    await expect(bridge.call("objects.read", { paths: ["X"] })).rejects.toMatchObject({ code: "no_project" });
    await expect(bridge.call("nope")).rejects.toMatchObject({ code: "unknown_op" });
  });

  it("serialises concurrent calls", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    const results = await Promise.all(Array.from({ length: 10 }, () => bridge!.call<{ nodes: unknown[] }>("tree")));
    for (const r of results) expect(r.nodes.length).toBeGreaterThan(5);
  });

  it("round-trips non-ASCII text", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    const impl = "sText := 'Nivå åäö 測';\n";
    await bridge.call("object.write", { path: "PLC_PRG", implementation: impl });
    const r = await bridge.call<{ objects: { implementation: string }[] }>("objects.read", { paths: ["PLC_PRG"] });
    expect(r.objects[0]!.implementation).toBe(impl);
  });

  it("detects a hung op, kills CODESYS and restarts on the next call", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    const err = await bridge.call("object.write", { path: "PLC_PRG", implementation: "__HANG__" }, { timeoutMs: 800 }).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeError);
    expect(["hung", "timeout"]).toContain((err as BridgeError).code);
    expect(bridge.health().state).toBe("dead");
    const r = await bridge.call<{ engine: string }>("ping");
    expect(r.engine).toBe("fake");
    expect(bridge.health().restarts).toBe(1);
  }, 30_000);

  it("stops a call that waits on a dialog, and names the dialog", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    const started = Date.now();
    const pending = bridge.call("object.write", { path: "PLC_PRG", implementation: "__HANG__" }, { timeoutMs: 60_000 }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(bridge.health().sessionDir!, "dialog.json"), JSON.stringify({ title: "Do you trust this project?", op: "object.write" }));
    const err = await pending;
    expect(err).toMatchObject({ code: "dialog" });
    expect((err as BridgeError).message).toMatch(/"Do you trust this project\?"/);
    expect(Date.now() - started).toBeLessThan(15_000); // not the op's 60 s deadline
    expect(bridge.health().state).toBe("dead");
  }, 30_000);

  it("reports a crash during an op as watcher_died", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    const err = await bridge.call("object.write", { path: "PLC_PRG", implementation: "__CRASH__" }).catch((e) => e);
    expect(err).toMatchObject({ code: "watcher_died" });
  });

  it("says what the program printed when it dies during a call", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    (bridge as unknown as { output: string }).output = "licence check failed\n";
    const err = await bridge.call("object.write", { path: "PLC_PRG", implementation: "__CRASH__" }).catch((e) => e);
    expect(err).toMatchObject({ code: "watcher_died" });
    expect((err as BridgeError).message).toMatch(/CODESYS said: licence check failed/);
  });

  it("fails startup clearly when the executable is missing", async () => {
    bridge = fakeBridge({ command: "definitely-not-codesys.exe", startupTimeoutMs: 5_000 });
    await expect(bridge.start()).rejects.toMatchObject({ code: "startup_failed" });
  });

  it("stops cleanly via shutdown", async () => {
    bridge = fakeBridge();
    await bridge.start();
    await bridge.stop();
    expect(bridge.health().state).toBe("stopped");
    expect(bridge.health().heartbeat?.state).toBe("stopped");
  });
});

describe("start-up hints", () => {
  it("explain a CODESYS install without the scripting add-on", () => {
    expect(startupHint("The command line option 'runscript' has been set. However, there is no script engine implementation available.")).toMatch(/add the "CODESYS Scripting" add-on/);
    expect(startupHint("When running in --noUI mode, you must specify a profile using --profile=\"profile name\".")).toMatch(/--codesys-profile/);
    expect(startupHint("")).toBe("");
  });
});

describe("attach mode (a window the user already has open)", () => {
  /** Stands in for the timer watcher the user runs in their window. */
  function fakeWindow(dir: string, opts: { answer?: boolean; garbage?: boolean } = {}) {
    const beat = (state: string) => writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ pid: 4242, ts: Date.now() / 1000, state }));
    mkdirSync(join(dir, "requests"), { recursive: true });
    mkdirSync(join(dir, "results"), { recursive: true });
    const timer = setInterval(() => {
      beat("idle");
      if (!existsSync(join(dir, "ready.json"))) writeFileSync(join(dir, "ready.json"), JSON.stringify({ pid: 4242, scripting: "4.1.0.0" }));
      if (opts.answer === false) return;
      for (const f of readdirSync(join(dir, "requests")).filter((n) => n.endsWith(".json"))) {
        const req = JSON.parse(readFileSync(join(dir, "requests", f), "utf8"));
        rmSync(join(dir, "requests", f));
        writeFileSync(join(dir, "results", f), opts.garbage ? '{"id":"cut off' : JSON.stringify({ id: req.id, ok: true, result: { op: req.op } }));
      }
    }, 50);
    return () => clearInterval(timer);
  }

  it("writes the launcher, attaches to the running watcher and leaves it running on stop", async () => {
    const dir = tempDir("cmcp-attach-");
    bridge = fakeBridge({ attachDir: dir, command: "unused" });
    const stopWindow = fakeWindow(dir);
    try {
      await bridge.start();
      expect(readFileSync(bridge.attachScript!, "utf8")).toMatch(/CODESYS_MCP_ATTACH.*\n.*\n.*\n.*\n.*\n?.*exec\(compile\(/s);
      expect(readFileSync(bridge.attachScript!, "utf8")).not.toMatch(/execfile/);
      expect(await bridge.call("ping")).toEqual({ op: "ping" });
      expect(bridge.health()).toMatchObject({ state: "ready", scripting: "4.1.0.0" });
      await bridge.stop();
      expect(bridge.health().state).toBe("stopped");
      expect(existsSync(join(dir, "requests"))).toBe(true);
    } finally {
      stopWindow();
    }
  });

  it("keeps a newer request from another server and drops old leftovers", async () => {
    const dir = tempDir("cmcp-attach-");
    mkdirSync(join(dir, "requests"), { recursive: true });
    writeFileSync(join(dir, "requests", "fresh.json"), "{}");
    writeFileSync(join(dir, "requests", "old.json"), "{}");
    const old = new Date(Date.now() - 120_000);
    utimesSync(join(dir, "requests", "old.json"), old, old);
    bridge = fakeBridge({ attachDir: dir, command: "unused", startupTimeoutMs: 300 });
    await expect(bridge.start()).rejects.toMatchObject({ code: "attach_timeout" });
    expect(existsSync(join(dir, "requests", "fresh.json"))).toBe(true);
    expect(existsSync(join(dir, "requests", "old.json"))).toBe(false);
    expect(bridge.health().state).toBe("dead");
  });

  it("says how to start the watcher when none answers, without starting a process", async () => {
    const dir = tempDir("cmcp-attach-");
    bridge = fakeBridge({ attachDir: dir, command: "unused", startupTimeoutMs: 600 });
    await expect(bridge.start()).rejects.toMatchObject({ code: "attach_timeout", message: expect.stringContaining("start_attach.py") });
    expect(bridge.health().pid).toBeUndefined();
  });

  it("fails a call whose result file stays unreadable, instead of waiting forever", async () => {
    const dir = tempDir("cmcp-attach-");
    bridge = fakeBridge({ attachDir: dir, command: "unused" });
    const stopWindow = fakeWindow(dir, { garbage: true });
    try {
      await bridge.start();
      await expect(bridge.call("ping", {}, { timeoutMs: 60_000 })).rejects.toMatchObject({ code: "bad_result", message: expect.stringContaining("cut off") });
      expect(readdirSync(join(dir, "results"))).toEqual([]);
    } finally {
      stopWindow();
    }
  }, 15_000);

  it("drops a request a stalled window never took, instead of running it later", async () => {
    const dir = tempDir("cmcp-attach-");
    bridge = fakeBridge({ attachDir: dir, command: "unused" });
    const stopWindow = fakeWindow(dir);
    await bridge.start();
    stopWindow();
    const stalled = fakeWindow(dir, { answer: false });
    try {
      await expect(bridge.call("ping", {}, { timeoutMs: 300 })).rejects.toMatchObject({ code: "timeout" });
      expect(readdirSync(join(dir, "requests")).filter((n) => n.endsWith(".json"))).toEqual([]);
    } finally {
      stalled();
    }
  });
});
