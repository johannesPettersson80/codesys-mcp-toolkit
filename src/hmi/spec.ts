/**
 * HMI screens: what the model writes. A screen is a grid of tiles; each tile is
 * one widget bound to PLC variables (full instance paths, e.g. "PLC_PRG.fbPump.xRunning").
 * The same description renders as a live HTML/SVG screen in the browser, as a
 * screenshot for the model, and as a native CODESYS visualization.
 */
import * as z from "zod/v4";
import { routeProblems } from "./route.js";
import { ICON_NAMES } from "./icons.js";
import { BUILTIN_SYMBOLS, type SymbolLib } from "./symbols.js";

const v = z.string().min(1).describe("PLC variable, full path, e.g. 'PLC_PRG.fbPump.xRunning' or 'GVL.rLevel'");
const tone = z.enum(["accent", "ok", "warn", "alarm", "neutral"]);
const num = z.number();

/** A colour band for a value: from `from` upwards the value shows in `tone`. */
const band = z.object({ from: num, tone });

const at = z
  .tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)])
  .describe("[column, row, width, height] in grid cells, 1-based (the grid is 12 columns by 8 rows unless the screen sets grid)");

/** Visualization user groups, lowest first (the export creates them). */
export const USER_GROUPS = ["Operator", "Maintenance", "Admin"] as const;
const access = z
  .object({
    min: z.enum(USER_GROUPS).describe("The lowest group that may operate it (higher groups may too)"),
    below: z.enum(["see", "hide"]).default("see").describe("What lower groups get: see it without operating it, or not see it"),
  })
  .optional()
  .describe("Who may operate this tile in CODESYS's visualization, after Login, e.g. {min: 'Maintenance'} for setpoints only maintenance changes");
const icon = z.enum(ICON_NAMES).optional();
const base = { at, title: z.string().optional().describe("Card title, in sentence case"), icon: icon.describe("Line icon before the title, e.g. 'temperature'"), access };

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

/**
 * Equipment state, three independent things, each shown in its own place: the run state (or a
 * valve's position) by the item, the mode only in Manual, the condition only when not OK.
 */
const fault = v.optional().describe("BOOL: an alarm on this equipment (a red alarm badge at its corner)");
const warning = v.optional().describe("BOOL: a warning (an amber badge at its corner; an alarm wins)");
const manual = v.optional().describe("BOOL: in manual mode (a hand after its name; auto shows nothing)");
/** A value that belongs to the equipment (a valve's opening, a pump's speed), as plain text under its name. */
const shown = {
  value: v.optional().describe("A value of this equipment shown under its name, e.g. a control valve's opening or a pump's speed (not a separate sensor)"),
  unit: z.string().optional(),
  decimals: z.number().int().optional(),
};

