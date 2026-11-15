/**
 * An engineering P&ID sheet from an HMI process diagram: the same items, drawn as a drawing
 * (black on white, ISO 10628-2 symbols, ISA-5.1 instruments, nothing live) on an A3 sheet with
 * a frame, a legend of the symbols it uses and a title block. A standalone SVG. Pure.
 */
import { canvasOf, HMI_CSS, processDrawing, symbolMarkup, tileBox } from "./render.js";
import type { Screen, Widget } from "./spec.js";
import { findSymbol, INSTRUMENT_SYMBOLS, PICTOGRAMS, type SymbolDef, type SymbolLib } from "./symbols.js";
import { themeCss, themeFor } from "./theme.js";

/** A3 landscape at 96 dpi. */
export const PID_SIZE = { w: 1587, h: 1123 } as const;

export interface PidMeta {
  title?: string;
  subtitle?: string;
  drawing?: string;
  revision?: string;
  date?: string;
  sheet?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Names for the legend. */
const NAMES: Record<string, string> = {
  motor: "Motor",
  conveyor: "Conveyor",
  heat_exchanger: "Heat exchanger",
  plate_heat_exchanger: "Plate heat exchanger",
  mixer: "Agitator",
  filter: "Filter",
  compressor: "Compressor",
  cylinder: "Cylinder",
  separator: "Separator",
  check_valve: "Check valve",
  control_valve: "Control valve",
};
const nameOf = (key: string) => NAMES[key] ?? key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The drawing look: black lines on paper, nothing live (no values, state signs, levels or lamps); valves hollow (filled means normally closed). */
const PAPER = `
.pid{--fg:#000;--muted:#000;--text2:#000;--surface:#fff;--surface2:#fff;--line:#000;--pipe:#000;--equip:#fff;--equip-on:#fff;--equip-line:#000;--equip-line-on:#000;--liquid:#fff;--accent:#000;font-family:"Segoe UI",Arial,sans-serif}
.pid .tank-liq,.pid .tank-num,.pid .tank-ticks,.pid .rs,.pid .md,.pid .cb,.pid .p-val,.pid .sen-box,.pid .sen-num,.pid .sen-tag,.pid .plamp{display:none}
.pid .pipe-outer{stroke:#000;stroke-width:2px}.pid .pipe-inner,.pid .pipe-flow{display:none}.pid .signal{stroke:#000}
.pid .p-label,.pid .p-line,.pid .p-text{fill:#000;font-weight:600}.pid .line-arrow{fill:#000}.pid .junction{fill:#000}
.pid .inst-bubble{fill:#fff;stroke:#000}.pid .inst-fn,.pid .inst-no{fill:#000}.pid .inst-conn{stroke:#000}.pid .inst-tap{fill:#000}
.pid .valve-body{fill:#fff}.pid .sym.vlv{--state:#fff}.pid .junction{r:.7px}
.pid .frame{fill:none;stroke:#000;stroke-width:2}.pid .rule{stroke:#000;stroke-width:1}
.pid .lg{font-size:13px;fill:#000;dominant-baseline:middle}.pid .lh{font-size:12px;font-weight:700;letter-spacing:.08em;fill:#000}
.pid .tb-l{font-size:10px;font-weight:600;letter-spacing:.06em;fill:#333}.pid .tb-v{font-size:14px;fill:#000}.pid .tb-t{font-size:20px;font-weight:700;fill:#000}
`;

/** The process diagram to draw: the one titled `title`, else the screen's first. */
export function processOf(screen: Screen, title?: string): Extract<Widget, { type: "process" }> | undefined {
  const all = screen.widgets.filter((w): w is Extract<Widget, { type: "process" }> => w.type === "process");
  return title ? all.find((w) => w.title?.toLowerCase() === title.toLowerCase()) : all[0];
}

/** The legend's entries: each kind of item the diagram uses, once. */
export function legendEntries(w: Extract<Widget, { type: "process" }>, lib: SymbolLib): { key: string; def?: SymbolDef; name: string; kind: "symbol" | "instrument" | "line" | "signal" }[] {
  const out = new Map<string, { key: string; def?: SymbolDef; name: string; kind: "symbol" | "instrument" | "line" | "signal" }>();
  const add = (key: string, def: SymbolDef | undefined, name: string, kind: "symbol" | "instrument" | "line" | "signal" = "symbol") => out.has(key) || out.set(key, { key, def, name, kind });
  for (const p of w.items) {
    if (p.type === "tank") add("pic_tank", PICTOGRAMS.tank, "Vessel");
    else if (p.type === "pump") add("pic_pump", PICTOGRAMS.pump, "Centrifugal pump");
    else if (p.type === "fan") add("pic_fan", PICTOGRAMS.fan, "Fan");
    else if (p.type === "valve") add("pic_valve", PICTOGRAMS.valve, "Valve");
    else if (p.type === "symbol") {
      const f = findSymbol(lib, p.symbol);
      if (!f) continue;
      if (INSTRUMENT_SYMBOLS[f[0]]) add("instrument", undefined, "Instrument (ISA-5.1)", "instrument");
      else add(f[0], f[1], nameOf(f[0]));
    } else if (p.type === "instrument" || (p.type === "sensor" && /^[A-Z]{1,5}-?\d{1,5}[A-Z]?$/.test(p.label ?? ""))) add("instrument", undefined, "Instrument (ISA-5.1)", "instrument");
    else if (p.type === "pipe") (p.signal ? add("signal", undefined, "Signal line", "signal") : add("line", undefined, "Process line", "line"));
  }
  // Equipment first, then instruments and lines.
  const order = { symbol: 0, instrument: 1, line: 2, signal: 3 };
  return [...out.values()].sort((a, b) => order[a.kind] - order[b.kind]);
}

/** The P&ID sheet as a standalone SVG. */
export function pidSheet(screen: Screen, w: Extract<Widget, { type: "process" }>, lib: SymbolLib, meta: PidMeta = {}): { svg: string; symbols: string[] } {
  const { w: W, h: H } = PID_SIZE;
  const M = 20, LEG = 250, TBW = 760, TBH = 150;
  // The drawing area: left of the legend, above the title block.
  const dx = M + 20, dy = M + 20, dw = W - 2 * M - LEG - 40, dh = H - 2 * M - TBH - 40;
  // The diagram at its card's own proportions (positions follow the card's height, sizes its width: another shape would pull a motor off its machine), scaled into the area.
  const card = tileBox(screen, w.at, true), k = canvasOf(screen, true).k;
  const head = w.title || w.icon ? 30 * k : 0;
  const drawing = processDrawing(w, card.w - 32 * k, card.h - 28 * k - head, lib).replace('<svg class="proc"', `<svg class="proc" x="${dx}" y="${dy}" width="${dw}" height="${dh}"`);
  // The legend.
  const entries = legendEntries(w, lib);
  const lx = W - M - LEG;
  const legend = entries
    .map((e, i) => {
      const y = dy + 44 + i * 42, cx = lx + 34;
      const pic =
        e.kind === "symbol" && e.def
          ? `<g transform="translate(${cx} ${y})" style="--state:#fff;--line:#000;--body:#fff">${symbolMarkup(e.key, e.def, Math.min(32, (32 * e.def.viewBox[0]) / e.def.viewBox[1]))}</g>`
          : e.kind === "instrument"
            ? `<circle cx="${cx}" cy="${y}" r="14" fill="#fff" stroke="#000" stroke-width="1.5"/><text x="${cx}" y="${y - 1}" style="font-size:10px;font-weight:700;text-anchor:middle">TT</text><text x="${cx}" y="${y + 9}" style="font-size:8px;text-anchor:middle">101</text>`
            : `<path d="M${cx - 18} ${y}H${cx + 18}" stroke="#000" stroke-width="${e.kind === "line" ? 2 : 1.4}"${e.kind === "signal" ? ' stroke-dasharray="5 4"' : ""}/>`;
      return `${pic}<text class="lg" x="${lx + 64}" y="${y}">${esc(e.name)}</text>`;
    })
    .join("");
  // The title block: three columns, three rows.
  const tx = W - M - TBW, ty = H - M - TBH, cw = [TBW * 0.44, TBW * 0.28, TBW * 0.28], rh = TBH / 3;
  const cell = (c: number, r: number, label: string, value: string, rows = 1) => {
    const x = tx + cw.slice(0, c).reduce((a, b) => a + b, 0);
    const y = ty + r * rh;
    return `<rect x="${x}" y="${y}" width="${cw[c]}" height="${rh * rows}" fill="none" stroke="#000"/><text class="tb-l" x="${x + 10}" y="${y + 16}">${esc(label)}</text><text class="${rows > 1 ? "tb-t" : "tb-v"}" x="${x + 10}" y="${y + (rows > 1 ? 44 : 36)}">${esc(value)}</text>`;
  };
  const title = meta.title ?? screen.title;
  const sub = meta.subtitle ?? screen.subtitle ?? "";
  const block = [
    cell(0, 0, "TITLE", title, 2),
    sub ? `<text class="tb-v" x="${tx + 10}" y="${ty + 70}">${esc(sub)}</text>` : "",
    cell(1, 0, "DRAWING NO.", meta.drawing ?? "–"),
    cell(2, 0, "REV.", meta.revision ?? "A"),
    cell(1, 1, "SCALE", "none"),
    cell(2, 1, "SHEET", meta.sheet ?? "1 of 1"),
    cell(0, 2, "STANDARD", "ISO 10628-2 · ISA-5.1"),
    cell(1, 2, "DATE", meta.date ?? new Date().toISOString().slice(0, 10)),
    cell(2, 2, "GENERATED FROM", `HMI screen '${screen.name}'`),
  ].join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" class="pid" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="${themeCss(themeFor({ theme: "light" }))}">
<style>${HMI_CSS}${PAPER}</style>
<rect width="${W}" height="${H}" fill="#fff"/>
<rect class="frame" x="${M}" y="${M}" width="${W - 2 * M}" height="${H - 2 * M}"/>
${drawing}
<path class="rule" d="M${lx} ${M + 20}V${ty - 20}"/>
<text class="lh" x="${lx + 20}" y="${dy + 12}">LEGEND</text>
${legend}
${block}
</svg>`;
  return { svg, symbols: entries.map((e) => e.name) };
}
