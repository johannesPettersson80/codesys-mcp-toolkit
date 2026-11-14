/**
 * HMI screens: what the model writes. A screen is a grid of tiles; each tile is
 * one widget bound to PLC variables (full instance paths, e.g. "PLC_PRG.fbPump.xRunning").
 * The same description renders as a live HTML/SVG screen in the browser, as a
 * screenshot for the model, and as a native CODESYS visualization.
 */
import * as z from "zod/v4";
import { routeProblems } from "./route.js";

const v = z.string().min(1).describe("PLC variable, full path, e.g. 'PLC_PRG.fbPump.xRunning' or 'GVL.rLevel'");
const tone = z.enum(["accent", "ok", "warn", "alarm", "neutral"]);
const num = z.number();

/** A colour band for a value: from `from` upwards the value shows in `tone`. */
const band = z.object({ from: num, tone });

const at = z
  .tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)])
  .describe("[column, row, width, height] in grid cells, 1-based (the grid is 12 columns by 8 rows unless the screen sets grid)");

const base = { at, title: z.string().optional().describe("Tile title") };

const id = z.string().optional().describe("Name pipes connect to (default: the label, e.g. 'P-101')");
const faceplate = z
  .object({
    title: z.string().optional(),
    auto: v.optional().describe("BOOL: automatic mode (a switch)"),
    start: v.optional().describe("BOOL tapped by a Start button"),
    stop: v.optional().describe("BOOL tapped by a Stop button"),
    open: v.optional().describe("BOOL tapped by an Open button (valves)"),
    close: v.optional().describe("BOOL tapped by a Close button (valves)"),
    reset: v.optional().describe("BOOL tapped by a Reset button"),
    values: z.array(z.object({ label: z.string(), value: v, unit: z.string().optional(), decimals: z.number().int().optional() })).max(6).optional(),
    setpoint: z.object({ label: z.string().optional(), variable: v, min: num, max: num, step: num.optional(), unit: z.string().optional() }).optional(),
  })
  .describe("A popup opened by clicking the symbol: mode switch, Start/Stop or Open/Close, Reset, values and a setpoint");
const end = z
  .union([z.string().regex(/^[^.]+\.[a-z-]+$/), z.tuple([num, num])])
  .describe("A port 'P-101.out' (see the ports of each symbol) or a point [x, y] at the diagram's edge");

/** Things placed on a process (mimic) diagram, in a 0..100 x 0..100 box scaled to the tile. */
const processItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tank"), id, x: num, y: num, w: num, h: num, level: v, max: num.default(100), unit: z.string().optional(), label: z.string().optional(), bands: z.array(band).optional() }),
  z.object({ type: z.literal("pump"), id, x: num, y: num, size: num.default(12), running: v, fault: v.optional(), label: z.string().optional(), faceplate: faceplate.optional() }),
  z.object({ type: z.literal("fan"), id, x: num, y: num, size: num.default(12), running: v, label: z.string().optional(), faceplate: faceplate.optional() }),
  z.object({ type: z.literal("valve"), id, x: num, y: num, size: num.default(8), open: v, vertical: z.boolean().optional(), label: z.string().optional(), faceplate: faceplate.optional() }),
  z.object({ type: z.literal("junction"), id: z.string(), x: num, y: num }).describe("A tee or bend that several pipes meet at"),
  z
    .object({
      type: z.literal("pipe"),
      from: end.optional(),
      to: end.optional(),
      via: z.array(z.tuple([num, num])).optional().describe("Points the pipe must pass, in order"),
      points: z.array(z.tuple([num, num])).min(2).optional().describe("Raw points instead of from/to (avoid: ends rarely meet the symbols)"),
      flow: v.optional().describe("BOOL: animate flow while TRUE"),
    })
    .refine((p) => (p.from && p.to) || p.points, { message: "a pipe needs from and to (ports or points), or points" }),
  z.object({ type: z.literal("sensor"), x: num, y: num, value: v, unit: z.string().optional(), label: z.string().optional(), decimals: z.number().int().optional() }),
  z.object({ type: z.literal("lamp"), x: num, y: num, on: v, tone: tone.optional(), label: z.string().optional() }),
  z.object({ type: z.literal("label"), x: num, y: num, text: z.string() }),
]);

