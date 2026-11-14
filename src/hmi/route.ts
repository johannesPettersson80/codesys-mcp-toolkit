/**
 * Ports and pipe routing for process diagrams. Symbols have named ports at
 * their edges; a pipe from 'T-101.right' to 'P-101.in' is routed with right
 * angles from port to port, so it always meets the symbols exactly, in the
 * browser and in the CODESYS visualization alike.
 *
 * Coordinates: x across the diagram in 0..100, y down in 0..100 of its height.
 * Symbol sizes are in x units, so a round symbol's height in y units is
 * size / aspect, where aspect = height / width of the diagram on screen.
 */
import type { ProcessItem } from "./spec.js";
import { BUILTIN_SYMBOLS, findSymbol, symbolBox, symbolPorts, type Dir, type SymbolLib } from "./symbols.js";

type Pt = [number, number];
export interface Port {
  at: Pt;
  dir: Dir;
}

const keyOf = (p: ProcessItem): string | undefined => ("id" in p && p.id) || ("label" in p && p.label) || undefined;

/**
 * Items (lower-case name) with something below them where the label would go: a pipe at a
 * port facing down (a tank's or pump's bottom, a symbol's port that faces down after its
 * rotation), or a motor's shaft pointing down at the machine it drives. Their label goes
 * beside it instead.
 */
export function bottomTaken(items: ProcessItem[], lib: SymbolLib = BUILTIN_SYMBOLS): Set<string> {
  const used = new Set<string>();
  for (const p of items) if (p.type === "pipe") for (const e of [p.from, p.to]) if (typeof e === "string") used.add(e.toLowerCase());
  const out = new Set<string>();
  for (const p of items) {
    const key = keyOf(p)?.toLowerCase();
    if (!key) continue;
    if (used.has(`${key}.bottom`)) out.add(key);
    if (p.type !== "symbol") continue;
    const f = findSymbol(lib, p.symbol);
    if (!f) continue;
    for (const [name, port] of Object.entries(symbolPorts(f[1], p, 1))) if (port.dir === "d" && (used.has(`${key}.${name}`) || name === "shaft")) out.add(key);
  }
  return out;
}

/** The name an item is connected by (its id, or its label). */
export const itemKey = (p: ProcessItem): string | undefined => keyOf(p);

/** The ports of a symbol (keyed by name), for a diagram of the given aspect. */
export function portsOf(p: ProcessItem, aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): Record<string, Port> {
  switch (p.type) {
    case "symbol": {
      const f = findSymbol(lib, p.symbol);
      return f ? symbolPorts(f[1], p, aspect) : {};
    }
    case "tank": {
      const { x, y, w, h } = p;
      const cx = x + w / 2;
      return {
        top: { at: [cx, y], dir: "u" },
        bottom: { at: [cx, y + h], dir: "d" },
        left: { at: [x, y + h * 0.85], dir: "l" },
        right: { at: [x + w, y + h * 0.85], dir: "r" },
        "left-high": { at: [x, y + h * 0.15], dir: "l" },
        "right-high": { at: [x + w, y + h * 0.15], dir: "r" },
      };
    }
    case "pump":
    case "fan": {
      const r = p.size / 2;
      const ry = r / aspect;
      return {
        in: { at: [p.x - r, p.y], dir: "l" },
        out: { at: [p.x + r, p.y], dir: "r" },
        top: { at: [p.x, p.y - ry], dir: "u" },
        bottom: { at: [p.x, p.y + ry], dir: "d" },
      };
    }
    case "valve": {
      const r = p.size / 2;
      return p.vertical
        ? { in: { at: [p.x, p.y + r / aspect], dir: "d" }, out: { at: [p.x, p.y - r / aspect], dir: "u" } }
        : { in: { at: [p.x - r, p.y], dir: "l" }, out: { at: [p.x + r, p.y], dir: "r" } };
    }
    case "junction":
      return { c: { at: [p.x, p.y], dir: "r" } };
    default:
      return {};
  }
}

/** Port names per symbol type, for messages and the tool description. */
export const PORT_NAMES: Record<string, string[]> = {
  tank: ["top", "bottom", "left", "right", "left-high", "right-high"],
  pump: ["in", "out", "top", "bottom"],
  fan: ["in", "out", "top", "bottom"],
  valve: ["in", "out"],
  junction: ["c"],
};

const connectable = (p: ProcessItem) => p.type in PORT_NAMES || p.type === "symbol";
const symbolMap = (items: ProcessItem[]) => new Map(items.flatMap((p) => (keyOf(p) && connectable(p) ? [[keyOf(p)!.toLowerCase(), p] as const] : [])));