/** Things placed on a process (mimic) diagram, in a 0..100 x 0..100 box scaled to the tile. */
const processItem = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tank"), id, x: num, y: num, w: num, h: num, level: v, max: num.default(100), unit: z.string().optional(), label: z.string().optional(), bands: z.array(band).optional() }),
  z.object({ type: z.literal("pump"), id, x: num, y: num, size: num.default(12), running: v.describe("BOOL: running (▶ before its name; ■ when stopped)"), fault, warning, manual, ...shown, label: z.string().optional(), faceplate: faceplate.optional() }),
  z.object({ type: z.literal("fan"), id, x: num, y: num, size: num.default(12), running: v.describe("BOOL: running (▶ before its name; ■ when stopped)"), fault, warning, manual, ...shown, label: z.string().optional(), faceplate: faceplate.optional() }),
  z.object({ type: z.literal("valve"), id, x: num, y: num, size: num.default(8), open: v.describe("BOOL: open (drawn hollow; closed is drawn filled, as on a P&ID)"), fault, warning, manual, ...shown, vertical: z.boolean().optional(), label: z.string().optional(), faceplate: faceplate.optional() }),
  z.object({ type: z.literal("junction"), id: z.string(), x: num, y: num }).describe("A tee or bend that several pipes meet at"),
  z
    .object({
      type: z.literal("symbol"),
      symbol: z.string().describe("A standard symbol (motor, conveyor, heat_exchanger, mixer, filter, compressor, cylinder, level_switch, pressure_switch, check_valve, control_valve) or one saved with hmi_save_symbol"),
      id,
      x: num.describe("Centre"),
      y: num.describe("Centre"),
      size: num.default(10).describe("Width in diagram units (0..100 across)"),
      rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional().describe("Clockwise, in degrees; ports turn with it"),
      on: v.optional().describe("BOOL: running (▶ before its name, ■ when stopped); for a valve symbol: open (closed is drawn filled)"),
      fault,
      warning,
      manual,
      ...shown,
      label: z.string().optional(),
      faceplate: faceplate.optional(),
    })
    .describe("A symbol from the library: hmi_symbols lists them with their ports"),
  z
    .object({
      type: z.literal("pipe"),
      from: end.optional(),
      to: end.optional(),
      via: z.array(z.tuple([num, num])).optional().describe("Points the pipe must pass, in order"),
      points: z.array(z.tuple([num, num])).min(2).optional().describe("Raw points instead of from/to (avoid: ends rarely meet the symbols)"),
      flow: v.optional().describe("BOOL: animate flow while TRUE"),
      label: z.string().optional().describe("Name of a line that enters or leaves at the diagram's edge, drawn at that end, e.g. 'Steam' or 'To filling'"),
      signal: z.boolean().optional().describe("An instrument signal, drawn thin and dashed, e.g. from 'TT-201.c' (a sensor) to 'TCV-201.actuator'"),
    })
    .refine((p) => (p.from && p.to) || p.points, { message: "a pipe needs from and to (ports or points), or points" }),
  z.object({ type: z.literal("sensor"), x: num, y: num, value: v, unit: z.string().optional(), label: z.string().optional(), decimals: z.number().int().optional() }),
  z
    .object({
      type: z.literal("instrument"),
      tag: z.string().regex(/^[A-Z]{1,5}-?\d{1,5}[A-Z]?$/).describe("ISA tag: function letters and loop number, e.g. 'TT-201', 'LSH-201', 'PSH-201', 'TIC-201'"),
      x: num,
      y: num,
      at: end.optional().describe("What it measures: a port on the vessel ('T-201.left-high') or a point [x, y] on a pipe. Left out: the nearest line or vessel wall"),
      value: v.optional().describe("Shown next to the bubble, e.g. a transmitter's reading"),
      unit: z.string().optional(),
      decimals: z.number().int().optional(),
      on: v.optional().describe("BOOL for a switch (LSH, PSH): the bubble lights while it is TRUE"),
      tone: tone.optional().describe("Colour when on (default warn)"),
    })
    .describe("A P&ID instrument (ISA-5.1 bubble) joined to the point it measures; signals to valves are pipes with signal: true from '<tag>.c'"),
  z.object({ type: z.literal("lamp"), x: num, y: num, on: v, tone: tone.optional(), label: z.string().optional() }),
  z.object({ type: z.literal("label"), x: num, y: num, text: z.string() }),
]);

/** A station on a line widget. */
const station = z.object({
  name: z.string().describe("Short name, e.g. 'Heating'"),
  tag: z.string().optional().describe("Equipment tag, e.g. 'E-201'"),
  symbol: z.string().optional().describe("Pictogram: 'tank', 'pump', 'valve', 'fan' or a symbol from the library, e.g. 'heat_exchanger'"),
  on: v.optional().describe("BOOL: running (▶ before its name, ■ when stopped)"),
  fault: v.optional().describe("BOOL: the station has an alarm (red badge, red top edge)"),
  warning: v.optional().describe("BOOL: a warning (amber badge and top edge; an alarm wins)"),
  manual: v.optional().describe("BOOL: in manual mode (a hand after its name)"),
  value: v.optional().describe("The station's key value"),
  unit: z.string().optional(),
  decimals: z.number().int().optional(),
  screen: z.string().optional().describe("The page a tap opens (its name)"),
});

