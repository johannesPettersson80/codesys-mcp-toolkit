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
import { BUILTIN_SYMBOLS, findSymbol, INSTRUMENT_SYMBOLS, symbolBox, symbolPorts, type Dir, type SymbolLib } from "./symbols.js";

type Pt = [number, number];
export interface Port {
  at: Pt;
  dir: Dir;
}

const keyOf = (p: ProcessItem): string | undefined => ("id" in p && p.id) || ("tag" in p && p.tag) || ("label" in p && p.label) || undefined;

/** Where an item's label goes when the usual place (centred below it) is taken. */
export type LabelSpot = { side: "below-left" | "below-right" | "beside" | "above"; x: number };

/**
 * Labels that can't go centred below their item (lower-case name -> where instead): a pipe
 * leaves through the bottom (the label goes below, beside that pipe), a motor's shaft points
 * down at the machine it drives (beside the motor), or the item is mounted on a vessel, an
 * agitator or a level switch (above it, outside the tank).
 */
export function labelSpots(items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): Map<string, LabelSpot> {
  const used = new Set<string>();
  for (const p of items) if (p.type === "pipe" && !p.signal) for (const e of [p.from, p.to]) if (typeof e === "string") used.add(e.toLowerCase());
  const out = new Map<string, LabelSpot>();
  for (const p of items) {
    const key = keyOf(p)?.toLowerCase();
    if (!key) continue;
    if (p.type === "tank" && used.has(`${key}.bottom`)) out.set(key, { side: "below-left", x: p.x + p.w / 2 });
    else if ((p.type === "pump" || p.type === "fan") && used.has(`${key}.bottom`)) out.set(key, { side: "below-right", x: p.x });
    else if (p.type === "symbol") {
      const f = findSymbol(lib, p.symbol);
      if (!f) continue;
      if (["mixer", "level_switch"].includes(f[0])) {
        out.set(key, { side: "above", x: p.x });
        continue;
      }
      for (const [name, port] of Object.entries(symbolPorts(f[1], p, aspect))) {
        if (port.dir !== "d") continue;
        if (name === "shaft") out.set(key, { side: "beside", x: p.x });
        else if (used.has(`${key}.${name}`)) out.set(key, port.at[0] > p.x + 0.5 ? { side: "below-left", x: Math.min(port.at[0], p.x) } : { side: "below-right", x: Math.max(port.at[0], p.x) });
      }
    }
  }
  return out;
}

/** Per item: a pipe's name and which end is free (at the diagram's edge), where the name is drawn. */
export function lineEnds(items: ProcessItem[]): ({ label: string; at: "start" | "end" } | undefined)[] {
  return items.map((p) => {
    if (p.type !== "pipe" || !p.label) return undefined;
    return { label: p.label, at: Array.isArray(p.from) ? "start" : "end" };
  });
}

/** The nearest point on a flow line (not a signal) to (x, y) within max x units, for a sensor's leader. */
export function nearestOnLine(items: ProcessItem[], x: number, y: number, aspect: number, max: number): Pt | undefined {
  let best: { d: number; at: Pt } | undefined;
  for (const p of items) {
    if (p.type !== "pipe" || p.signal) continue;
    const pts = p.points ?? [];
    for (let k = 1; k < pts.length; k++) {
      const [a, b] = [pts[k - 1]!, pts[k]!];
      const [ax, ay, bx, by, py] = [a[0], a[1] * aspect, b[0], b[1] * aspect, y * aspect];
      const dx = bx - ax, dy = by - ay;
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
      const q: Pt = [ax + t * dx, (ay + t * dy) / aspect];
      const d = Math.hypot(x - q[0], (y - q[1]) * aspect);
      if (d <= max && (!best || d < best.d)) best = { d, at: q };
    }
  }
  return best?.at;
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
    case "pump": {
      // ISO 10628-2 2322: inlet and outlet on the axis, left and right of the circle.
      const rc = (p.size / 2) * PUMP_CASING;
      return {
        in: { at: [p.x - rc, p.y], dir: "l" },
        out: { at: [p.x + rc, p.y], dir: "r" },
      };
    }
    case "fan": {
      const r = p.size / 2;
      return { in: { at: [p.x - r, p.y], dir: "l" }, out: { at: [p.x + r, p.y], dir: "r" } };
    }
    case "valve": {
      const r = p.size / 2;
      return p.vertical
        ? { in: { at: [p.x, p.y + r / aspect], dir: "d" }, out: { at: [p.x, p.y - r / aspect], dir: "u" } }
        : { in: { at: [p.x - r, p.y], dir: "l" }, out: { at: [p.x + r, p.y], dir: "r" } };
    }
    case "junction":
      return { c: { at: [p.x, p.y], dir: "r" } };
    case "sensor":
    case "instrument":
      // The centre, for a signal line to the valve or controller it drives.
      return { c: { at: [p.x, p.y], dir: "r" } };
    default:
      return {};
  }
}

