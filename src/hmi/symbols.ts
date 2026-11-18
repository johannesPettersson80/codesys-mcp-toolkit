/**
 * Process-diagram symbols: the built-in library (motor, conveyor, heat
 * exchanger, ...) and the project's own symbols, which Claude draws or imports
 * from the user's SVG files (hmi_save_symbol). One description serves both
 * renderers: inline SVG in the browser, and an SVG picture per state in the
 * CODESYS image pool.
 *
 * A symbol is SVG markup in its own box (viewBox, 100x100 by default) that
 * colours itself through a few variables, so one drawing shows every state:
 *   var(--state)  the body's fill: grey off, bright on (a fault shows as an alarm marker beside it)
 *   var(--body)   a neutral fill;  var(--body2) a darker one
 *   var(--line)   outlines and details;  var(--accent) highlights
 * Ports are points on the box where pipes connect, with the direction a pipe
 * leaves in. An element with class="spin" turns while the symbol is on (browser).
 *
 * Custom SVG ends up in the HMI page, so it is checked against a short list of
 * elements and attributes and refused otherwise; nothing is "cleaned" silently.
 */
import * as z from "zod/v4";

export type Dir = "l" | "r" | "u" | "d";
type Pt = [number, number];

const portSchema = z.object({ x: z.number(), y: z.number(), dir: z.enum(["left", "right", "up", "down"]).describe("The way a pipe leaves the port") });

export const symbolSchema = z.object({
  svg: z.string().min(1).max(30_000).describe("SVG markup inside the symbol's box (no outer <svg>). Colours: var(--state), var(--body), var(--body2), var(--line), var(--accent), or fixed colours"),
  viewBox: z.tuple([z.number().positive(), z.number().positive()]).default([100, 100]).describe("Width and height of the box the markup is drawn in"),
  ports: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), portSchema).default({}).describe("Where pipes connect, in box coordinates, e.g. { in: { x: 0, y: 50, dir: 'left' } }"),
  description: z.string().max(200).optional(),
});
export type SymbolDef = z.infer<typeof symbolSchema>;
export type SymbolInput = z.input<typeof symbolSchema>;
export type SymbolLib = Record<string, SymbolDef>;

const DIR: Record<string, Dir> = { left: "l", right: "r", up: "u", down: "d" };

const def = (svg: string, ports: Record<string, [number, number, "left" | "right" | "up" | "down"]> = {}, viewBox: [number, number] = [100, 100], description?: string): SymbolDef => ({
  svg: svg.replace(/\n\s*/g, ""),
  viewBox,
  ports: Object.fromEntries(Object.entries(ports).map(([k, [x, y, dir]]) => [k, { x, y, dir }])),
  ...(description ? { description } : {}),
});

/**
 * The standard symbols, drawn from ISO 10628-2:2012 (geometry taken from the symbol files on
 * Wikimedia Commons, CC BY-SA 4.0, which reproduce the standard's tables): black-line symbols,
 * here in the theme's text colour, 2 px whatever the size. The body is hollow when off and
 * filled with a soft green when on; a fault shows as a red marker beside it. Ports are the
 * standard's preferred connection points, on the outline. Letters (the motor's M) stay upright
 * when a symbol is turned. Pumps, fans, valves and tanks have their own item types; instruments
 * (sensors, switches, gauges) are ISA-5.1 bubbles (the instrument item).
 */
const OUT = `stroke="var(--line)" stroke-width="2" vector-effect="non-scaling-stroke"`;
const LN = `fill="none" ${OUT} stroke-linecap="round" stroke-linejoin="round"`;
/** An upright M (IEC 60617 / ISO 10628-2 C0082) in a circle of radius r at (cx, cy). */
const motorM = (cx: number, cy: number, r: number) =>
  `<g data-upright="${cx} ${cy}"><path d="M${cx - r * 0.38} ${cy + r * 0.5}V${cy - r * 0.5}L${cx} ${cy + r * 0.05}L${cx + r * 0.38} ${cy - r * 0.5}V${cy + r * 0.5}" ${LN}/></g>`;