export const widgetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("value"),
    ...base,
    value: v,
    unit: z.string().optional(),
    decimals: z.number().int().optional(),
    bands: z.array(band).optional(),
    min: num.optional().describe("With max: a thin scale under the number"),
    max: num.optional(),
    set: v.optional().describe("The set-point: a marker on the scale and 'Set' under the number"),
    trend: z.boolean().optional().describe("Small sparkline under the value"),
  }),
  z.object({ type: z.literal("gauge"), ...base, value: v, min: num.default(0), max: num.default(100), unit: z.string().optional(), decimals: z.number().int().optional(), bands: z.array(band).optional() }),
  z.object({ type: z.literal("bar"), ...base, value: v, min: num.default(0), max: num.default(100), unit: z.string().optional(), vertical: z.boolean().optional(), bands: z.array(band).optional(), set: v.optional().describe("The set-point, as a marker on the bar") }),
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
          icon,
        }),
      )
      .min(1),
  }),
  z.object({ type: z.literal("switch"), ...base, variable: v, label: z.string().optional() }),
  z.object({ type: z.literal("setpoint"), ...base, variable: v, min: num, max: num, step: num.optional(), unit: z.string().optional(), actual: v.optional().describe("The measured value, shown beside the set value"), decimals: z.number().int().optional() }),
  z
    .object({
      type: z.literal("state"),
      ...base,
      states: z
        .array(z.object({ on: v, text: z.string(), tone }))
        .min(1)
        .max(6)
        .describe("Machine states, most important first: the first whose BOOL is TRUE is shown, e.g. fault (alarm), manual (accent), running (ok), ready (warn)"),
      idle: z.object({ text: z.string(), tone }).default({ text: "Stopped", tone: "neutral" }).describe("Shown when no state is TRUE"),
      start: v.optional().describe("BOOL tapped by the Start button"),
      stop: v.optional().describe("BOOL tapped by the Stop button"),
      reset: v.optional().describe("BOOL tapped by the Reset button"),
    })
    .describe("A unit's state on a card (an icon in the state's colour, a thin line on top), with Start, Stop and Reset; the machine's own state goes in the screen's machine"),
  z
    .object({
      type: z.literal("mode"),
      ...base,
      variable: v,
      options: z.array(z.string()).min(2).max(4).describe("Labels, e.g. ['Manual', 'Auto']"),
      values: z.array(z.string()).optional().describe("What each option writes; default FALSE/TRUE for two options, else 0, 1, 2, 3"),
    })
    .describe("A segmented switch for an operating mode"),
  z.object({
    type: z.literal("trend"),
    ...base,
    series: z.array(z.object({ value: v, label: z.string().optional() })).min(1).max(6),
    min: num.optional(),
    max: num.optional(),
    seconds: z.number().int().min(5).max(3600).default(60),
  }),
  z.object({
    type: z.literal("alarms"),
    ...base,
    items: z.array(z.object({ active: v, text: z.string(), severity: z.enum(["info", "warning", "alarm"]).default("alarm") })).min(1),
    history: z.number().int().min(1).max(12).optional().describe("Also list the last N alarm events (time, message, state) from the alarm history the export puts in the PLC"),
  }),
  z.object({ type: z.literal("text"), ...base, text: z.string() }),
  z
    .object({
      type: z.literal("recipe"),
      ...base,
      recipe: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("The name given to create_recipes"),
      recipes: z.array(z.string()).min(1).describe("Its recipe names, in order"),
      save: z.boolean().default(true).describe("Also offer Save (store the current values in a recipe)"),
    })
    .describe("Recipes made with create_recipes: the active one, and Apply / Save per recipe"),
  z.object({ type: z.literal("process"), ...base, items: z.array(processItem).min(1) }),
  z
    .object({
      type: z.literal("line"),
      ...base,
      stations: z.array(station.extend({ feed: station.optional().describe("A supply joining this station from above, e.g. steam or a feeder") })).min(2).max(12).describe("The stations in the product's order, left to right"),
    })
    .describe("The process as station tiles on a product path (an overview, not a P&ID): each tile shows its pictogram, key value and state in words, and opens its page when tapped"),
]);

const modeOf = {
  variable: v,
  options: z.array(z.string()).min(2).max(4).describe("Labels, e.g. ['Manual', 'Auto']"),
  values: z.array(z.string()).optional().describe("What each option writes; default FALSE/TRUE for two options, else 0, 1, 2, 3"),
};

/** The machine as a whole: its state in the top bar's corner, its commands in the bottom bar. */
export const machineSchema = z
  .object({
    states: z
      .array(z.object({ on: v, text: z.string(), tone, icon: icon.describe("Default by tone: play (ok), fault (alarm), warning (warn), manual (accent), stop (neutral)") }))
      .min(1)
      .max(6)
      .describe("Machine states, most important first: the first whose BOOL is TRUE is shown, e.g. Fault (alarm), Manual (accent), Production (ok), Ready (warn)"),
    idle: z.object({ text: z.string(), tone, icon }).default({ text: "Stopped", tone: "neutral" }).describe("Shown when no state is TRUE"),
    detail: v.optional().describe("STRING shown under the state, e.g. 'error-free for 2 h 23 min'"),
    start: v.optional().describe("BOOL tapped by the Start button"),
    stop: v.optional().describe("BOOL tapped by the Stop button"),
    reset: v.optional().describe("BOOL tapped by the Reset button"),
    mode: z.object(modeOf).optional().describe("The operating mode, a segmented switch in the bottom bar"),
  })
  .describe("The machine's state, shown small in the top bar's left corner with a thin line in its colour under the bar, and Start / Stop / Reset and the mode in a bar along the bottom. Give it the same on every page.");

