import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodesysBridge, type BridgeOptions } from "../src/bridge/bridge.js";

export const ROOT = resolve(import.meta.dirname, "..");
export const WATCHER = join(ROOT, "watcher");
export const FAKE = join(ROOT, "test", "fake");
export const PYTHON = process.env.PYTHON ?? "python";

export function tempDir(prefix = "cmcp-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** callTool parameters for one action of the `codesys` tool. */
export function viaCodesys(action: string, args: Record<string, unknown> = {}) {
  return { name: "codesys", arguments: { action, args } };
}

/** A bridge that runs the real watcher under CPython with the fake scriptengine. */
export function fakeBridge(overrides: Partial<BridgeOptions> = {}): CodesysBridge {
  return new CodesysBridge({
    command: PYTHON,
    args: (script) => ["-u", script],
    env: { PYTHONPATH: FAKE, PYTHONIOENCODING: "utf-8" },
    watcherSource: WATCHER,
    sessionRoot: tempDir("cmcp-sessions-"),
    startupTimeoutMs: 20_000,
    defaultTimeoutMs: 10_000,
    hungGraceMs: 500,
    staleHeartbeatMs: 5_000,
    ...overrides,
  });
}

/** A file the fake scriptengine opens as its sample project. */
export function fakeProjectFile(dir = tempDir()): string {
  const p = join(dir, "Sample.project");
  writeFileSync(p, "FAKE");
  return p;
}