export const BUILTIN_SYMBOLS: SymbolLib = {
  motor: def(
    // ISO 10628-2 C0082: a circle with an M; the shaft to the right.
    `<path d="M75 50H100" ${LN}/>
<circle cx="50" cy="50" r="25" fill="var(--state)" ${OUT}/>
${motorM(50, 50, 25)}`,
    { shaft: [100, 50, "right"] },
    [100, 100],
    "Electric motor (ISO 10628-2 C0082), shaft to the right",
  ),
  conveyor: def(
    // ISO 10628-2 3821: a belt around two rollers.
    `<path d="M20 15H180A15 15 0 0 1 180 45H20A15 15 0 0 1 20 15Z" fill="var(--state)" ${OUT}/>
<circle cx="20" cy="30" r="9" fill="var(--body)" ${OUT}/>
<circle cx="180" cy="30" r="9" fill="var(--body)" ${OUT}/>`,
    {},
    [200, 60],
    "Belt conveyor (ISO 10628-2 3821); solids are dropped onto it: no pipe ports",
  ),
  heat_exchanger: def(
    // ISO 10628-2 X8079: a circle; the line goes in, up, down through the middle and out.
    `<circle cx="50" cy="50" r="40" fill="var(--state)" ${OUT}/>
<path d="M10 50H30L50 30V70L70 50H90" ${LN}/>`,
    { in: [10, 50, "left"], out: [90, 50, "right"], top: [50, 10, "up"], bottom: [50, 90, "down"] },
    [100, 100],
    "Heat exchanger (general), ISO 10628-2 X8079: product through it (in left, out right), heating or cooling medium in at the top, out at the bottom",
  ),
  plate_heat_exchanger: def(
    // ISO 10628-2 2516: a plate pack (3.5 : 1) with a cross and plate lines; four nozzles, two on top, two below.
    `<rect x="2" y="2" width="136" height="36" fill="var(--state)" ${OUT}/>
<path d="M10 2L130 38M130 2L10 38M30 2V38M70 2V38M110 2V38" ${LN}/>`,
    { in: [10, 38, "down"], out: [130, 2, "up"], "medium-in": [130, 38, "down"], "medium-out": [10, 2, "up"] },
    [140, 40],
    "Plate heat exchanger, ISO 10628-2 2516: product in bottom left, out top right; heating or cooling medium in bottom right, out top left (counterflow)",
  ),
  mixer: def(
    // ISO 10628-2 X8006 / 2672: the drive (M) on top, the shaft and the agitator (general) below; it sits on a vessel.
    `<path d="M50 30V75M38 75H58L38 92H58" ${LN}/>
<circle cx="50" cy="17" r="13" fill="var(--state)" ${OUT}/>
${motorM(50, 17, 13)}`,
    {},
    [100, 100],
    "Agitator with its motor (ISO 10628-2 X8006): place it on a tank, the agitator inside",
  ),
  filter: def(
    // ISO 10628-2 X8116 liquid filter (general): a housing with the filter insert dashed across the flow.
    `<rect x="25" y="15" width="50" height="70" fill="var(--state)" ${OUT}/>
<path d="M50 15V85" fill="none" ${OUT} stroke-dasharray="7 6"/>`,
    { in: [25, 50, "left"], out: [75, 50, "right"] },
    [100, 100],
    "Liquid filter (ISO 10628-2 X8116), flow left to right through the insert",
  ),
  compressor: def(
    // ISO 10628-2 2302: a circle with the flow narrowing to the outlet.
    `<circle cx="50" cy="50" r="40" fill="var(--state)" ${OUT}/>
<path d="M22 22L88 38M22 78L88 62" ${LN}/>`,
    { in: [10, 50, "left"], out: [90, 50, "right"] },
    [100, 100],
    "Compressor or vacuum pump (ISO 10628-2 2302), inlet left",
  ),
  cylinder: def(
    `<path d="M60 30H115" fill="none" stroke="var(--line)" stroke-width="5" stroke-linecap="round"/>
<rect x="5" y="15" width="80" height="30" fill="var(--state)" ${OUT}/>
<path d="M55 15V45" ${LN}/>`,
    { a: [25, 45, "down"], b: [65, 45, "down"] },
    [120, 60],
    "Pneumatic cylinder, rod to the right; air ports a and b on its underside",
  ),
  separator: def(
    // ISO 10628-2 X8036: centrifuge, separator, disc type: the bowl with its disc stack; the drive sits on it.
    `<rect x="20" y="2" width="60" height="96" fill="var(--state)" ${OUT}/>
<path d="M50 12V88M30 50L50 35L70 50M30 68L50 53L70 68M30 86L50 71L70 86" ${LN}/>`,
    { in: [20, 30, "left"], out: [80, 30, "right"], solids: [50, 98, "down"] },
    [100, 100],
    "Centrifugal separator, disc type (ISO 10628-2 X8036): feed in left, clarified product out right, solids out at the bottom; put its motor on top",
  ),
  check_valve: def(
    // ISO 10628-2 X8077: a valve with a filled dot at the inlet's upper corner; flow left to right.
    `<path d="M5 25V75L50 50ZM95 25V75L50 50Z" fill="var(--state)" ${OUT} stroke-linejoin="round"/>
<circle cx="5" cy="25" r="8" fill="var(--line)"/>`,
    { in: [5, 50, "left"], out: [95, 50, "right"] },
    [100, 100],
    "Check valve (ISO 10628-2 X8077), flow left to right",
  ),
  control_valve: def(
    // ISO 10628-2 X8087: a valve, continuously operated: the oblique arrow through it; the signal comes to the arrow's head.
    `<path d="M5 25V75L50 50ZM95 25V75L50 50Z" fill="var(--state)" ${OUT} stroke-linejoin="round"/>
<path d="M22 88L78 12M78 12L64 16M78 12L76 26" ${LN}/>`,
    { in: [5, 50, "left"], out: [95, 50, "right"], actuator: [50, 50, "up"] },
    [100, 100],
    "Control valve (ISO 10628-2 X8087); a signal line from its controller or transmitter goes to actuator (it comes down to the valve's centre)",
  ),
};