/** Port names per symbol type, for messages and the tool description. */
export const PORT_NAMES: Record<string, string[]> = {
  tank: ["top", "bottom", "left", "right", "left-high", "right-high"],
  pump: ["in", "out"],
  fan: ["in", "out"],
  valve: ["in", "out"],
  junction: ["c"],
  sensor: ["c"],
  instrument: ["c"],
};

/** The pump circle's radius as a share of half its size. */
export const PUMP_CASING = 0.82;

/**
 * The point an instrument measures, and the way its connection leaves that point: a port
 * (a vessel's nozzle), a point given on a pipe, or else the nearest line or vessel wall.
 */
export function instrumentTap(p: Extract<ProcessItem, { type: "instrument" }>, items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): Port | undefined {
  if (typeof p.at === "string") {
    const [name, port] = p.at.split(".") as [string, string];
    const s = symbolMap(items).get(name.toLowerCase());
    return s ? portsOf(s, aspect, lib)[port] : undefined;
  }
  const routedItems = items.map((q) => (q.type === "pipe" && !q.points ? { ...q, points: routePipe(q, items, aspect, lib) } : q));
  const [x, y] = p.at ?? [p.x, p.y];
  const onLine = nearestOnLine(routedItems, x, y, aspect, p.at ? 3 : 15);
  // Off a pipe the connection leaves across it (a horizontal pipe: up or down to the bubble).
  if (onLine) {
    const across = routedItems.some((q) => q.type === "pipe" && !q.signal && (q.points ?? []).some((a, k, pts) => k > 0 && Math.abs(a[1] - pts[k - 1]![1]) < 1e-6 && Math.abs(a[1] - onLine[1]) < 1e-6));
    return { at: onLine, dir: across ? (p.y < onLine[1] ? "u" : "d") : p.x < onLine[0] ? "l" : "r" };
  }
  if (p.at) return { at: p.at, dir: p.y < p.at[1] ? "u" : "d" };
  // A vessel wall within reach: the nearer side, at the bubble's height.
  for (const t of items) {
    if (t.type !== "tank" || p.y < t.y || p.y > t.y + t.h) continue;
    if (p.x < t.x && t.x - p.x <= 15) return { at: [t.x, p.y], dir: "l" };
    if (p.x > t.x + t.w && p.x - t.x - t.w <= 15) return { at: [t.x + t.w, p.y], dir: "r" };
  }
  return undefined;
}

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

type Box = { x0: number; y0: number; x1: number; y1: number };
type Equipment = Box & { key?: string; name: string };