export const screenSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).describe("Screen name, e.g. 'Overview'"),
  title: z.string().describe("Shown in the header"),
  subtitle: z.string().optional(),
  theme: z.enum(["light", "dark", "contrast"]).default("light").describe("light (default), dark, or contrast: black and white with strong colours, for bright light or poor eyesight"),
  icon: icon.describe("The page's icon in the navigation rail, e.g. 'home', 'process', 'trend', 'alarm', 'recipe', 'settings'"),
  info: z
    .array(z.object({ label: z.string(), value: v.optional(), text: z.string().optional(), unit: z.string().optional(), decimals: z.number().int().optional() }))
    .max(4)
    .optional()
    .describe("Fields in the top bar, e.g. order, recipe, end of production: a label with a PLC value or a fixed text"),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .describe("Brand colour for highlights (current page, accent tiles, flow), e.g. '#e30613'; text on it turns black or white to stay readable"),
  machine: machineSchema.optional(),
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
export type Machine = z.infer<typeof machineSchema>;

/** Whether a screen has the bottom bar: a machine with Start, Stop, Reset or a mode. */
export function hasDock(s: { machine?: { start?: string; stop?: string; reset?: string; mode?: unknown } }): boolean {
  const m = s.machine;
  return !!m && !!(m.start || m.stop || m.reset || m.mode);
}

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
  for (const f of s.info ?? []) add(f.value);
  if (s.machine) {
    s.machine.states.forEach((x) => add(x.on));
    [s.machine.detail, s.machine.start, s.machine.stop, s.machine.reset, s.machine.mode?.variable].forEach(add);
  }
  for (const w of s.widgets) {
    switch (w.type) {
      case "value":
      case "gauge":
      case "bar":
        add(w.value);
        if (w.type !== "gauge") add(w.set);
        break;
      case "status":
        w.items.forEach((i) => add(i.on));
        break;
      case "buttons":
        w.items.forEach((i) => add(i.variable));
        break;
      case "switch":
      case "mode":
        add(w.variable);
        break;
      case "setpoint":
        add(w.variable);
        add(w.actual);
        break;
      case "state":
        w.states.forEach((x) => add(x.on));
        [w.start, w.stop, w.reset].forEach(add);
        break;
      case "trend":
        w.series.forEach((i) => add(i.value));
        break;
      case "alarms":
        w.items.forEach((i) => add(i.active));
        break;
      case "recipe":
        for (const m of ["iApply", "iSave", "sActive"]) add(`PRG_Recipe_${w.recipe}.${m}`);
        break;
      case "line":
        for (const s of w.stations) for (const x of [s, s.feed]) if (x) [x.on, x.fault, x.warning, x.manual, x.value].forEach(add);
        break;
      case "process":
        for (const p of w.items) {
          if ("faceplate" in p && p.faceplate) {
            const f = p.faceplate;
            [f.auto, f.start, f.stop, f.open, f.close, f.reset, f.setpoint?.variable].forEach(add);
            f.values?.forEach((x) => add(x.value));
          }
          if (p.type === "pump" || p.type === "fan" || p.type === "valve" || p.type === "symbol") [p.fault, p.warning, p.manual, p.value].forEach(add);
          if (p.type === "tank") add(p.level);
          else if (p.type === "pump") (add(p.running), add(p.fault));
          else if (p.type === "fan") add(p.running);
          else if (p.type === "valve") add(p.open);
          else if (p.type === "symbol") (add(p.on), add(p.fault));
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
export function layoutProblems(s: Screen, lib: SymbolLib = BUILTIN_SYMBOLS): string[] {
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
    if (w.type === "process") for (const msg of routeProblems(w.items, lib)) out.push(`widget ${i + 1} (process): ${msg}`);
  });
  return out;
}

/** Keys whose values are texts the operator reads (not variables, names or ids). */
const TEXT_KEYS = new Set(["title", "subtitle", "label", "text"]);

/** Every distinct text on the screens an operator reads, for translation. */
export function screenTexts(screens: Screen[]): string[] {
  const out = new Set<string>();
  const walk = (o: unknown) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object")
      for (const [k, v] of Object.entries(o)) {
        if (TEXT_KEYS.has(k) && typeof v === "string" && /[A-Za-zÀ-￿]/.test(v)) out.add(v);
        else walk(v);
      }
  };
  walk(screens);
  return [...out];
}

/** The screen with its texts translated (texts without a translation stay as they are). */
export function translateScreen<T>(screen: T, map: Record<string, string> | undefined): T {
  if (!map || !Object.keys(map).length) return screen;
  const walk = (o: unknown): unknown => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, TEXT_KEYS.has(k) && typeof v === "string" ? (map[v] ?? v) : walk(v)]));
    return o;
  };
  return walk(screen) as T;
}

export { plcValue } from "./value.js";