BUILTIN_SYMBOLS.level_switch = def(
  `<circle cx="50" cy="50" r="40" fill="var(--body)" ${OUT}/>`,
  { left: [10, 50, "left"], right: [90, 50, "right"], bottom: [50, 90, "down"] },
  [100, 100],
  "Level switch as an ISA-5.1 instrument bubble; its label is the tag (e.g. 'LSH-201'). Better: {type: 'instrument', tag: 'LSH-201', x, y (the bubble), at: 'T-201.left-high' (what it measures)}",
);
BUILTIN_SYMBOLS.pressure_switch = def(
  `<circle cx="50" cy="50" r="40" fill="var(--body)" ${OUT}/>`,
  { bottom: [50, 90, "down"] },
  [100, 100],
  "Pressure switch or gauge as an ISA-5.1 instrument bubble; its label is the tag (e.g. 'PSH-201'). Better: {type: 'instrument', tag: 'PSH-201', x, y (the bubble), at: [x, y] on the line}",
);

/**
 * Station pictograms (line widget) for the process items that aren't library symbols: a vessel
 * with dished ends, the centrifugal pump (ISO 10628-2 2322), the valve (2101) and the fan (X8164).
 */
export const PICTOGRAMS: SymbolLib = {
  tank: def(`<path d="M30 22Q30 10 50 10Q70 10 70 22V78Q70 90 50 90Q30 90 30 78Z" fill="var(--state)" ${OUT}/>`),
  pump: def(`<circle cx="50" cy="50" r="36" fill="var(--state)" ${OUT}/><path d="M50 14L86 50L50 86M14 50H86" ${LN}/>`),
  valve: def(`<path d="M12 31L50 50L12 69ZM88 31L50 50L88 69Z" fill="var(--state)" ${OUT} stroke-linejoin="round"/>`),
  fan: def(`<circle cx="50" cy="50" r="36" fill="var(--state)" ${OUT}/><path d="M24.5 24.5L50 50L24.5 75.5M50 50H86" ${LN}/>`),
};