/** The outlines pipes must not cross: tanks, pumps, fans, valves and symbols. */
function equipmentBoxes(items: ProcessItem[], aspect: number, lib: SymbolLib): Equipment[] {
  const out: Equipment[] = [];
  items.forEach((p, i) => {
    const key = keyOf(p);
    const name = `${p.type === "symbol" ? p.symbol : p.type} ${key ?? i + 1}`;
    if (p.type === "tank") out.push({ key, name, x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h });
    else if (p.type === "pump" || p.type === "fan" || p.type === "valve") {
      const r = p.size / 2;
      out.push({ key, name, x0: p.x - r, y0: p.y - r / aspect, x1: p.x + r, y1: p.y + r / aspect });
    } else if (p.type === "symbol") {
      const f = findSymbol(lib, p.symbol);
      // An agitator sits inside its tank; the tank's own box covers it.
      if (f && f[0] !== "mixer") out.push({ key, name, ...symbolBox(f[1], p, aspect) });
    }
  });
  return out;
}

/** The equipment a run of points passes through (its edges and corners don't count). */
function crossed(pts: Pt[], boxes: Equipment[], aspect: number): Equipment | undefined {
  const mx = 0.4, my = 0.4 / aspect;
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1]!, pts[k]!];
    const [x0, x1, y0, y1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
    const hit = boxes.find((q) => x0 < q.x1 - mx && x1 > q.x0 + mx && y0 < q.y1 - my && y1 > q.y0 + my);
    if (hit) return hit;
  }
  return undefined;
}

/** The equipment boxes a pipe may not cross: all but the items at its two ends. */
function obstaclesFor(p: Extract<ProcessItem, { type: "pipe" }>, items: ProcessItem[], aspect: number, lib: SymbolLib): Equipment[] {
  const ends = new Set([p.from, p.to].flatMap((e) => (typeof e === "string" ? [e.split(".")[0]!.toLowerCase()] : [])));
  return equipmentBoxes(items, aspect, lib).filter((q) => !q.key || !ends.has(q.key.toLowerCase()));
}

/**
 * An agitator stands on its vessel: whatever y it is given, it is seated with its motor on
 * the tank's top and the shaft and impeller inside (ISO 10628-2 X8006), so it can't cover
 * the tank's reading or float above it.
 */
export function seated(items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): ProcessItem[] {
  return items.map((p) => {
    if (p.type !== "symbol") return p;
    const f = findSymbol(lib, p.symbol);
    if (!f || f[0] !== "mixer") return p;
    const h = ((p.size * f[1].viewBox[1]) / f[1].viewBox[0]) / aspect;
    const t = items.find((q): q is Extract<ProcessItem, { type: "tank" }> => q.type === "tank" && p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y - h && p.y <= q.y + q.h);
    // The motor's circle ends 30 % down the symbol's box.
    return t ? { ...p, y: t.y + (0.5 - MIXER_MOTOR_BOTTOM) * h } : p;
  });
}

/** Where the mixer symbol's motor ends, as a share of its height (circle at 17 ± 13 of 100). */
const MIXER_MOTOR_BOTTOM = 0.3;

