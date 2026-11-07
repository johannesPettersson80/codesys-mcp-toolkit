import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WATCHER } from "./helpers.js";

const files = readdirSync(WATCHER).filter((f) => f.endsWith(".py"));

describe("watcher sources", () => {
  it("exist", () => {
    expect(files).toEqual(expect.arrayContaining(["watcher.py", "mcp_ops.py", "mcp_compat.py"]));
  });

  // v2 is offline-only: simulation happens in truST, never on a controller.
  const FORBIDDEN = [
    /create_online_application/i,
    /\.login\s*\(/i,
    /\.logout\s*\(/i,
    /\.download\s*\(/i,
    /online_change/i,
    /write_prepared_values/i,
    /\.force_prepared_values/i,
    /set_prepared_value/i,
    /\bonline\./i,
    /\bexec\s*\(/,
    /\beval\s*\(/,
  ];

  for (const f of files) {
    const src = readFileSync(join(WATCHER, f), "utf8");
    it(`${f} uses no online or code-execution APIs`, () => {
      for (const re of FORBIDDEN) expect(src, `${f} matches ${re}`).not.toMatch(re);
    });
    it(`${f} is ASCII-only (IronPython 2.7)`, () => {
      // eslint-disable-next-line no-control-regex
      expect(/[^\x00-\x7F]/.test(src)).toBe(false);
    });
    it(`${f} declares a coding line`, () => {
      expect(src.split("\n")[0]).toMatch(/coding[:=]\s*utf-8/);
    });
  }
});
