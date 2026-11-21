/**
 * Where the texts of a process diagram go, for the browser and the CODESYS export alike:
 * each item's label and each line's name tries the usual places in
 * turn and takes the one that runs into the least (equipment, pipes, readings, texts
 * already placed, the diagram's edge). Pure.
 *
 * Coordinates are "x-units": a hundredth of the diagram's width, on both axes (an item's
 * y from the spec times the aspect, height/width). Text positions are the text's centre.
 */
import { findSymbol, INSTRUMENT_SYMBOLS, symbolBox, type SymbolLib } from "./symbols.js";
import { instrumentTap, itemKey, labelSpots, lineEnds, nearestOnLine, PUMP_CASING, routed as routedFor, TANK_READING, tankReadingY } from "./route.js";
import type { ProcessItem } from "./spec.js";
import { textLen } from "./theme.js";

type Box = { x0: number; y0: number; x1: number; y1: number };

/** A reading's balloon (a sensor's value beside its bubble), in x-units: width, height and text size. */
export const READING = { w: 10, h: 3.2, text: 1.8 } as const;

/** Text sizes in x-units (the browser's CSS for .p-label, .st-word, .p-line). */
export const TEXT = { label: 1.75, line: 1.9 } as const;
/** About how wide a text is: semibold with letter-spacing (labels and line names). */
const widthOf = (t: string, size: number) => textLen(t) * size * 0.62;

export interface PlacedLabel {
  /** The anchor point's x and the label's centre y (of the whole name line). */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  /** The name line's left edge and the x where the name's text starts and ends (after the run sign, before the hand). */
  x0: number;
  textX: number;
  textEnd: number;
  /** The centre y of the equipment's own value, under the name line (when it has one). */
  valueY: number;
}

/** Sizes of the name line's signs, in x-units: the run sign (with its gap) before the name, the hand (with its gap) after it. */
export const SIGN = { lead: 2.1, tail: 2.7, run: 1.3, hand: 2.1 } as const;

/** What an item's name line carries: its run state (driven equipment), its mode variable, and whether it is a valve. */
export function nameParts(p: ProcessItem): { run?: string; manual?: string; valve: boolean; value?: string } {
  switch (p.type) {
    case "pump":
    case "fan":
      return { run: p.running, manual: p.manual, valve: false, value: p.value };
    case "valve":
      return { manual: p.manual, valve: true, value: p.value };
    case "symbol": {
      const valve = /valve/i.test(p.symbol);
      return { run: valve ? undefined : p.on, manual: p.manual, valve, value: p.value };
    }
    default:
      return { valve: false };
  }
}

/** The key placeTexts files an item's name line under: its name, else its place. */
export function textKey(p: ProcessItem): string {
  return itemKey(p)?.toLowerCase() ?? ("x" in p ? `@${p.x},${p.y}` : "");
}