/** The points of a pipe: right angles from port to port (or along raw points). */
export function routePipe(p: Extract<ProcessItem, { type: "pipe" }>, items: ProcessItem[], aspect: number, lib: SymbolLib = BUILTIN_SYMBOLS): Pt[] {
  if (!p.from || !p.to) return p.points ?? [];
  const syms = symbolMap(items);
  const resolve = (e: string | Pt, other?: Pt): Port => {
    if (typeof e !== "string") {
      // A free end at the diagram's edge leaves through that edge (a corner point on the top or
      // bottom line, y 0 or 100, leaves through that one).
      if (e[1] <= 1) return { at: e, dir: "u" };
      if (e[1] >= 99) return { at: e, dir: "d" };
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
  // A line from the diagram's edge to a port comes in straight: its free end takes the port's level.
  const snap = (e: string | Pt, port?: Port): string | Pt => {
    if (typeof e === "string" || !port) return e;
    if (e[1] <= 1 || e[1] >= 99) return horiz(port.dir) ? e : [port.at[0], e[1]];
    if ((e[0] <= 5 || e[0] >= 95) && horiz(port.dir)) return [e[0], port.at[1]];
    if ((e[1] <= 5 || e[1] >= 95) && !horiz(port.dir)) return [port.at[0], e[1]];
    return e;
  };
  const a0 = typeof p.from === "string" ? resolve(p.from) : undefined;
  const b0 = typeof p.to === "string" ? resolve(p.to) : undefined;
  const a = a0 ?? resolve(snap(p.from, b0), b0?.at ?? (Array.isArray(p.to) ? p.to : undefined));
  const b = b0 ?? resolve(snap(p.to, a0), a.at);
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
  const obstacles = obstaclesFor(p, items, aspect, lib);
  let cur = A.at;
  let dir: Dir = A.dir;
  targets.forEach((t, k) => {
    const last = k === targets.length - 1;
    const endDir: Dir | undefined = last ? B.dir : undefined;
    const finish = (leg: Pt[]): Pt[] => {
      if (!(last && typeof p.to === "string")) return leg;
      // A port is entered from the side it faces: if the path would come in from behind
      // (into an actuator from below, say), it goes round to a stub in front of the port.
      const before = leg.length > 1 ? leg[leg.length - 2]! : cur;
      const behind = (B.dir === "u" && before[1] > t[1] + 1e-6) || (B.dir === "d" && before[1] < t[1] - 1e-6) || (B.dir === "l" && before[0] > t[0] + 1e-6) || (B.dir === "r" && before[0] < t[0] - 1e-6);
      if (!behind) return leg;
      const [sx, sy] = STEP[B.dir];
      const stub: Pt = [t[0] + sx * 3, t[1] + (sy * 3) / aspect];
      // Reach the stub across the port's axis, then turn into the port.
      return [...orthogonal(cur, dir, stub, horiz(B.dir) ? "u" : "r").filter((q) => q !== stub), stub, t];
    };
    // The first way that passes no other equipment (a pipe through a valve or tank it
    // isn't connected to reads as connected); if every way does, the plain one.
    const options = legOptions(cur, dir, t, endDir).map(finish);
    const inside = (o: Pt[]) => o.every((q) => q[0] >= 0 && q[0] <= 100 && q[1] >= 0 && q[1] <= 100);
    const leg = options.find((o, n) => (n === 0 || inside(o)) && !crossed([cur, ...o], obstacles, aspect)) ?? options[0]!;
    for (const q of leg) pts.push(q);
    const prev = pts[pts.length - 2] ?? cur;
    dir = prev[0] === t[0] ? (t[1] >= prev[1] ? "d" : "u") : t[0] >= prev[0] ? "r" : "l";
    cur = t;
  });
  return dedupe(pts);
}

/**
 * Right-angle paths from `a` to `b`, the plain one first: when both ends run the same way
 * (across, or up and down), the middle run can lie anywhere between them, or the whole run
 * can step aside just after its start and back just before its end (past something on a
 * straight line); and an L can instead go out a little, along, and in, so it passes beside
 * what lies in the corner.
 */
function legOptions(a: Pt, dir: Dir, b: Pt, endDir?: Dir): Pt[][] {
  const plain = orthogonal(a, dir, b, endDir);
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-6;
  const offsets = [4, -4, 7, -7, 11, -11, 16, -16];
  const inH = endDir ? horiz(endDir) : !horiz(dir);
  const shares = [0.25, 0.75, 0.1, 0.9, 0.4, 0.6];
  if (horiz(dir) && inH && Math.abs(b[0] - a[0]) > 4) {
    const s = Math.sign(b[0] - a[0]);
    const middles = eq(a[1], b[1]) ? [] : shares.map((f): Pt[] => [[a[0] + (b[0] - a[0]) * f, a[1]], [a[0] + (b[0] - a[0]) * f, b[1]], b]);
    const aside = offsets.map((o): Pt[] => [[a[0] + 2 * s, a[1]], [a[0] + 2 * s, a[1] + o], [b[0] - 2 * s, a[1] + o], [b[0] - 2 * s, b[1]], b]);
    return [plain, ...middles, ...aside];
  }
  if (!horiz(dir) && !inH && Math.abs(b[1] - a[1]) > 4) {
    const s = Math.sign(b[1] - a[1]);
    const middles = eq(a[0], b[0]) ? [] : shares.map((f): Pt[] => [[a[0], a[1] + (b[1] - a[1]) * f], [b[0], a[1] + (b[1] - a[1]) * f], b]);
    const aside = offsets.map((o): Pt[] => [[a[0], a[1] + 2 * s], [a[0] + o, a[1] + 2 * s], [a[0] + o, b[1] - 2 * s], [b[0], b[1] - 2 * s], b]);
    return [plain, ...middles, ...aside];
  }
  if (eq(a[0], b[0]) || eq(a[1], b[1])) return [plain];
  if (horiz(dir) && inH) return [plain, ...shares.map((s): Pt[] => [[a[0] + (b[0] - a[0]) * s, a[1]], [a[0] + (b[0] - a[0]) * s, b[1]], b])];
  if (!horiz(dir) && !inH) return [plain, ...shares.map((s): Pt[] => [[a[0], a[1] + (b[1] - a[1]) * s], [b[0], a[1] + (b[1] - a[1]) * s], b])];
  // An L: out from a, across at a level between them, then on to b.
  if (horiz(dir)) return [plain, ...shares.map((s): Pt[] => [[a[0] + (b[0] - a[0]) * s, a[1]], [a[0] + (b[0] - a[0]) * s, (a[1] + b[1]) / 2], [b[0], (a[1] + b[1]) / 2], b])];
  return [plain, ...shares.map((s): Pt[] => [[a[0], a[1] + (b[1] - a[1]) * s], [(a[0] + b[0]) / 2, a[1] + (b[1] - a[1]) * s], [(a[0] + b[0]) / 2, b[1]], b])];
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
  const all = seated(items, aspect, lib);
  return all.map((p) => (p.type === "pipe" ? { ...p, points: routePipe(p, all, aspect, lib), from: undefined, to: undefined, via: undefined } : p));
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
    if (p.type !== "pipe" || p.signal) return;
    for (const [e, dir] of [[p.from, "from"], [p.to, "to"]] as const) {
      if (typeof e === "string") {
        const [n, port] = e.split(".") as [string, string];
        ends.set(n.toLowerCase(), [...(ends.get(n.toLowerCase()) ?? []), { port, dir }]);
      } else if (Array.isArray(e) && !edge(e as Pt)) out.push(`pipe ${i + 1} ${dir === "from" ? "starts" : "ends"} at [${e[0]}, ${e[1]}], in the middle of the diagram: connect it to a port, a junction, or the diagram's edge (where a line enters or leaves).`);
    }
  });
  const tanks = items.flatMap((p) => (p.type === "tank" ? [p] : []));
  const onTank = (x: number, y: number, m = 3) => tanks.some((t) => x >= t.x - m && x <= t.x + t.w + m && y >= t.y - m / aspect && y <= t.y + t.h + m / aspect);
  // Inside a vessel's outline (an instrument drawn there is wrong: ISA-5.1 draws it outside, joined to its nozzle).
  const inTank = (x: number, y: number) => tanks.find((t) => x > t.x && x < t.x + t.w && y > t.y && y < t.y + t.h);
  const outside = (what: string, name: string, x: number, y: number) => {
    const t = inTank(x, y);
    if (t) out.push(`${what} ${name} is drawn inside tank ${keyOf(t) ?? ""}: instruments go outside the vessel, joined to the wall where they are mounted (ISA-5.1), e.g. {type: 'instrument', tag: '${name}', x: ${Math.round(t.x + t.w + 6)}, y: ${Math.round(y)}, at: '${keyOf(t) ?? "T-1"}.right-high'}.`);
    return !!t;
  };
  // Distances in x units (y scaled by the diagram's aspect).
  const lines = items.flatMap((p) => (p.type === "pipe" && !p.signal ? [routePipe(p, items, aspect, lib)] : []));
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
    } else if (p.type === "sensor" || p.type === "instrument") {
      const tag = p.type === "instrument" ? p.tag : name;
      if (outside(p.type, tag, p.x, p.y)) return;
      if (p.type === "sensor" && !nearLine(p.x, p.y, 9) && !onTank(p.x, p.y, 9)) out.push(`sensor ${name} isn't next to a pipe or tank: put it on the line or vessel it measures.`);
    } else if (p.type === "symbol") {
      const f = findSymbol(lib, p.symbol);
      if (!f) return;
      const [sym, def] = f;
      const ports = Object.keys(def.ports);
      if (sym === "level_switch" || sym === "pressure_switch") {
        if (outside(sym, name, p.x, p.y)) return;
      }
      if (sym === "mixer") {
        if (!onTank(p.x, p.y)) out.push(`${sym} ${name} isn't on a tank: an agitator is mounted on the vessel it serves.`);
      } else if (sym === "level_switch") {
        if (!onTank(p.x, p.y, 10)) out.push(`level_switch ${name} isn't beside a tank: a level switch is mounted on the vessel's wall, drawn outside it next to the level it switches at.`);
      } else if (ports.includes("shaft")) {
        const at = symbolPorts(def, p, aspect).shaft!.at;
        if (!machines.some((b) => at[0] >= b.x0 - 0.5 && at[0] <= b.x1 + 0.5 && at[1] >= b.y0 - 0.5 / aspect && at[1] <= b.y1 + 0.5 / aspect)) out.push(`${sym} ${name} drives nothing: its shaft end (${at.map((v) => Math.round(v * 10) / 10).join(", ")}) must touch the machine it drives (ISO 10628-2 draws the motor on the machine), not float near it.`);
      } else if (!ports.length) {
        return; // a picture without ports (a custom symbol can be decoration)
      } else if (!key) out.push(`${sym} ${i + 1} has no label or id, so no pipe can connect to it.`);
      else if (!e.length) out.push(sym === "pressure_switch" ? `pressure_switch ${name} isn't connected: run a short pipe from its bottom to the line it measures (a junction on that pipe).` : `${sym} ${name} isn't connected: no pipe goes to it (ports: ${ports.join(", ")}).`);
      else if (sym === "heat_exchanger") {
        if (!(used.has("in") && used.has("out") && used.has("top") && used.has("bottom"))) out.push(`heat exchanger ${name} needs both circuits: the product in and out (in, out) and the heating or cooling medium in and out (top, bottom).`);
      } else if (ports.includes("in") && ports.includes("out")) pair("in", "out", "what goes in must come out.");
    }
  });
  out.push(...meaningWarnings(items, lib));
  return out;
}

