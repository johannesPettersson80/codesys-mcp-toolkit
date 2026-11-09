/** Choosing a CODESYS profile when several service packs are installed side by side. */
import { describe, expect, it } from "vitest";
import { compareProfiles, pickedNewest, profileKey } from "../src/codesys/install.js";
import { describeBuildSettings, versionLine } from "../src/tools.js";

describe("the compiler version on opening a project", () => {
  const at = (compiler: string, codesys: string) => describeBuildSettings({ path: "p", compiler_version: compiler }, codesys);
  it("needs no note when it matches this CODESYS", () => {
    expect(at("3.5.22.40", "CODESYS 3.5.22.40")).toBe(" Compiler version 3.5.22.40.");
  });
  it("says an older project keeps its version", () => {
    expect(at("3.5.21.0", "CODESYS 3.5.22.40")).toMatch(/keeps its version unless you update it/);
  });
  it("says a newer project can't compile here, and what it needs", () => {
    expect(at("3.5.22.40", "CODESYS 3.5.21.0")).toBe(" Compiler version 3.5.22.40, which this CODESYS (3.5.21.0) doesn't have: the project won't compile here. Open it in CODESYS 3.5.22 or later.");
  });
  it("compares versions as numbers", () => {
    expect(at("3.5.9.0", "CODESYS 3.5.21.0")).toMatch(/keeps its version/);
  });
});

describe("the version line in the panel", () => {
  it("shows what is known", () => {
    expect(versionLine("CODESYS 3.5.22.40", "4.2.0.0", "3.5.19.40")).toBe("CODESYS 3.5.22.40 · Scripting 4.2.0.0 · compiler 3.5.19.40");
    expect(versionLine("CODESYS 3.5.21.0")).toBe("CODESYS 3.5.21.0"); // Scripting 4.1 has no compiler accessor
    expect(versionLine()).toBe("");
  });
});

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

  it("say why an install was picked when none was named", () => {
    expect(pickedNewest(["CODESYS 3.5.21.0"])).toBe("the only install found");
    expect(pickedNewest(["CODESYS 3.5.22.40", "CODESYS 3.5.21.0"])).toBe("newest of 2 installs found (CODESYS 3.5.22.40, CODESYS 3.5.21.0); --codesys-path picks another");
  });

  it("read the version from the profile name", () => {
    expect(profileKey("CODESYS V3.5 SP21")).toBe("0003.0005.0000.0021.0000");
    expect(profileKey("CODESYS V3.5 SP22 Patch 1")).toBe("0003.0005.0000.0022.0001");
    expect(profileKey("no version")).toBe("");
  });
});