/** About how wide a name is, in x-units (exported for the CODESYS export's text boxes). */
export const nameWidth = (t: string) => widthOf(t, TEXT.label);
export interface PlacedLine {
  x: number;
  y: number;
  anchor: "start" | "end";
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** An item's outline in x-units (undefined for items without one). */
export function itemBox(p: ProcessItem, aspect: number, lib: SymbolLib): Box | undefined {
  const a = aspect;
  switch (p.type) {
    case "tank":
      return { x0: p.x, x1: p.x + p.w, y0: p.y * a, y1: (p.y + p.h) * a };
    case "pump":
    case "fan": {
      const rr = p.type === "pump" ? (p.size / 2) * PUMP_CASING : p.size / 2;
      return { x0: p.x - rr, x1: p.x + rr, y0: p.y * a - rr, y1: p.y * a + rr };
    }
    case "valve": {
      const [hw, hh] = p.vertical ? [p.size / 4, p.size / 2] : [p.size / 2, p.size / 4];
      return { x0: p.x - hw, x1: p.x + hw, y0: p.y * a - hh, y1: p.y * a + hh };
    }
    case "symbol": {
      const f = findSymbol(lib, p.symbol);
      if (!f) return undefined;
      const b = symbolBox(f[1], p, a);
      return { x0: b.x0, x1: b.x1, y0: b.y0 * a, y1: b.y1 * a };
    }
    case "instrument":
    case "sensor":
      return { x0: p.x - 3.3, x1: p.x + 3.3, y0: p.y * a - 3.3, y1: p.y * a + 3.3 };
    case "lamp":
      return { x0: p.x - 2.2, x1: p.x + 3 + (p.label ? widthOf(p.label, TEXT.label) : 0), y0: p.y * a - 2.2, y1: p.y * a + 2.2 };
    case "label":
      return { x0: p.x, x1: p.x + widthOf(p.text, 2), y0: p.y * a - 1.6, y1: p.y * a + 0.6 };
    case "junction":
      return { x0: p.x - 1.1, x1: p.x + 1.1, y0: p.y * a - 1.1, y1: p.y * a + 1.1 };
    default:
      return undefined;
  }
}

/**
 * Where a sensor's or instrument's reading box goes (its centre, x-units): right of the
 * bubble, else left, else above or below it (away from its connection at tapY).
 */
export function readingSpot(p: { x: number; y: number }, all: ProcessItem[], aspect: number, lib: SymbolLib, tapY?: number): { x: number; y: number } {
  const cy = p.y * aspect, R = 3.3;
  const boxes = all.flatMap((q) => (q.type === "tank" || q.type === "symbol" ? [itemBox(q, aspect, lib)].filter((b): b is Box => !!b) : []));
  const hw = READING.w / 2, hh = READING.h / 2;
  const free = (cx: number) => !boxes.some((b) => b.x0 < cx + hw && b.x1 > cx - hw && b.y0 < cy + hh && b.y1 > cy - hh);
  const right = p.x + R + 0.8 + hw, left = p.x - R - 0.8 - hw;
  if (free(right)) return { x: right, y: cy };
  if (free(left)) return { x: left, y: cy };
  return { x: p.x, y: tapY !== undefined && tapY > cy ? cy - R - 0.6 - hh : cy + R + 0.6 + hh };
}

/** Texts on a process diagram that find no free place (for hmi_save_screen's layout notes). */
export function textWarnings(items: ProcessItem[], aspect: number, lib: SymbolLib): string[] {
  const all = items.map((p) => p);
  const { crowded } = placeTexts(routedFor(all, aspect, lib), aspect, lib, lineEnds(all));
  return crowded.map((c) => `The ${c} has no free place: it touches a pipe, equipment or another text. Leave room beside or below the item (or move it), e.g. a few units more between neighbours.`);
}

/** The y (x-units) where a sensor's or instrument's connection meets what it measures. */
export function tapY(p: ProcessItem, all: ProcessItem[], aspect: number, lib: SymbolLib): number | undefined {
  if (p.type === "instrument") {
    const t = instrumentTap(p, all, aspect, lib);
    return t ? t.at[1] * aspect : undefined;
  }
  if (p.type === "sensor") {
    const at = nearestOnLine(all, p.x, p.y, aspect, 9);
    return at ? at[1] * aspect : undefined;
  }
  return undefined;
}

/**
 * The texts' places. `items` are routed (pipes have points); `tapYOf` gives an instrument's
 * connection y (x-units) where the renderer knows it, for its reading's place.
 */
export function placeTexts(
  items: ProcessItem[],
  aspect: number,
  lib: SymbolLib,
  ends: ReturnType<typeof lineEnds> = lineEnds(items),
  tapYOf: (p: ProcessItem) => number | undefined = (p) => tapY(p, items, aspect, lib),
): { labels: Map<string, PlacedLabel>; lines: Map<number, PlacedLine>; crowded: string[] } {
  const a = aspect;
  // The diagram's height; texts may reach a little into the card's padding below it.
  const H = 100 * a + 1;
  const taken: Box[] = [];
  const hard: Box[] = [];
  // Equipment, bubbles and readings.
  const owns = new Map<ProcessItem, Box>();
  for (const p of items) {
    const b = itemBox(p, a, lib);
    if (b) (hard.push(b), owns.set(p, b));
    // A tank's level reading in its middle.
    if (p.type === "tank" && p.level) {
      const ry = tankReadingY(p, items, a, lib) * a;
      hard.push({ x0: p.x + p.w / 2 - 4, x1: p.x + p.w / 2 + 4, y0: ry - TANK_READING.up, y1: ry + TANK_READING.down });
    }
    if ((p.type === "sensor" || p.type === "instrument") && p.value) {
      const r = readingSpot(p, items, a, lib, tapYOf(p));
      hard.push({ x0: r.x - READING.w / 2, x1: r.x + READING.w / 2, y0: r.y - READING.h / 2, y1: r.y + READING.h / 2 });
    }
    if (p.type === "sensor" && p.label && !/^[A-Z]{1,5}-?\d{1,5}[A-Z]?$/.test(p.label)) hard.push({ x0: p.x - widthOf(p.label, TEXT.label) / 2, x1: p.x + widthOf(p.label, TEXT.label) / 2, y0: p.y * a - 4.4, y1: p.y * a - 2.2 });
  }
  // Pipes as thin bands.
  for (const p of items) {
    if (p.type !== "pipe") continue;
    const pts = p.points ?? [];
    for (let k = 1; k < pts.length; k++) {
      const [x1, y1] = [pts[k - 1]![0], pts[k - 1]![1] * a];
      const [x2, y2] = [pts[k]![0], pts[k]![1] * a];
      hard.push({ x0: Math.min(x1, x2) - 0.6, x1: Math.max(x1, x2) + 0.6, y0: Math.min(y1, y2) - 0.6, y1: Math.max(y1, y2) + 0.6 });
    }
  }
  /** How badly a place fits; `own` (the item's outline) doesn't count, so a name may sit inside its own vessel. */
  const cost = (b: Box, rank: number, own?: Box) => {
    const out = Math.max(0, 0.5 - b.x0) + Math.max(0, b.x1 - 99.5) + Math.max(0, 0.5 - b.y0) + Math.max(0, b.y1 - (H - 0.5));
    return out * 400 + hard.reduce((s, h) => s + (h === own ? 0 : overlap(b, h)), 0) * 12 + taken.reduce((s, h) => s + overlap(b, h), 0) * 30 + rank * 0.8;
  };
  const crowded: string[] = [];
  const best = <T,>(cands: { box: Box; v: T }[], name: string, own?: Box): { box: Box; v: T } => {
    let pick = cands[0]!;
    let c = Infinity;
    cands.forEach((cd, i) => {
      const k = cost(cd.box, i, own);
      if (k < c - 1e-9) (c = k), (pick = cd);
    });
    // Even the best place runs into something: worth telling whoever drew the diagram.
    if (cost(pick.box, 0, own) > 20) crowded.push(name);
    taken.push(pick.box);
    return pick;
  };

  // Line names first: they belong at their line's free end, on one side or the other.
  const lines = new Map<number, PlacedLine>();
  ends.forEach((e, n) => {
    const p = items[n];
    if (!e || !p || p.type !== "pipe" || !p.points?.length) return;
    const [x, yy] = e.at === "start" ? p.points[0]! : p.points[p.points.length - 1]!;
    const y = yy * a;
    const w = widthOf(e.label, TEXT.line), h = 2.4;
    const top = yy <= 1 || (yy <= 5 && x > 5 && x < 95), bottom = yy >= 99 || (yy >= 95 && x > 5 && x < 95);
    const at = (lx: number, ly: number, anchor: "start" | "end") => ({ box: { x0: anchor === "start" ? lx : lx - w, x1: anchor === "start" ? lx + w : lx, y0: ly - h / 2, y1: ly + h / 2 }, v: { x: lx, y: ly, anchor } });
    const cands = top
      ? [at(x + 1.6, y + 2, "start"), at(x - 1.6, y + 2, "end")]
      : bottom
        ? [at(x - 1.6, y - 1.4, "end"), at(x + 1.6, y - 1.4, "start")]
        : x <= 5
          ? [at(x + 1, y - 2.2, "start"), at(x + 1, y + 2.4, "start")]
          : [at(x - 1, y - 2.2, "end"), at(x - 1, y + 2.4, "end")];
    // The usual side first (as before): a top end right of the line unless near the right edge; a bottom end left unless near the left edge.
    if ((top && x > 75) || (bottom && x < 25)) cands.reverse();
    lines.set(n, best(cands, `line name '${e.label}'`).v);
  });

  // Item labels, the larger items first (they have the fewest good places).
  const spots = labelSpots(items, a, lib);
  // Items with a name, or with signs to show (an unnamed pump still shows its run sign).
  const labelled = items.filter((p) => (p.type === "tank" || p.type === "pump" || p.type === "fan" || p.type === "valve" || (p.type === "symbol" && !INSTRUMENT_SYMBOLS[findSymbol(lib, p.symbol)?.[0] ?? ""])) && (("label" in p && p.label) || nameParts(p).run || nameParts(p).manual || nameParts(p).value));
  const area = (p: ProcessItem) => { const b = itemBox(p, a, lib); return b ? (b.x1 - b.x0) * (b.y1 - b.y0) : 0; };
  const labels = new Map<string, PlacedLabel>();
  for (const p of [...labelled].sort((m, n) => area(n) - area(m))) {
    const b = itemBox(p, a, lib);
    const key = textKey(p);
    if (!b || !key) continue;
    const label = (p as { label?: string }).label ?? "";
    const parts = nameParts(p);
    const lead = parts.run ? SIGN.lead : 0, tail = parts.manual ? SIGN.tail : 0, tw = widthOf(label, TEXT.label);
    // The name line, and the equipment's own value under it.
    const w = Math.max(lead + tw + tail, parts.value ? 9 : 0), h = 2.4 + (parts.value ? 2.3 : 0);
    const cx = (p as { x: number }).x, mid = (b.y0 + b.y1) / 2;
    const spot = spots.get(key);
    const px = spot && (spot.side === "below-left" || spot.side === "below-right") ? spot.x : cx;
    /** The label's box from its top; anchor sets where x is. */
    const at = (x: number, top: number, anchor: PlacedLabel["anchor"]) => {
      const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
      return { box: { x0, x1: x0 + w, y0: top, y1: top + h }, v: { x, y: top + 1.2, anchor, x0, textX: x0 + lead, textEnd: x0 + lead + tw, valueY: top + 3.5 } };
    };
    const below = b.y1 + 0.8, above = b.y0 - 0.6 - h;
    // A vessel's name inside it, under its top (or just above or below its level reading): it can't be taken for a neighbour's.
    const dish = Math.min((b.x1 - b.x0) * 0.18, (b.y1 - b.y0) * 0.12);
    const cands = {
      inside: at((b.x0 + b.x1) / 2, b.y0 + dish + 0.6, "middle"),
      "inside-mid": at((b.x0 + b.x1) / 2, mid - 2.2 - 0.6 - h, "middle"),
      "inside-low": at((b.x0 + b.x1) / 2, mid + 1.6 + 0.5, "middle"),
      below: at(cx, below, "middle"),
      "below-right": at(px + 1.4, below, "start"),
      "below-left": at(px - 1.4, below, "end"),
      right: at(b.x1 + 1, mid - h / 2, "start"),
      "right-low": at(b.x1 + 1, b.y1 - h, "start"),
      "right-high": at(b.x1 + 1, b.y0, "start"),
      left: at(b.x0 - 1, mid - h / 2, "end"),
      "left-low": at(b.x0 - 1, b.y1 - h, "end"),
      "left-high": at(b.x0 - 1, b.y0, "end"),
      above: at(cx, above, "middle"),
      "above-right": at(cx + 1.4, above, "start"),
      "above-left": at(cx - 1.4, above, "end"),
    };
    // An inside place only where it lies wholly in the vessel: on a short tank "inside-mid" reached
    // above its top, and the name sat on the outline (TA-01 in the batch mixer, take 4).
    const within = (k: keyof typeof cands) => cands[k].box.y0 >= b.y0 && cands[k].box.y1 <= b.y1;
    const order: (keyof typeof cands)[] = p.type === "tank" ? (["inside", "inside-mid", "inside-low", "below", "above"] as const).filter((k) => !k.startsWith("inside") || within(k)) : ["below", "below-right", "below-left", "right-low", "right", "right-high", "left-low", "left", "left-high", "above", "above-right", "above-left"];
    // The place the drawing's rules ask for first (a pipe or shaft below: beside it; an agitator: above), a vertical valve's beside it.
    const first: keyof typeof cands | undefined = p.type === "tank" ? undefined : spot ? (spot.side === "beside" ? (b.x1 > 85 ? "above" : "right") : spot.side) : p.type === "valve" && p.vertical ? "right" : undefined;
    const ranked = first ? [first, ...order.filter((o) => o !== first)] : order;
    // A rule's place stays unless it runs out of the diagram or into something.
    labels.set(key, best(ranked.map((o) => cands[o]), `label '${label}'`, p.type === "tank" ? owns.get(p) : undefined).v);
  }
  return { labels, lines, crowded };
}