/** Equipment with no drive: it has no run state (a ▶ or ■ by its name would mean nothing). */
const PASSIVE = new Set(["filter", "heat_exchanger", "plate_heat_exchanger", "check_valve"]);

/**
 * Mistakes of meaning a layout check can't see: a reading drawn as a separate sensor that
 * belongs to a piece of equipment (its label names that equipment's tag, e.g. 'TCV-201
 * opening'), and a run state on equipment that has no drive.
 */
export function meaningWarnings(items: ProcessItem[], lib: SymbolLib = BUILTIN_SYMBOLS): string[] {
  const out: string[] = [];
  const tags = new Map(items.flatMap((p) => (keyOf(p) && p.type !== "sensor" && p.type !== "instrument" && p.type !== "pipe" ? [[keyOf(p)!.toUpperCase(), p] as const] : [])));
  for (const p of items) {
    if (p.type === "sensor" && p.label) {
      // 'TCV-201 opening': a tag of another item followed by more words.
      const m = /^([A-Z]{1,5}-?\d{1,5}[A-Z]?)\s+(.+)$/.exec(p.label.trim());
      const owner = m ? tags.get(m[1]!.toUpperCase()) : undefined;
      if (owner && (owner.type === "symbol" || owner.type === "pump" || owner.type === "fan" || owner.type === "valve"))
        out.push(`sensor '${p.label}' is a value of ${m![1]}: put it on ${m![1]} instead ({value: '${p.value}'${p.unit ? `, unit: '${p.unit}'` : ""}${p.decimals !== undefined ? `, decimals: ${p.decimals}` : ""}}), shown under its name, and remove the sensor.`);
    }
    if (p.type === "symbol" && p.on) {
      const f = findSymbol(lib, p.symbol);
      if (f && PASSIVE.has(f[0])) out.push(`${f[0]}${p.label ? ` ${p.label}` : ""} has on, but it has no drive, so no run state: remove on. For its condition use warning or fault (e.g. a clogged filter: warning).`);
      // A switch drawn as a symbol: its bubble has no run state, so on would show nothing.
      if (f && INSTRUMENT_SYMBOLS[f[0]])
        out.push(`${f[0]}${p.label ? ` ${p.label}` : ""} has on, which a bubble symbol doesn't show: draw it as {type: 'instrument', tag: '${/^[A-Z]{1,5}-?\d{1,5}[A-Z]?$/.test(p.label ?? "") ? p.label : `${INSTRUMENT_SYMBOLS[f[0]]}-1`}', x, y, at, on: <BOOL TRUE when tripped>}, tone: 'alarm' for an alarm; it gets the condition badge.`);
    }
  }
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
  // Text and value boxes lying across a pipe: name a line with the pipe's own label instead.
  const segs = items.flatMap((p) => {
    if (p.type !== "pipe" || p.signal) return [];
    const pts = routePipe(p, items, aspect, lib);
    return pts.slice(1).map((b, k) => [pts[k]!, b] as const);
  });
  // A pipe through equipment it isn't connected to (the router goes round when it can).
  items.forEach((p, i) => {
    if (p.type !== "pipe" || p.signal) return;
    const hit = crossed(routePipe(p, items, aspect, lib), obstaclesFor(p, items, aspect, lib), aspect);
    const end = (e: unknown) => (typeof e === "string" ? e : Array.isArray(e) ? `[${e.join(", ")}]` : "?");
    if (hit) out.push(`pipe ${i + 1} (${end(p.from)} to ${end(p.to)}) runs through ${hit.name}, which it isn't connected to: move one of them, or lead the pipe round with via: [[x, y]].`);
  });
  const crosses = (x0: number, y0: number, x1: number, y1: number) => segs.some(([a, b]) => Math.min(a[0], b[0]) - 0.6 < x1 && Math.max(a[0], b[0]) + 0.6 > x0 && Math.min(a[1], b[1]) - 0.6 / aspect < y1 && Math.max(a[1], b[1]) + 0.6 / aspect > y0);
  items.forEach((p) => {
    if (p.type === "label" && crosses(p.x, p.y - 1.7 / aspect, p.x + p.text.length * 1.05, p.y + 0.4 / aspect)) out.push(`label '${p.text}' lies across a pipe: move it, or name a line that enters or leaves at the edge with the pipe's label instead (e.g. {type: 'pipe', from: [40, 0], to: ..., label: 'Steam'}).`);
    if (p.type === "sensor" && crosses(p.x - 6.5, p.y - 2.1 / aspect, p.x + 6.5, p.y + 2.1 / aspect)) out.push(`sensor ${keyOf(p) ?? ""} covers a pipe: put it beside the line; a leader joins it to the line.`);
  });
  for (const b of boxes) if (b.x0 < 0 || b.y0 < 0 || b.x1 > 100 || b.y1 > 100) out.push(`${b.name} reaches outside the diagram (0..100).`);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) out.push(`${a.name} overlaps ${b.name}.`);
    }
  return out;
}
