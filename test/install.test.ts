/** Choosing a CODESYS profile when several service packs are installed side by side. */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareProfiles, describeInstall, ensureWorkspace, pickedNewest, profileKey, resolveCodesys } from "../src/codesys/install.js";
import { tempDir } from "./helpers.js";

/** A fake install: the program, and Profiles (with these names) under `base`. */
function install(program: string, base: string, profiles: string[]): string {
  const root = tempDir("cmcp-install-");
  const exe = join(root, program);
  mkdirSync(join(exe, ".."), { recursive: true });
  writeFileSync(exe, "");
  if (profiles.length) {
    mkdirSync(join(root, base, "Profiles"), { recursive: true });
    for (const p of profiles) writeFileSync(join(root, base, "Profiles", `${p}.profile.xml`), "");
  }
  return exe;
}

const CODESYS = join("CODESYS 3.5.21.0", "CODESYS", "Common", "CODESYS.exe");
const LOGIC_BUILDER = join("EcoStruxure Machine Expert", "V2.3", "LogicBuilder.exe");

describe("finding an install's profiles", () => {
  it("keeps CODESYS's own layout", () => {
    const i = describeInstall(install(CODESYS, join("CODESYS 3.5.21.0", "CODESYS"), ["CODESYS V3.5 SP21"]));
    expect(i.profiles).toEqual(["CODESYS V3.5 SP21"]);
    expect(i.label).toBe("CODESYS 3.5.21.0");
  });

  it("finds profiles next to another product's program", () => {
    const i = describeInstall(install(LOGIC_BUILDER, join("EcoStruxure Machine Expert", "V2.3"), ["Machine Expert 2.3 (x64)"]));
    expect(i.profiles).toEqual(["Machine Expert 2.3 (x64)"]);
    expect(i.label).toBe("EcoStruxure Machine Expert V2.3");
  });

  it("finds profiles in a CODESYS folder beside another product's program", () => {
    expect(describeInstall(install(LOGIC_BUILDER, join("EcoStruxure Machine Expert", "V2.3", "CODESYS"), ["ME"])).profiles).toEqual(["ME"]);
  });
});

describe("checking the profile", () => {
  it("refuses a CODESYS profile that isn't installed, and says which are", () => {
    const exe = install(CODESYS, join("CODESYS 3.5.21.0", "CODESYS"), ["CODESYS V3.5 SP21"]);
    expect(() => resolveCodesys(exe, "CODESYS V3.5 SP99")).toThrow(/Profile "CODESYS V3\.5 SP99" isn't installed.*Installed profiles: CODESYS V3\.5 SP21\./);
  });

  it("accepts an installed profile, in any case", () => {
    const exe = install(CODESYS, join("CODESYS 3.5.21.0", "CODESYS"), ["CODESYS V3.5 SP21"]);
    expect(resolveCodesys(exe, "codesys v3.5 sp21").warning).toBeUndefined();
    expect(resolveCodesys(exe).profile).toBe("CODESYS V3.5 SP21");
  });

  it("only warns for other products, where profile files may be named differently", () => {
    const exe = install(LOGIC_BUILDER, join("EcoStruxure Machine Expert", "V2.3"), ["Something else"]);
    const r = resolveCodesys(exe, "Machine Expert 2.3 (x64)");
    expect(r.profile).toBe("Machine Expert 2.3 (x64)");
    expect(r.warning).toMatch(/isn't among those found.*trying it anyway/);
  });

  it("warns when there is no Profiles folder to check against", () => {
    expect(resolveCodesys(install(LOGIC_BUILDER, "unused", []), "Machine Expert 2.3 (x64)").warning).toMatch(/no Profiles folder/);
  });
});

describe("the workspace folder", () => {
  it("is created when missing, and logged", () => {
    const dir = join(tempDir("cmcp-ws-"), "a", "b");
    const log: string[] = [];
    expect(ensureWorkspace(dir, (m) => log.push(m))).toBe(dir);
    expect(log.join()).toMatch(/created the workspace folder/);
    expect(ensureWorkspace(dir, (m) => log.push(m))).toBe(dir);
    expect(log).toHaveLength(1);
  });

  it("can't be a file", () => {
    const file = join(tempDir("cmcp-ws-"), "file.txt");
    writeFileSync(file, "");
    expect(() => ensureWorkspace(file, () => undefined)).toThrow(/Can't use the workspace .*it is a file/);
  });
});
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
