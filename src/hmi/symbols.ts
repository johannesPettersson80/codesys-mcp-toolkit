/**
 * Process-diagram symbols: the built-in library (motor, conveyor, heat
 * exchanger, ...) and the project's own symbols, which Claude draws or imports
 * from the user's SVG files (hmi_save_symbol). One description serves both
 * renderers: inline SVG in the browser, and an SVG picture per state in the
 * CODESYS image pool.
 *
 * A symbol is SVG markup in its own box (viewBox, 100x100 by default) that
 * colours itself through a few variables, so one drawing shows every state:
 *   var(--state)  off: grey, on: green, fault: red
 *   var(--body)   main fill;  var(--body2) darker fill
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

/** The standard symbols. Pumps, fans, valves and tanks have their own item types. */
export const BUILTIN_SYMBOLS: SymbolLib = {
  motor: def(
    `<rect x="6" y="34" width="9" height="32" rx="2" fill="var(--body2)" stroke="var(--line)" stroke-width="2"/>
<rect x="15" y="24" width="62" height="52" rx="9" fill="var(--body)" stroke="var(--state)" stroke-width="4"/>
<path d="M27 30v40M37 30v40M55 30v40M65 30v40" stroke="var(--body2)" stroke-width="3.5" stroke-linecap="round"/>
<rect x="33" y="10" width="26" height="14" rx="3" fill="var(--body2)" stroke="var(--line)" stroke-width="2"/>
<rect x="77" y="44" width="17" height="12" rx="2" fill="var(--line)"/>
<circle cx="46" cy="50" r="9" fill="var(--state)"/>`,
    { shaft: [94, 50, "right"] },
    [100, 100],
    "Electric motor, shaft to the right",
  ),
  conveyor: def(
    `<rect x="5" y="16" width="190" height="28" rx="14" fill="var(--body2)" stroke="var(--state)" stroke-width="4"/>
<circle cx="19" cy="30" r="9" fill="var(--body)" stroke="var(--line)" stroke-width="2.5"/>
<circle cx="181" cy="30" r="9" fill="var(--body)" stroke="var(--line)" stroke-width="2.5"/>
<g class="spin"><path d="M19 23v14M12 30h14" stroke="var(--line)" stroke-width="2"/></g>
<circle cx="62" cy="30" r="4" fill="var(--line)"/><circle cx="100" cy="30" r="4" fill="var(--line)"/><circle cx="138" cy="30" r="4" fill="var(--line)"/>
<path d="M42 44l-6 14M158 44l6 14" stroke="var(--line)" stroke-width="3.5" stroke-linecap="round"/>`,
    {},
    [200, 60],
    "Belt conveyor (solids are dropped onto it: no pipe ports)",
  ),
  heat_exchanger: def(
    // Shell and tube: the product runs through the tubes from head to head, the heating or
    // cooling medium through the shell, in at the top and out at the bottom (counterflow).
    // The ports sit on the outline: a pipe runs up to the shell and ends under it, like a nozzle.
    `<rect x="8" y="22" width="22" height="36" rx="9" fill="var(--body2)" stroke="var(--line)" stroke-width="3"/>
<rect x="130" y="22" width="22" height="36" rx="9" fill="var(--body2)" stroke="var(--line)" stroke-width="3"/>
<rect x="26" y="16" width="108" height="48" rx="6" fill="var(--body)" stroke="var(--state)" stroke-width="4"/>
<path d="M36 28h88M36 40h88M36 52h88" stroke="var(--line)" stroke-width="2.5" stroke-linecap="round"/>
<path d="M36 18v44M124 18v44" stroke="var(--line)" stroke-width="3"/>`,
    { in: [8, 40, "left"], out: [152, 40, "right"], top: [116, 16, "up"], bottom: [44, 64, "down"] },
    [160, 80],
    "Shell-and-tube heat exchanger (twice as wide as high): product through the tubes (in left, out right), heating or cooling medium through the shell (top in, bottom out)",
  ),
  mixer: def(
    `<rect x="32" y="4" width="36" height="24" rx="5" fill="var(--body)" stroke="var(--state)" stroke-width="3.5"/>
<rect x="46" y="28" width="8" height="54" rx="2" fill="var(--line)"/>
<path d="M50 80L22 72v18zM50 80l28-8v18z" fill="var(--state)" stroke="var(--line)" stroke-width="2" stroke-linejoin="round"/>`,
    {},
    [100, 100],
    "Agitator: place it over a tank",
  ),
  filter: def(
    `<rect x="18" y="12" width="64" height="76" rx="9" fill="var(--body)" stroke="var(--state)" stroke-width="4"/>
<path d="M24 82L76 18" stroke="var(--line)" stroke-width="3.5" stroke-dasharray="7 5" stroke-linecap="round"/>`,
    { in: [18, 50, "left"], out: [82, 50, "right"] },
    [100, 100],
    "Filter or strainer, flow left to right",
  ),
  compressor: def(
    `<circle cx="50" cy="50" r="40" fill="var(--body)" stroke="var(--state)" stroke-width="4"/>
<path d="M17 27l66 12M17 73l66-12" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/>`,
    { in: [10, 50, "left"], out: [90, 50, "right"] },
    [100, 100],
    "Compressor or blower, inlet left",
  ),
  cylinder: def(
    `<rect x="6" y="14" width="84" height="32" rx="5" fill="var(--body)" stroke="var(--state)" stroke-width="4"/>
<rect x="44" y="18" width="9" height="24" rx="1" fill="var(--line)"/>
<rect x="53" y="27" width="62" height="6" rx="2" fill="var(--line)"/>
<rect x="22" y="46" width="7" height="10" fill="var(--line)"/><rect x="71" y="46" width="7" height="10" fill="var(--line)"/>`,
    { a: [25, 56, "down"], b: [75, 56, "down"] },
    [120, 60],
    "Pneumatic cylinder, rod to the right; ports a and b underneath",
  ),
  level_switch: def(
    `<rect x="34" y="4" width="32" height="14" rx="3" fill="var(--body2)" stroke="var(--line)" stroke-width="2"/>
<path d="M50 18v36" stroke="var(--line)" stroke-width="4" stroke-linecap="round"/>
<circle cx="50" cy="68" r="17" fill="var(--state)" stroke="var(--line)" stroke-width="3"/>
<path d="M16 93h68" stroke="var(--line)" stroke-width="3" stroke-dasharray="6 4"/>`,
    {},
    [100, 100],
    "Float level switch as a picture (HMI). On a P&ID use an instrument: {type: 'instrument', tag: 'LSH-201', at: 'T-201.left-high'}",
  ),
  pressure_switch: def(
    `<circle cx="50" cy="40" r="33" fill="var(--body)" stroke="var(--state)" stroke-width="4"/>
<path d="M27 54a26 26 0 0 1 46 0" fill="none" stroke="var(--line)" stroke-width="2.5" stroke-dasharray="3 4"/>
<path d="M50 40l19-17" stroke="var(--state)" stroke-width="4.5" stroke-linecap="round"/>
<circle cx="50" cy="40" r="5" fill="var(--line)"/>
<rect x="45" y="73" width="10" height="23" fill="var(--line)"/>`,
    { bottom: [50, 96, "down"] },
    [100, 100],
    "Pressure gauge as a picture (HMI). On a P&ID use an instrument: {type: 'instrument', tag: 'PSH-201', at: [x, y] on the line}",
  ),
  check_valve: def(
    `<path d="M4 30v40l46-20zM96 30v40L50 50z" fill="var(--state)" stroke="var(--line)" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M30 16h38M60 9l9 7-9 7" fill="none" stroke="var(--line)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    { in: [4, 50, "left"], out: [96, 50, "right"] },
    [100, 100],
    "Check (non-return) valve, flow left to right",
  ),
  control_valve: def(
    `<path d="M50 50V22" stroke="var(--line)" stroke-width="4"/>
<path d="M22 22a28 20 0 0 1 56 0z" fill="var(--body)" stroke="var(--line)" stroke-width="3" stroke-linejoin="round"/>
<path d="M4 32v36l46-18zM96 32v36L50 50z" fill="var(--state)" stroke="var(--line)" stroke-width="2.5" stroke-linejoin="round"/>`,
    { in: [4, 50, "left"], out: [96, 50, "right"], actuator: [50, 2, "up"] },
    [100, 100],
    "Control valve with diaphragm actuator; a signal line from its controller or transmitter goes to actuator",
  ),
};

/* ---------- checking custom SVG ---------- */

const ELEMENTS = new Set(["g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "text"]);
const ATTRS = new Set([
  "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "width", "height", "points", "transform", "id", "class",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "stroke-miterlimit", "opacity",
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
  const body = scopeIds(d.svg, name).replace(/var\(--(state|body2|body|line|accent)\)/g, (_, k: keyof SymbolColors) => colors[k]);
  const turn = rotate === 90 ? `translate(${vh} 0) rotate(90)` : rotate === 180 ? `rotate(180 ${vw / 2} ${vh / 2})` : rotate === 270 ? `translate(0 ${vw}) rotate(270)` : "";
  const [bw, bh] = rotate % 180 ? [vh, vw] : [vw, vh];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${wpx}" height="${hpx}" viewBox="0 0 ${bw} ${bh}">${turn ? `<g transform="${turn}">${body}</g>` : body}</svg>`;
}

/** A library entry by name, case-insensitive. */
export function findSymbol(lib: SymbolLib, name: string): [string, SymbolDef] | undefined {
  const k = Object.keys(lib).find((n) => n.toLowerCase() === name.toLowerCase());
  return k ? [k, lib[k]!] : undefined;
}