/** The port names of a symbol on the diagram. */
function portNames(s: ProcessItem, lib: SymbolLib): string[] {
  if (s.type === "symbol") return Object.keys(findSymbol(lib, s.symbol)?.[1].ports ?? {});
  return PORT_NAMES[s.type] ?? [];
}

/** Problems with library symbols and pipe ends: unknown symbols or ports. */
export function routeProblems(items: ProcessItem[], lib: SymbolLib = BUILTIN_SYMBOLS): string[] {
  const syms = symbolMap(items);
  const out: string[] = [];
  items.forEach((p, i) => {
    if (p.type === "symbol" && !findSymbol(lib, p.symbol)) out.push(`item ${i + 1}: no symbol '${p.symbol}' in the library (symbols: ${Object.keys(lib).join(", ")}; add your own with hmi_save_symbol).`);
    if (p.type !== "pipe") return;
    for (const e of [p.from, p.to]) {
      if (typeof e !== "string") continue;
      const [name, port] = e.split(".") as [string, string];
      const s = syms.get(name.toLowerCase());
      if (!s) out.push(`pipe ${i + 1}: no symbol named '${name}' (symbols: ${[...syms.keys()].join(", ") || "none"}).`);
      else if (!portNames(s, lib).includes(port)) {
        const kind = s.type === "symbol" ? s.symbol : s.type;
        const names = portNames(s, lib);
        out.push(`pipe ${i + 1}: ${kind} '${name}' has no port '${port}' (${names.length ? `ports: ${names.join(", ")}` : "it has no ports"}).`);
      }
    }
  });
  return out;
}

const STEP: Record<Dir, Pt> = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
const horiz = (d: Dir) => d === "l" || d === "r";

/** The points of a pipe: right angles from port to port (or along raw points). */
export function routePipe(p: Extract<ProcessItem, { type: "pipe" }>, items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): Pt[] {
  if (!p.from || !p.to) return p.points ?? [];
  const syms = symbolMap(items);
  const resolve = (e: string | Pt, other?: Pt): Port => {
    if (typeof e !== "string") {
      // A free end at the diagram's edge leaves through that edge.
      if (e[0] <= 5) return { at: e, dir: "l" };
      if (e[0] >= 95) return { at: e, dir: "r" };
      if (e[1] <= 5) return { at: e, dir: "u" };
      if (e[1] >= 95) return { at: e, dir: "d" };
      // Otherwise it leaves towards the other end along the longer axis.
      const o = other ?? [50, 50];
      const dx = o[0] - e[0], dy = (o[1] - e[1]) / aspect;
      return { at: e, dir: Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "r" : "l") : dy >= 0 ? "d" : "u" };
    }
    const [name, port] = e.split(".") as [string, string];
    const s = syms.get(name.toLowerCase());
    const ports = s ? portsOf(s, aspect, lib) : {};
    return ports[port] ?? { at: [50, 50], dir: "r" };
  };
  const a0 = typeof p.from === "string" ? resolve(p.from) : undefined;
  const b0 = typeof p.to === "string" ? resolve(p.to) : undefined;
  const a = a0 ?? resolve(p.from, b0?.at ?? (Array.isArray(p.to) ? p.to : undefined));
  const b = b0 ?? resolve(p.to, a.at);
  // A junction takes the side facing the other end.
  const face = (port: Port, toward: Pt): Port => {
    if (!(typeof p.from === "string" && port === a && p.from.endsWith(".c")) && !(typeof p.to === "string" && port === b && p.to.endsWith(".c"))) return port;
    const dx = toward[0] - port.at[0], dy = (toward[1] - port.at[1]) / aspect;
    return { at: port.at, dir: Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "r" : "l") : dy >= 0 ? "d" : "u" };
  };
  const A = face(a, b.at);
  const B = face(b, a.at);
  const pts: Pt[] = [A.at];
  const targets: Pt[] = [...(p.via ?? []), B.at];
  let cur = A.at;
  let dir: Dir = A.dir;
  targets.forEach((t, k) => {
    const last = k === targets.length - 1;
    const endDir: Dir | undefined = last ? B.dir : undefined;
    for (const q of orthogonal(cur, dir, t, endDir)) pts.push(q);
    const prev = pts[pts.length - 2] ?? cur;
    dir = prev[0] === t[0] ? (t[1] >= prev[1] ? "d" : "u") : t[0] >= prev[0] ? "r" : "l";
    cur = t;
  });
  return dedupe(pts);
}

