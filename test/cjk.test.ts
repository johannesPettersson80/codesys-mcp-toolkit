/**
 * The batch mixer screen DeepSeek wrote in Chinese (its first hmi_save_screen, refused three
 * ways): a Chinese screen name, feed tanks without a level, pipes to "T-101" where the label is
 * "T-101 A 料". And what the export did with it: the title cut off, 11 px CJK card titles, the
 * tank's reading on the agitator.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nativePlan } from "../src/hmi/native.js";
import { renderScreen } from "../src/hmi/render.js";
import { drawOrder, resolveTagRefs, routePipe, routed, tankReading, tankReadingY, TANK_READING } from "../src/hmi/route.js";
import { layoutProblems, screenSchema, type ProcessItem } from "../src/hmi/spec.js";
import { BUILTIN_SYMBOLS } from "../src/hmi/symbols.js";
import { CJK_FONT, CJK_MIN, hasCjk, textLen, textWidth } from "../src/hmi/theme.js";

const FIRST = JSON.parse(readFileSync(new URL("./fixtures/mixer-cn.screen.json", import.meta.url), "utf8"));

describe("CJK text widths", () => {
  it("count a CJK character as about one em", () => {
    expect(hasCjk("Pump")).toBe(false);
    expect(hasCjk("T-301 搅拌罐")).toBe(true);
    expect(textLen("abcd")).toBe(4);
    expect(textLen("批次")).toBeCloseTo(3.6);
    // 8 characters at 18 px: one em each.
    expect(textWidth("批次配料搅拌装置", 18)).toBe(8 * 18);
    // Below the CJK minimum the minimum counts.
    expect(textWidth("报警", 11)).toBe(2 * CJK_MIN);
    expect(textWidth("ab", 10, 0.5)).toBe(10);
  });
});

describe("the batch mixer screen in Chinese", () => {
  it("refuses a Chinese screen name, saying why and what to do", () => {
    const r = screenSchema.safeParse(FIRST);
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    // Only the name now: tanks without a level are fine.
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/^name: .*Visu_<name>.*title/);
  });

  const screen = screenSchema.parse({ ...FIRST, name: "Process" });
  const proc = screen.widgets[0] as Extract<(typeof screen.widgets)[number], { type: "process" }>;

  it("connects pipes named by the tag a label starts with", () => {
    expect(layoutProblems(screen, BUILTIN_SYMBOLS).join("\n")).toMatch(/no symbol named 'T-101'/);
    resolveTagRefs(proc.items);
    expect(layoutProblems(screen, BUILTIN_SYMBOLS)).toEqual([]);
    const pipe = proc.items.find((p) => p.type === "pipe")!;
    expect(pipe.type === "pipe" && pipe.from).toBe("T-101 A 料.bottom");
  });

  it("leaves a tag two labels share alone", () => {
    const items = [
      { type: "tank", x: 0, y: 0, w: 10, h: 20, label: "T-1 A", max: 100 },
      { type: "tank", x: 30, y: 0, w: 10, h: 20, label: "T-1 B", max: 100 },
      { type: "pipe", from: "T-1.bottom", to: "T-1 B.top" },
    ] as ProcessItem[];
    resolveTagRefs(items);
    expect((items[2] as { from: string }).from).toBe("T-1.bottom");
  });

  it("draws feed tanks without a level: no liquid, no reading", () => {
    const html = renderScreen(screen).html;
    // One reading: the mixing tank's.
    expect(html.match(/class="tank-num"/g)).toHaveLength(1);
    expect(html.match(/class="tank-out"/g)).toHaveLength(3);
    const plan = nativePlan(screen);
    // The empty part's cover moves with the level: on the mixing tank only.
    expect(plan.elements.filter((e) => e.props?.["Relative movement.Movement bottom-right.Y"])).toHaveLength(1);
  });

  it("gives the title its full width and CJK text a font with the glyphs", () => {
    const plan = nativePlan(screen);
    const title = plan.elements.find((e) => e.text === "批次配料搅拌装置")!;
    expect(title.font![0]).toBe(CJK_FONT);
    expect(title.w).toBeGreaterThanOrEqual(8 * title.font![1]);
    const card = plan.elements.find((e) => e.text === "工艺流程")!;
    expect(card.font![1]).toBeGreaterThanOrEqual(CJK_MIN);
    // The HMI's own words in the screen's language (DeepSeek built its own Chinese buttons).
    const texts = plan.elements.map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining(["启动", "停止", "复位", "登录", "无活动报警"]));
    expect(texts).not.toContain("Start");
    expect(texts).not.toContain("Login");
    // The alarm rows' state words too (the take-6 page still said 'cleared').
    const alarms = screen.widgets.flatMap((w) => (w.type === "alarms" ? w.items : []));
    const withIdx = nativePlan(screen, [], {}, Object.fromEntries(alarms.map((x, i) => [x.active, i + 1])));
    expect(withIdx.helper.implementation).toMatch(/CASE iAs/);
    expect(withIdx.helper.implementation).toContain("'已清除'");
    expect(withIdx.helper.implementation).not.toContain("'cleared'");
    const html = renderScreen(screen).html;
    expect(html).toContain("启动");
    expect(html).not.toMatch(/>Start</);
    // An English screen keeps English, in Segoe UI.
    const en = nativePlan(screenSchema.parse({ ...screen, title: "Mixer", subtitle: undefined, widgets: screen.widgets.map((w) => ({ ...w, title: "Card" })), machine: { ...screen.machine!, idle: { text: "Idle", tone: "neutral" }, states: [{ on: "x", text: "Run", tone: "ok" }] } }));
    expect(en.elements.find((e) => e.text === "Start")?.font![0]).toMatch(/Segoe/);
  });

  it("puts the mixing tank's reading below the agitator", () => {
    const aspect = 0.42;
    const t = proc.items.find((p) => p.type === "tank" && p.label === "T-301 搅拌罐") as Extract<ProcessItem, { type: "tank" }>;
    const y = tankReadingY(t, proc.items, aspect);
    expect(y).toBeGreaterThan(t.y + t.h / 2);
    expect(y + TANK_READING.down / aspect).toBeLessThanOrEqual(t.y + t.h);
    // The impeller ends above the reading.
    const m = routed(proc.items, aspect).find((p) => p.type === "symbol")!;
    const h = m.type === "symbol" ? m.size / aspect : 0;
    expect(m.y + 0.42 * h).toBeLessThan(y - TANK_READING.up / aspect);
    // A tank without an agitator keeps it in the middle.
    const plain = { ...t, x: 0 };
    expect(tankReadingY(plain, [plain], aspect)).toBe(t.y + t.h / 2);
  });
});

describe("draw order", () => {
  it("draws a mixer listed before its tank over the tank", () => {
    // Take 3 of the batch mixer listed the agitator first; the tank's liquid hid its shaft.
    const items = [
      { type: "symbol", symbol: "mixer", x: 50, y: 57, size: 10 },
      { type: "tank", x: 38, y: 56, w: 24, h: 36, level: "GVL.rPct", max: 100, label: "M-101" },
      { type: "pipe", from: [0, 0], to: [10, 0] },
    ] as ProcessItem[];
    expect(drawOrder(items).map((p) => p.type)).toEqual(["pipe", "tank", "symbol"]);
    const screen = screenSchema.parse({ name: "P", title: "P", widgets: [{ type: "process", at: [1, 1, 8, 7], items }] });
    const html = renderScreen(screen).html;
    expect(html.indexOf('class="tank"')).toBeLessThan(html.lastIndexOf("<circle"));
  });
});

describe("a tank reading with a big agitator", () => {
  // Take 4: the agitator reaches too low for the reading to fit under it.
  const items = [
    { type: "tank", x: 50, y: 30, w: 22, h: 44, level: "GVL.rWeight", max: 70, unit: "kg", label: "MIX-1" },
    { type: "symbol", symbol: "mixer", x: 61, y: 52, size: 18 },
  ] as ProcessItem[];
  const tank = items[0] as Extract<ProcessItem, { type: "tank" }>;

  it("goes under take 4's agitator", () => {
    const r = tankReading(tank, items, 0.367);
    expect(r.backed).toBe(false);
    expect(r.y).toBeGreaterThan(62);
    expect(r.y + TANK_READING.down / 0.367).toBeLessThan(74);
  });

  it("stays in the middle on a box under a bigger one, drawn after the agitator", () => {
    // A short tank with a long agitator: no room under the impeller at any card shape.
    const short = [{ ...tank, h: 24 }, { ...items[1]!, size: 30 }] as ProcessItem[];
    expect(tankReading(short[0] as typeof tank, short, 0.367)).toEqual({ y: 42, backed: true });
    const screen = screenSchema.parse({ name: "P", title: "P", widgets: [{ type: "process", at: [1, 1, 8, 7], items: short }] });
    const html = renderScreen(screen).html;
    expect(html.indexOf('class="tank-box"')).toBeGreaterThan(html.lastIndexOf("<circle"));
    const plan = nativePlan(screen);
    const i = plan.elements.findIndex((e) => e.text === "%.0f kg");
    expect(plan.elements[i]!.kind).toBe("round");
    expect(plan.elements[i]!.fill).toBeDefined();
    const mixer = plan.elements.findIndex((e) => e.kind === "image" && /mixer/.test(String(e.props?.["Static ID"])));
    expect(mixer).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(mixer);
  });

  it("needs no box without an agitator", () => {
    expect(tankReading(tank, [tank], 0.367)).toEqual({ y: 52, backed: false });
  });
});

describe("feed lines from the side edge into a top nozzle", () => {
  // Take 4: both feeds started at the left edge level with their tank's top.
  const items = [
    { type: "tank", x: 5, y: 4, w: 17, h: 26, level: "GVL.rA", max: 500, label: "TA-01" },
    { type: "tank", x: 5, y: 64, w: 17, h: 26, level: "GVL.rB", max: 500, label: "TB-01" },
    { type: "pipe", from: [0, 4], to: "TA-01.top" },
    { type: "pipe", from: [0, 64], to: "TB-01.top" },
  ] as ProcessItem[];
  const route = (i: number) => routePipe(items[i] as Extract<ProcessItem, { type: "pipe" }>, items, 0.367);

  it("come in above the nozzle and turn down into it", () => {
    for (const [i, top] of [[2, 4], [3, 64]] as const) {
      const pts = route(i);
      expect(pts.length).toBeGreaterThanOrEqual(3);
      const [px, py] = pts[pts.length - 2]!;
      expect(px).toBe(13.5);
      expect(py).toBeLessThan(top);
      expect(pts[pts.length - 1]).toEqual([13.5, top]);
      expect(pts[0]![0]).toBe(0);
    }
  });
});

describe("a pipe into a mixer", () => {
  it("is refused with the tank to connect to instead", async () => {
    const { routeProblems } = await import("../src/hmi/route.js");
    const items = [
      { type: "tank", x: 38, y: 56, w: 24, h: 36, level: "GVL.rPct", max: 100, label: "M-101" },
      { type: "symbol", symbol: "mixer", x: 50, y: 57, size: 10, label: "AG-1" },
      { type: "pipe", from: [0, 60], to: "AG-1.left-high" },
    ] as ProcessItem[];
    expect(routeProblems(items).join("\n")).toMatch(/A mixer stands on its tank: connect the pipe to the tank, e\.g\. 'M-101\.left-high'/);
  });
});