/** A station's pictogram: a built-in pictogram or a library symbol, by name. */
export function findPictogram(lib: SymbolLib, name: string | undefined): [string, SymbolDef] | undefined {
  if (!name) return undefined;
  const k = name.toLowerCase();
  return PICTOGRAMS[k] ? [`pic_${k}`, PICTOGRAMS[k]] : findSymbol(lib, name);
}

/** A pictogram's drawn size in pixels in a box ph pixels high (84 % of it, the longer side). */
export function pictogramSize(d: SymbolDef, ph: number): { w: number; h: number } {
  const [vw, vh] = d.viewBox;
  const w = vw >= vh ? 0.84 * ph : (0.84 * ph * vw) / vh;
  return { w, h: (w * vh) / vw };
}

/** Symbols that are instruments: drawn as ISA-5.1 bubbles (the label is the tag, e.g. 'LSH-201'). */
export const INSTRUMENT_SYMBOLS: Record<string, string> = { level_switch: "LS", pressure_switch: "PS" };

/** Letters kept upright in a turned symbol: data-upright="cx cy" becomes the counter-rotation. */
export function upright(svg: string, rotate: number): string {
  return svg.replace(/ data-upright="([-\d.]+) ([-\d.]+)"/g, (_m, x: string, y: string) => (rotate ? ` transform="rotate(${-rotate} ${x} ${y})"` : ""));
}

/* ---------- checking custom SVG ---------- */

