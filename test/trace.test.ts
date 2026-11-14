/** Trace data from CODESYS: parsing, the summary the model reads, and the chart. */
import { describe, expect, it } from "vitest";
import { chartPage, parseTrace, summarize, table } from "../src/codesys/trace.js";
import { lineMap } from "../src/codesys/debug.js";

const SAVED = [
  "CODESYS V3.5 SP22 Patch 4 Trace: Trace_MCP",
  "C:\\PLC\\Projects\\Demo.project",
  "Timestamp(ms) PLC_PRG.rLevel PLC_PRG.xRun ",
  "0 10 0",
  "50 10.5 0",
  "100 11 1",
  "150 12.25 1",
  "200 11.5 0",
].join("\r\n");

describe("trace", () => {
  it("parses CODESYS's saved trace", () => {
    const d = parseTrace(SAVED);
    expect(d.vars).toEqual(["PLC_PRG.rLevel", "PLC_PRG.xRun"]);
    expect(d.t).toEqual([0, 50, 100, 150, 200]);
    expect(d.cols[1]).toEqual([0, 0, 1, 1, 0]);
    expect(() => parseTrace("nothing")).toThrow(/not a CODESYS trace/);
  });

  it("summarizes BOOL edges and numeric extremes with their times", () => {
    const s = summarize(parseTrace(SAVED));
    expect(s).toMatch(/^5 samples over 0\.20 s \(about every 50 ms\)\./);
    expect(s).toMatch(/PLC_PRG\.xRun \(BOOL\): starts FALSE, then TRUE at 100 ms, FALSE at 200 ms\./);
    expect(s).toMatch(/PLC_PRG\.rLevel: first 10, last 11\.5, min 10 at 0 ms, max 12\.25 at 150 ms\./);
  });

  it("thins the table and draws a lane per variable", () => {
    const d = parseTrace(SAVED);
    expect(table(d, 3).split("\n")).toEqual(["t (ms)\tPLC_PRG.rLevel\tPLC_PRG.xRun", "0\t10\t0", "100\t11\t1", "200\t11.5\t0"]);
    const c = chartPage(d, "Trace_MCP");
    expect(c.html.match(/<path /g)).toHaveLength(2);
    expect(c.html).toMatch(/>TRUE<\/text>/);
  });
});

describe("breakpoint positions", () => {
  it("map implementation lines to CODESYS positions (low 32 bits = line + offset)", () => {
    // Positions CODESYS returned for a 12-line FB on SP22 (offset 66), flag bits in the high part.
    const positions = [67, 1125899906842692, 69, 1125899906842694, 72, 73, 1125899906842698, 1125899906842699, 1125899906842701, 281474976710655];
    const impl = ["IF xStop THEN", "    xRunning := FALSE;", "ELSIF xStart THEN", "    xRunning := TRUE;", "END_IF", "tonRun(IN := xRunning, PT := T#24h);", "IF xRunning THEN", "    tRunTime := tRunTime + (tonRun.ET - tPrev);", "    tPrev := tonRun.ET;", "ELSE", "    tPrev := T#0s;", "END_IF"].join("\n");
    const m = lineMap(impl, positions);
    expect([...m.keys()]).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 11]);
    expect(m.get(6)).toBe(72);
    expect(m.get(2)).toBe(1125899906842692);
  });

  it("start from the first statement after comments", () => {
    const m = lineMap(["// header", "(* note *)", "x := 1;", "y := 2;"].join("\n"), [48, 49]);
    expect([...m]).toEqual([[3, 48], [4, 49]]);
  });
});

describe("simulation test expectations", () => {
  it("compare PLC values by value", async () => {
    const { check } = await import("../src/codesys/simtest.js");
    expect(check("TRUE", "TRUE")).toBe(true);
    expect(check("FALSE", "TRUE")).toBe(false);
    expect(check("INT#42", "42")).toBe(true);
    expect(check("REAL#1.5", "1.50")).toBe(true);
    expect(check("TIME#1s200ms", { op: ">=", value: 1000 })).toBe(true);
    expect(check("REAL#9.97", { op: "=", value: 10, tolerance: 0.05 })).toBe(true);
    expect(check("REAL#9.9", { op: "=", value: 10, tolerance: 0.05 })).toBe(false);
    expect(check("TRUE", { op: "=", value: 1 })).toBe(true);
    expect(check(undefined, "TRUE")).toBe(false);
  });
});