/** Right-angle path from `a` (leaving in `dir`) to `b` (entered against `endDir`), without `a` itself. */
function orthogonal(a: Pt, dir: Dir, b: Pt, endDir?: Dir): Pt[] {
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  if (eq(a[0], b[0]) || eq(a[1], b[1])) return [b];
  const inH = endDir ? horiz(endDir) : !horiz(dir);
  if (horiz(dir) && inH) {
    const mx = (a[0] + b[0]) / 2;
    return [[mx, a[1]], [mx, b[1]], b];
  }
  if (!horiz(dir) && !inH) {
    const my = (a[1] + b[1]) / 2;
    return [[a[0], my], [b[0], my], b];
  }
  return horiz(dir) ? [[b[0], a[1]], b] : [[a[0], b[1]], b];
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6) continue;
    // drop a middle point on a straight line
    const r = out[out.length - 2];
    if (q && r && ((Math.abs(r[0] - q[0]) < 1e-6 && Math.abs(q[0] - p[0]) < 1e-6) || (Math.abs(r[1] - q[1]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6))) out.pop();
    out.push(p);
  }
  return out;
}

/** The diagram with every pipe's points resolved. */
export function routed(items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): ProcessItem[] {
  return items.map((p) => (p.type === "pipe" ? { ...p, points: routePipe(p, items, aspect, lib), from: undefined, to: undefined, via: undefined } : p));
}

/**
 * Does the diagram make sense as a process? Equipment that no pipe reaches, an inlet
 * without an outlet, a heat exchanger with one circuit, tanks nothing flows into or out
 * of, instruments and sensors away from any line or tank, a motor whose shaft touches
 * nothing, pipes that stop in mid-diagram. Warnings: the screen still saves.
 */
