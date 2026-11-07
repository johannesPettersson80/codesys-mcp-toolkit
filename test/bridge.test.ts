import { afterEach, describe, expect, it } from "vitest";
import { BridgeError, type CodesysBridge } from "../src/bridge/bridge.js";
import { fakeBridge, fakeProjectFile } from "./helpers.js";

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

  it("reports a crash during an op as watcher_died", async () => {
    bridge = fakeBridge();
    await bridge.call("project.open", { path: fakeProjectFile() });
    const err = await bridge.call("object.write", { path: "PLC_PRG", implementation: "__CRASH__" }).catch((e) => e);
    expect(err).toMatchObject({ code: "watcher_died" });
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