const ELEMENTS = new Set(["g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "text"]);
const ATTRS = new Set([
  "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "points", "transform", "id", "class",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "stroke-miterlimit", "opacity", "vector-effect", "data-upright",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "font-size", "font-weight", "font-family", "text-anchor", "dominant-baseline",
]);

/** Problems with custom symbol markup (empty when it is fine). */
export function svgProblems(svg: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[A-Za-z][-A-Za-z0-9]*\s*=\s*"[^"]*")*)\s*(\/?)>/y;
  const attr = /([A-Za-z][-A-Za-z0-9]*)\s*=\s*"([^"]*)"/g;
  let i = 0;
  while (i < svg.length && out.length < 8) {
    if (svg[i] !== "<") {
      const end = svg.indexOf("<", i);
      const textRun = svg.slice(i, end < 0 ? svg.length : end);
      if (/[>&]/.test(textRun)) out.push(`text '${textRun.trim().slice(0, 30)}' may not contain > or &.`);
      else if (textRun.trim() && stack[stack.length - 1] !== "text") out.push(`text '${textRun.trim().slice(0, 30)}' outside a <text> element.`);
      i = end < 0 ? svg.length : end;
      continue;
    }
    tag.lastIndex = i;
    const m = tag.exec(svg);
    if (!m) {
      out.push(`can't read the markup at '${svg.slice(i, i + 40)}' (only elements with double-quoted attributes; no comments, CDATA or <!...>).`);
      break;
    }
    const [whole, closing, name, attrs, selfClose] = m as unknown as [string, string, string, string, string];
    i += whole.length;
    if (!ELEMENTS.has(name)) {
      out.push(`<${name}> is not allowed (allowed: ${[...ELEMENTS].join(", ")}).`);
      continue;
    }
    if (closing) {
      if (stack.pop() !== name) out.push(`</${name}> doesn't close the element that is open.`);
      continue;
    }
    for (const [, a, val] of attrs.matchAll(attr) as Iterable<[string, string, string]>) {
      if (!ATTRS.has(a)) out.push(`attribute ${a} on <${name}> is not allowed.`);
      else if (a === "class" && val !== "spin") out.push(`class may only be "spin" (turns while the symbol is on).`);
      else if (/[<>&:\\]|javascript|expression\s*\(/i.test(val)) out.push(`${a}="${val.slice(0, 30)}" has a character or word that isn't allowed.`);
      else if (/url\(/i.test(val) && !/^url\(#[A-Za-z][\w-]*\)$/.test(val.trim())) out.push(`${a}="${val.slice(0, 30)}": only url(#id) of a gradient in this symbol.`);
      else if (/var\(/.test(val) && !/^var\(--(state|body|body2|line|accent)\)$/.test(val.trim())) out.push(`${a}="${val}": the colour variables are var(--state), var(--body), var(--body2), var(--line), var(--accent).`);
    }
    if (!selfClose) stack.push(name);
  }
  if (!out.length && stack.length) out.push(`<${stack[stack.length - 1]}> is never closed.`);
  return out;
}

/**
 * An SVG file (for example from Inkscape or Illustrator) as symbol markup:
 * the root's viewBox, its content without metadata, editor attributes and
 * comments, and style="" turned into attributes. What's left is checked as usual.
 */
export function importSvg(file: string): { svg: string; viewBox: [number, number] } {
  const src = file.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const root = /<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i.exec(src.trim());
  if (!root) throw new Error("That file has no <svg> element.");
  const rootAttrs = root[1]!;
  const vb = /viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(rootAttrs);
  const size = (k: "width" | "height") => Number.parseFloat(new RegExp(`\\s${k}\\s*=\\s*["']([\\d.]+)`, "i").exec(rootAttrs)?.[1] ?? "100");
  const [ox, oy, w, h] = vb ? [Number(vb[1]), Number(vb[2]), Number(vb[3]), Number(vb[4])] : [0, 0, size("width"), size("height")];
  const drop = "metadata|title|desc|sodipodi:[a-z-]+|inkscape:[a-z-]+";
  let body = root[2]!.replace(new RegExp(`<(${drop})\\b[^>]*/>`, "gi"), "").replace(new RegExp(`<(${drop})\\b[^>]*>[\\s\\S]*?</\\1>`, "gi"), "");
  // style="a:b;c:d" -> a="b" c="d" for the properties we keep
  body = body.replace(/\sstyle\s*=\s*"([^"]*)"/g, (_, s: string) =>
    s
      .split(";")
      .map((kv) => kv.split(":").map((t) => t.trim()) as [string, string])
      .filter(([k, v]) => k && v && ATTRS.has(k))
      .map(([k, v]) => ` ${k}="${v.replace(/"/g, "'")}"`)
      .join(""),
  );
  // editor and namespaced attributes, single quotes -> double quotes
  body = body.replace(/\s[a-z]+:[A-Za-z-]+\s*=\s*"[^"]*"/g, "").replace(/\s([A-Za-z-]+)\s*=\s*'([^']*)'/g, ' $1="$2"');
  body = body.replace(/\s(?:xml:space|data-[a-z-]+|version|xmlns(?::\w+)?)\s*=\s*"[^"]*"/g, "");
  if (ox || oy) body = `<g transform="translate(${-ox} ${-oy})">${body}</g>`;
  return { svg: body.trim(), viewBox: [w, h] };
}

/** Gradient and other ids made unique per symbol, so two symbols' ids can't clash. */
export function scopeIds(svg: string, prefix: string): string {
  return svg.replace(/\bid="([^"]+)"/g, `id="${prefix}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
}

/* ---------- geometry: the symbol's box, rotation and ports on the diagram ---------- */

export interface SymbolPlacement {
  x: number;
  y: number;
  size: number;
  rotate?: 0 | 90 | 180 | 270;
}

/** Width in x units and height in x units (isotropic) of the drawn symbol, before rotation. */
export function symbolSize(d: SymbolDef, size: number): { w: number; h: number } {
  return { w: size, h: (size * d.viewBox[1]) / d.viewBox[0] };
}

const ROT_DIR: Dir[] = ["r", "d", "l", "u"];
const rotDir = (dir: Dir, rot: number) => ROT_DIR[(ROT_DIR.indexOf(dir) + rot / 90) % 4]!;

/** A point of the box (box coordinates) on the diagram, with the symbol's rotation. */
function place(d: SymbolDef, p: SymbolPlacement, bx: number, by: number, aspect: number): Pt {
  const { w, h } = symbolSize(d, p.size);
  let lx = (bx / d.viewBox[0] - 0.5) * w;
  let ly = (by / d.viewBox[1] - 0.5) * h;
  const rot = p.rotate ?? 0;
  for (let k = 0; k < rot / 90; k++) [lx, ly] = [-ly, lx];
  return [p.x + lx, p.y + ly / aspect];
}

/** The symbol's ports on the diagram (aspect = height / width of the diagram on screen). */
export function symbolPorts(d: SymbolDef, p: SymbolPlacement, aspect: number): Record<string, { at: Pt; dir: Dir }> {
  return Object.fromEntries(Object.entries(d.ports).map(([k, port]) => [k, { at: place(d, p, port.x, port.y, aspect), dir: rotDir(DIR[port.dir]!, p.rotate ?? 0) }]));
}

/** The symbol's bounding box on the diagram, after rotation. */
export function symbolBox(d: SymbolDef, p: SymbolPlacement, aspect: number): { x0: number; y0: number; x1: number; y1: number } {
  const { w, h } = symbolSize(d, p.size);
  const [vw, vh] = (p.rotate ?? 0) % 180 ? [h, w] : [w, h];
  return { x0: p.x - vw / 2, y0: p.y - vh / 2 / aspect, x1: p.x + vw / 2, y1: p.y + vh / 2 / aspect };
}

/* ---------- pictures for CODESYS ---------- */

export interface SymbolColors {
  state: string;
  body: string;
  body2: string;
  line: string;
  accent: string;
}

/** A standalone SVG of the symbol in fixed colours, rotated, at a pixel size (CODESYS draws images at their own size). */
export function symbolPicture(d: SymbolDef, name: string, colors: SymbolColors, rotate: number, wpx: number, hpx: number): string {
  const [vw, vh] = d.viewBox;
  // A stroke marked non-scaling keeps its pixel width: CODESYS draws the picture at wpx, so it's converted to box units.
  const unit = vw / wpx;
  const body = upright(scopeIds(d.svg, name), rotate)
    .replace(/var\(--(state|body2|body|line|accent)\)/g, (_, k: keyof SymbolColors) => colors[k])
    .replace(/<[a-z]+\b[^>]*vector-effect="non-scaling-stroke"[^>]*>/g, (tag) => tag.replace(/ vector-effect="non-scaling-stroke"/, "").replace(/stroke-width="([\d.]+)"/, (_m, w: string) => `stroke-width="${Math.round(Number(w) * unit * 100) / 100}"`));
  const turn = rotate === 90 ? `translate(${vh} 0) rotate(90)` : rotate === 180 ? `rotate(180 ${vw / 2} ${vh / 2})` : rotate === 270 ? `translate(0 ${vw}) rotate(270)` : "";
  const [bw, bh] = rotate % 180 ? [vh, vw] : [vw, vh];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wpx}" height="${hpx}" viewBox="0 0 ${bw} ${bh}">${turn ? `<g transform="${turn}">${body}</g>` : body}</svg>`;
}

/** A library entry by name, case-insensitive. */
export function findSymbol(lib: SymbolLib, name: string): [string, SymbolDef] | undefined {
  const k = Object.keys(lib).find((n) => n.toLowerCase() === name.toLowerCase());
  return k ? [k, lib[k]!] : undefined;
}
