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

type Pt = [number, number];
type Dir = "l" | "r" | "u" | "d";
export interface Port {
  at: Pt;
  dir: Dir;
}

const keyOf = (p: ProcessItem): string | undefined => ("id" in p && p.id) || ("label" in p && p.label) || undefined;

/** The ports of a symbol (keyed by name), for a diagram of the given aspect. */
export function portsOf(p: ProcessItem, aspect: number): Record<string, Port> {
  switch (p.type) {
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

/** Problems with pipe ends: unknown symbols or ports. */
export function routeProblems(items: ProcessItem[]): string[] {
  const syms = new Map(items.flatMap((p) => (keyOf(p) && p.type in PORT_NAMES ? [[keyOf(p)!.toLowerCase(), p] as const] : [])));
  const out: string[] = [];
  items.forEach((p, i) => {
    if (p.type !== "pipe") return;
    for (const e of [p.from, p.to]) {
      if (typeof e !== "string") continue;
      const [name, port] = e.split(".") as [string, string];
      const s = syms.get(name.toLowerCase());
      if (!s) out.push(`pipe ${i + 1}: no symbol named '${name}' (symbols: ${[...syms.keys()].join(", ") || "none"}).`);
      else if (!PORT_NAMES[s.type]!.includes(port) || (s.type === "valve" && !["in", "out"].includes(port))) out.push(`pipe ${i + 1}: ${s.type} '${name}' has no port '${port}' (ports: ${PORT_NAMES[s.type]!.join(", ")}).`);
    }
  });
  return out;
}

const STEP: Record<Dir, Pt> = { l: [-1, 0], r: [1, 0], u: [0, -1], d: [0, 1] };
const horiz = (d: Dir) => d === "l" || d === "r";

/** The points of a pipe: right angles from port to port (or along raw points). */
export function routePipe(p: Extract<ProcessItem, { type: "pipe" }>, items: ProcessItem[], aspect: number): Pt[] {
  if (!p.from || !p.to) return p.points ?? [];
  const syms = new Map(items.flatMap((s) => (keyOf(s) && s.type in PORT_NAMES ? [[keyOf(s)!.toLowerCase(), s] as const] : [])));
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
    const ports = s ? portsOf(s, aspect) : {};
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
export function routed(items: ProcessItem[], aspect: number): ProcessItem[] {
  return items.map((p) => (p.type === "pipe" ? { ...p, points: routePipe(p, items, aspect), from: undefined, to: undefined, via: undefined } : p));
}

/** Symbols that overlap each other or leave the diagram, as warnings (the screen still saves). */
export function overlapWarnings(items: ProcessItem[], aspect: number): string[] {
  type Box = { name: string; x0: number; y0: number; x1: number; y1: number };
  const boxes: Box[] = [];
  items.forEach((p, i) => {
    const name = `${p.type} ${keyOf(p) ?? i + 1}`;
    if (p.type === "tank") boxes.push({ name, x0: p.x, y0: p.y, x1: p.x + p.w, y1: p.y + p.h });
    else if (p.type === "pump" || p.type === "fan" || p.type === "valve") {
      const r = p.size / 2;
      boxes.push({ name, x0: p.x - r, y0: p.y - r / aspect, x1: p.x + r, y1: p.y + r / aspect });
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