export const widgetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("value"), ...base, value: v, unit: z.string().optional(), decimals: z.number().int().optional(), bands: z.array(band).optional(), trend: z.boolean().optional().describe("Small sparkline under the value") }),
  z.object({ type: z.literal("gauge"), ...base, value: v, min: num.default(0), max: num.default(100), unit: z.string().optional(), decimals: z.number().int().optional(), bands: z.array(band).optional() }),
  z.object({ type: z.literal("bar"), ...base, value: v, min: num.default(0), max: num.default(100), unit: z.string().optional(), vertical: z.boolean().optional(), bands: z.array(band).optional() }),
  z.object({ type: z.literal("status"), ...base, items: z.array(z.object({ label: z.string(), on: v, tone: tone.optional(), invert: z.boolean().optional() })).min(1) }),
  z.object({
    type: z.literal("buttons"),
    ...base,
    items: z
      .array(
        z.object({
          label: z.string(),
          variable: v,
          action: z.enum(["tap", "toggle", "set", "reset"]).default("tap").describe("tap: TRUE while pressed; toggle: flips; set: writes TRUE; reset: writes FALSE"),
          tone: tone.optional(),
        }),
      )
      .min(1),
  }),
  z.object({ type: z.literal("switch"), ...base, variable: v, label: z.string().optional() }),
  z.object({ type: z.literal("setpoint"), ...base, variable: v, min: num, max: num, step: num.optional(), unit: z.string().optional() }),
  z.object({
    type: z.literal("trend"),
    ...base,
    series: z.array(z.object({ value: v, label: z.string().optional() })).min(1).max(6),
    min: num.optional(),
    max: num.optional(),
    seconds: z.number().int().min(5).max(3600).default(60),
  }),
  z.object({ type: z.literal("alarms"), ...base, items: z.array(z.object({ active: v, text: z.string(), severity: z.enum(["info", "warning", "alarm"]).default("alarm") })).min(1) }),
  z.object({ type: z.literal("text"), ...base, text: z.string() }),
  z.object({ type: z.literal("process"), ...base, items: z.array(processItem).min(1) }),
]);

export const screenSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Screen name, e.g. 'Overview'"),
  title: z.string().describe("Shown in the header"),
  subtitle: z.string().optional(),
  theme: z.enum(["dark", "light"]).default("dark"),
  size: z.enum(["1280x720", "1920x1080", "1024x768", "800x480"]).default("1280x720").describe("Panel resolution; use the same on every page"),
  grid: z.tuple([z.number().int().min(2).max(24), z.number().int().min(2).max(16)]).default([12, 8]).describe("[columns, rows]"),
  widgets: z.array(widgetSchema).min(1),
});

export type Widget = z.infer<typeof widgetSchema>;
export type ProcessItem = z.infer<typeof processItem>;
export type Screen = z.infer<typeof screenSchema>;
/** A screen as written, with defaults left out. */
export type ScreenInput = z.input<typeof screenSchema>;
export type Tone = z.infer<typeof tone>;
export type Faceplate = z.infer<typeof faceplate>;

/** Every alarm on any screen, for the header's alarm count. */
export function allAlarms(screens: Screen[]): { active: string; text: string; severity: string }[] {
  const seen = new Map<string, { active: string; text: string; severity: string }>();
  for (const s of screens) for (const w of s.widgets) if (w.type === "alarms") for (const a of w.items) seen.set(a.active, a);
  return [...seen.values()];
}

/** Every PLC variable a screen reads or writes. */
export function screenVariables(s: Screen): string[] {
  const out = new Set<string>();
  const add = (x?: string) => x && out.add(x);
  for (const w of s.widgets) {
    switch (w.type) {
      case "value":
      case "gauge":
      case "bar":
        add(w.value);
        break;
      case "status":
        w.items.forEach((i) => add(i.on));
        break;
      case "buttons":
        w.items.forEach((i) => add(i.variable));
        break;
      case "switch":
      case "setpoint":
        add(w.variable);
        break;
      case "trend":
        w.series.forEach((i) => add(i.value));
        break;
      case "alarms":
        w.items.forEach((i) => add(i.active));
        break;
      case "process":
        for (const p of w.items) {
          if ("faceplate" in p && p.faceplate) {
            const f = p.faceplate;
            [f.auto, f.start, f.stop, f.open, f.close, f.reset, f.setpoint?.variable].forEach(add);
            f.values?.forEach((x) => add(x.value));
          }
          if (p.type === "tank") add(p.level);
          else if (p.type === "pump") (add(p.running), add(p.fault));
          else if (p.type === "fan") add(p.running);
          else if (p.type === "valve") add(p.open);
          else if (p.type === "pipe") add(p.flow);
          else if (p.type === "sensor") add(p.value);
          else if (p.type === "lamp") add(p.on);
        }
        break;
      default:
        break;
    }
  }
  return [...out];
}

/** Overlapping or out-of-grid tiles, as readable problems (empty when the layout is fine). */
export function layoutProblems(s: Screen): string[] {
  const [cols, rows] = s.grid;
  const out: string[] = [];
  const cells = new Map<string, number>();
  s.widgets.forEach((w, i) => {
    const [c, r, wd, ht] = w.at;
    const name = `widget ${i + 1} (${w.type}${w.title ? ` "${w.title}"` : ""})`;
    if (c + wd - 1 > cols || r + ht - 1 > rows) out.push(`${name} at [${w.at.join(", ")}] runs past the ${cols}x${rows} grid.`);
    for (let x = c; x < c + wd; x++)
      for (let y = r; y < r + ht; y++) {
        const k = `${x},${y}`;
        const other = cells.get(k);
        if (other !== undefined && other !== i) {
          out.push(`${name} overlaps widget ${other + 1} at cell ${k}.`);
          return;
        }
        cells.set(k, i);
      }
  });
  s.widgets.forEach((w, i) => {
    if (w.type === "process") for (const msg of routeProblems(w.items)) out.push(`widget ${i + 1} (process): ${msg}`);
  });
  return out;
}

export { plcValue } from "./value.js";
