/** What CODESYS's library browser knows about an installed library. */
import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browseCacheFile, describeBrowse, newestLibrary, parseBrowseCache, readBrowseCache } from "../src/codesys/library-browse.js";
import { tempDir } from "./helpers.js";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<Library Name="Util, 3.5.21.0 (System)">
  <Node Name="BLINK" TypeGUID="{6f9dac99-8de1-4efc-8465-68ac443b7d08}" Comment=" Simulates a  blinking
 signal " ObjectGUID="{1}" />
  <Node Name="MONTH" TypeGUID="{2db5746d-d284-4425-9f7f-2663a34b0ebc}" Comment="  1 =&gt; January, &amp; so on" ObjectGUID="{2}" />
  <Node Name="WEEK" TypeGUID="{2db5746d-d284-4425-9f7f-2663a34b0ebc}" ObjectGUID="{3}" />
  <Node Name="测试" Comment="&#x6D4B;&#35797;" ObjectGUID="{4}" />
</Library>`;

describe("library browse cache", () => {
  it("reads objects and descriptions, decoding entities and tidying spaces", () => {
    expect(parseBrowseCache(XML)).toEqual([
      { name: "BLINK", comment: "Simulates a blinking signal" },
      { name: "MONTH", comment: "1 => January, & so on" },
      { name: "WEEK" },
      { name: "测试", comment: "测试" },
    ]);
  });

  it("picks the newest version numerically", () => {
    expect(newestLibrary([{ version: "3.5.9.0" }, { version: "3.5.22.0" }, { version: "3.5.17.0" }])).toEqual({ version: "3.5.22.0" });
    expect(newestLibrary([])).toBeUndefined();
  });

  it("finds the cache in whichever repository holds it", () => {
    const [empty, repo] = [tempDir("cmcp-repo-"), tempDir("cmcp-repo-")];
    const dir = join(repo, "System", "Util", "3.5.21.0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "browsercache"), XML);
    const lib = { title: "Util", version: "3.5.21.0", company: "System" };
    const file = browseCacheFile([empty, repo], lib)!;
    expect(file).toBe(join(dir, "browsercache"));
    expect(readBrowseCache(file)).toHaveLength(4);
    expect(browseCacheFile([empty], lib)).toBeUndefined();
  });

  it("describes a library, narrowed by name or description", () => {
    const entries = parseBrowseCache(XML);
    expect(describeBrowse("Util", entries)).toMatch(/^Util: 4 objects, .*\n- BLINK :: Simulates a blinking signal\n- MONTH :: 1 => January, & so on\n- WEEK\n/);
    expect(describeBrowse("Util", entries, "blink")).toMatch(/^Util: 1 of 4 objects/);
    expect(describeBrowse("Util", entries, "january")).toContain("- MONTH");
    expect(describeBrowse("Util", entries, "nope")).toBe("Util has nothing matching 'nope'.");
  });

  it("caps long listings and says how to narrow them", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ name: `F${i}` }));
    const text = describeBrowse("L", entries, undefined, 2);
    expect(text).toContain("- F1");
    expect(text).not.toContain("- F2");
    expect(text).toContain("3 more. Pass symbol");
  });
});