export function connectionWarnings(items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): string[] {
  const out: string[] = [];
  const ends = new Map<string, { port: string; dir: "from" | "to" }[]>();
  const edge = (e: Pt) => e[0] <= 5 || e[0] >= 95 || e[1] <= 5 || e[1] >= 95;
  items.forEach((p, i) => {
    if (p.type !== "pipe") return;
    for (const [e, dir] of [[p.from, "from"], [p.to, "to"]] as const) {
      if (typeof e === "string") {
        const [n, port] = e.split(".") as [string, string];
        ends.set(n.toLowerCase(), [...(ends.get(n.toLowerCase()) ?? []), { port, dir }]);
      } else if (Array.isArray(e) && !edge(e as Pt)) out.push(`pipe ${i + 1} ${dir === "from" ? "starts" : "ends"} at [${e[0]}, ${e[1]}], in the middle of the diagram: connect it to a port, a junction, or the diagram's edge (where a line enters or leaves).`);
    }
  });
  const tanks = items.flatMap((p) => (p.type === "tank" ? [p] : []));
  const onTank = (x: number, y: number, m = 3) => tanks.some((t) => x >= t.x - m && x <= t.x + t.w + m && y >= t.y - m / aspect && y <= t.y + t.h + m / aspect);
  // Distances in x units (y scaled by the diagram's aspect).
  const lines = items.flatMap((p) => (p.type === "pipe" ? [routePipe(p, items, aspect, lib)] : []));
  const nearLine = (x: number, y: number, m: number) =>
    lines.some((pts) =>
      pts.slice(1).some((b, k) => {
        const a = pts[k]!;
        const [ax, ay, bx, by, px, py] = [a[0], a[1] * aspect, b[0], b[1] * aspect, x, y * aspect];
        const dx = bx - ax, dy = by - ay;
        const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
        return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= m;
      }),
    );
  // Boxes of driven equipment, for a motor's shaft.
  const machines = items.flatMap((p) => {
    if (p.type === "pump" || p.type === "fan") return [{ x0: p.x - p.size / 2, y0: p.y - p.size / 2 / aspect, x1: p.x + p.size / 2, y1: p.y + p.size / 2 / aspect }];
    if (p.type !== "symbol") return [];
    const f = findSymbol(lib, p.symbol);
    return f && f[0] !== "motor" ? [symbolBox(f[1], p, aspect)] : [];
  });
  items.forEach((p, i) => {
    const key = keyOf(p);
    const name = key ?? `${p.type === "symbol" ? p.symbol : p.type} ${i + 1}`;
    const e = key ? (ends.get(key.toLowerCase()) ?? []) : [];
    const used = new Set(e.map((x) => x.port));
    const pair = (a: string, b: string, what: string) => {
      if (used.has(a) && !used.has(b)) out.push(`${name} has a pipe at ${a} but none at ${b}: ${what}`);
      if (used.has(b) && !used.has(a)) out.push(`${name} has a pipe at ${b} but none at ${a}: ${what}`);
    };
    if (p.type === "tank") {
      if (!e.some((x) => x.dir === "to")) out.push(`tank ${name}: nothing flows in (no pipe with to: '${name}.<port>'). Where does the product come from?`);
      if (!e.some((x) => x.dir === "from")) out.push(`tank ${name}: nothing flows out (no pipe with from: '${name}.<port>'). Where does the product go?`);
    } else if (p.type === "pump" || p.type === "fan" || p.type === "valve") {
      if (!key) out.push(`${p.type} ${i + 1} has no label or id, so no pipe can connect to it.`);
      else if (!e.length) out.push(`${p.type} ${name} isn't connected: no pipe goes to it.`);
      else pair("in", "out", "what goes in must come out.");
    } else if (p.type === "junction") {
      if (e.length < 2) out.push(`junction ${name} joins ${e.length} pipe(s): a tee joins at least two.`);
    } else if (p.type === "sensor") {
      if (!nearLine(p.x, p.y, 9) && !onTank(p.x, p.y, 9)) out.push(`sensor ${name} isn't next to a pipe or tank: put it on the line or vessel it measures.`);
    } else if (p.type === "symbol") {
      const f = findSymbol(lib, p.symbol);
      if (!f) return;
      const [sym, def] = f;
      const ports = Object.keys(def.ports);
      if (sym === "mixer" || sym === "level_switch") {
        if (!onTank(p.x, p.y)) out.push(`${sym} ${name} isn't on a tank: an agitator or a level switch is mounted on the vessel it serves.`);
      } else if (ports.includes("shaft")) {
        const at = symbolPorts(def, p, aspect).shaft!.at;
        if (!machines.some((b) => at[0] >= b.x0 - 2 && at[0] <= b.x1 + 2 && at[1] >= b.y0 - 2 / aspect && at[1] <= b.y1 + 2 / aspect)) out.push(`${sym} ${name} drives nothing: put its shaft against the machine it drives.`);
      } else if (!ports.length) {
        return; // a picture without ports (a custom symbol can be decoration)
      } else if (!key) out.push(`${sym} ${i + 1} has no label or id, so no pipe can connect to it.`);
      else if (!e.length) out.push(sym === "pressure_switch" ? `pressure_switch ${name} isn't connected: run a short pipe from its bottom to the line it measures (a junction on that pipe).` : `${sym} ${name} isn't connected: no pipe goes to it (ports: ${ports.join(", ")}).`);
      else if (sym === "heat_exchanger") {
        if (!(used.has("in") && used.has("out") && used.has("top") && used.has("bottom"))) out.push(`heat exchanger ${name} needs both circuits: the product in and out (in, out) and the heating or cooling medium in and out (top, bottom).`);
      } else if (ports.includes("in") && ports.includes("out")) pair("in", "out", "what goes in must come out.");
    }
  });
  return out;
}

/** Symbols that overlap each other or leave the diagram, as warnings (the screen still saves). */
export function overlapWarnings(items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): string[] {
  type Box = { name: string; x0: number; y0: number; x1: number; y1: number };
  const boxes: Box[] = [];
  items.forEach((p, i) => {
    const name = `${p.type} ${keyOf(p) ?? i + 1}`;
    if (p.type === "tank") boxes.push({ name, x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h });
    else if (p.type === "pump" || p.type === "fan" || p.type === "valve") {
      const r = p.size / 2;
      boxes.push({ name, x0: p.x - r, y0: p.y - r / aspect, x1: p.x + r, y1: p.y + r / aspect });
    } else if (p.type === "symbol") {
      const f = findSymbol(lib, p.symbol);
      // Mounted symbols (agitator, level switch) are meant to sit on a tank: no overlap warning for them.
      // A motor touches the machine it drives.
      if (f && !["mixer", "level_switch", "motor"].includes(f[0])) boxes.push({ name: `${p.symbol} ${keyOf(p) ?? i + 1}`, ...symbolBox(f[1], p, aspect) });
    } else if (p.type === "sensor") boxes.push({ name, x0: p.x - 7, y0: p.y - 2.2 / aspect, x1: p.x + 7, y1: p.y + 2.2 / aspect });
  });
  const out: string[] = [];
  for (const b of boxes) if (b.x0 < 0 || b.y0 < 0 || b.x1 > 100 || b.y1 > 100) out.push(`${b.name} reaches outside the diagram (0..100).`);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) out.push(`${a.name} overlaps ${b.name}.`);
    }
  return out;
}
