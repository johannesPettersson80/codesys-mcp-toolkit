import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareSources, describeComparison, readSourceDir } from "../src/codesys/compare.js";
import { tempDir } from "./helpers.js";

const before = new Map([
  ["PLC_PRG.st", "PROGRAM PLC_PRG\nVAR\nEND_VAR\n\nFB_A();\n"],
  ["FB_Old.st", "FUNCTION_BLOCK FB_Old\n"],
  ["SFC_Main.xml", "<pou/>\n"],
  ["project.txt", "[Tasks]\nMainTask\n"],
]);
const after = new Map([
  ["PLC_PRG.st", "PROGRAM PLC_PRG\nVAR\n    n : INT;\nEND_VAR\n\nFB_A();\nn := n + 1;\n"],
  ["FB_New.st", "FUNCTION_BLOCK FB_New\n"],
  ["SFC_Main.xml", "<pou/>"],
  ["project.txt", "[Tasks]\nMainTask\n"],
]);

describe("compare_sources", () => {
  it("lists added, removed and changed objects with a diff", () => {
    const c = compareSources(before, after);
    expect(c.added).toEqual(["FB_New.st"]);
    expect(c.removed).toEqual(["FB_Old.st"]);
    expect(c.changed.map((x) => [x.file, x.plus, x.minus])).toEqual([["PLC_PRG.st", 2, 0]]);
    // A trailing newline alone isn't a change.
    expect(c.same).toBe(2);
    const t = describeComparison(c, "old", "new");
    expect(t).toContain("old -> new: 1 changed, 1 added, 1 removed, 2 the same.");
    expect(t).toContain("Only in new:\n  + FB_New");
    expect(t).toContain("Only in old:\n  - FB_Old");
    expect(t).toContain("+    3 |     n : INT;");
  });

  it("limits to one object or folder, and the diff lines", () => {
    expect(compareSources(before, after, "PLC_PRG").changed).toHaveLength(1);
    expect(compareSources(before, after, "PLC_PRG").added).toEqual([]);
    expect(compareSources(before, after, "PLC").changed).toHaveLength(0);
    const t = describeComparison(compareSources(before, after), "old", "new", 2);
    expect(t).toMatch(/more lines: pass path to see this object, or a larger max_lines/);
    expect(describeComparison(compareSources(before, before), "a", "b")).toBe("No differences between a and b (4 file(s) compared).");
    expect(describeComparison({ added: ["SFC_Main.xml"], removed: [], changed: [], same: 0 }, "a", "b")).toContain("+ SFC_Main (graphical body)");
  });

  it("reads an export folder through its manifest, or every text file", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "Motors"), { recursive: true });
    writeFileSync(join(dir, "Motors", "FB_Motor.st"), "FUNCTION_BLOCK FB_Motor\r\n");
    writeFileSync(join(dir, "project.txt"), "x\n");
    writeFileSync(join(dir, "notes.bin"), "skip");
    expect([...readSourceDir(dir).keys()].sort()).toEqual(["Motors/FB_Motor.st", "project.txt"]);
    expect(readSourceDir(dir).get("Motors/FB_Motor.st")).toBe("FUNCTION_BLOCK FB_Motor\n");
    writeFileSync(join(dir, ".codesys-export.json"), JSON.stringify({ files: ["project.txt"] }));
    expect([...readSourceDir(dir).keys()]).toEqual(["project.txt"]);
    expect(() => readSourceDir(join(dir, "nope"))).toThrow(/isn't a folder/);
  });
});
