/** Choosing a CODESYS profile when several service packs are installed side by side. */
import { describe, expect, it } from "vitest";
import { compareProfiles, profileKey } from "../src/codesys/install.js";

describe("CODESYS profiles", () => {
  it("sort newest first, numerically", () => {
    const names = ["CODESYS V3.5 SP9", "CODESYS V3.5 SP21", "CODESYS V3.5 SP22 Patch 1", "CODESYS V3.5 SP22", "CODESYS V3.5 SP19 Patch 4", "Custom"];
    expect([...names].sort(compareProfiles)).toEqual([
      "CODESYS V3.5 SP22 Patch 1",
      "CODESYS V3.5 SP22",
      "CODESYS V3.5 SP21",
      "CODESYS V3.5 SP19 Patch 4",
      "CODESYS V3.5 SP9",
      "Custom",
    ]);
  });

  it("read the version from the profile name", () => {
    expect(profileKey("CODESYS V3.5 SP21")).toBe("0003.0005.0000.0021.0000");
    expect(profileKey("CODESYS V3.5 SP22 Patch 1")).toBe("0003.0005.0000.0022.0001");
    expect(profileKey("no version")).toBe("");
  });
});
