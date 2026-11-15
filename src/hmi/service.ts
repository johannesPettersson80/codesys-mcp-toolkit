/**
 * HMI screens of the open project: stored next to it as <project>.hmi.json, read
 * live from CODESYS's simulation for the HMI page, and rendered to PNG through
 * a headless Edge or Chrome for the model to look at.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory } from "../codesys/alarm-history.js";
import { alarmPath, alarmState, STATE_TEXT } from "../codesys/alarm-tools.js";
import { currentCodesysSim } from "../codesys/simulation.js";

/** The alarm group hmi_export_codesys puts the HMI's alarms in. */
export const HMI_ALARM_GROUP = "AG_HMI";
import type { AppContext } from "../tools.js";
import { canvasOf, HMI_CSS, symbolMarkup, type PageContext } from "./render.js";
import { allAlarms, screenSchema, screenVariables, type Screen } from "./spec.js";
import { BUILTIN_SYMBOLS, svgProblems, symbolPorts, symbolSchema, type SymbolDef, type SymbolLib } from "./symbols.js";

export type Values = Record<string, string | undefined>;

interface HmiFile {
  version: 1;
  screens: Screen[];
  /** The project's own symbols (hmi_save_symbol). */
  symbols?: SymbolLib;
  /** Translations per language code: original text -> translated text (hmi_translate). */
  translations?: Record<string, Record<string, string>>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** The built browser script (dist/panel/hmi.js): renderer + live client. */
export function hmiScript(): string | undefined {
  for (const p of [join(HERE, "..", "panel", "hmi.js"), join(HERE, "..", "..", "dist", "panel", "hmi.js")]) if (existsSync(p)) return readFileSync(p, "utf8");
  return undefined;
}

export class HmiService {
  private cache = new Map<string, { at: number; values: Values; errors: Record<string, string> }>();
  private reading?: Promise<unknown>;
  private history?: { at: number; json: string };

  constructor(private ctx: AppContext) {}

  file(): string | undefined {
    const p = this.ctx.project?.path;
    if (!p) return undefined;
    return join(dirname(p), `${basename(p, extname(p))}.hmi.json`);
  }

  private read(): HmiFile {
    const f = this.file();
    if (!f || !existsSync(f)) return { version: 1, screens: [] };
    try {
      return JSON.parse(readFileSync(f, "utf8")) as HmiFile;
    } catch {
      return { version: 1, screens: [] };
    }
  }

  private store(data: HmiFile): string {
    const f = this.file();
    if (!f) throw new Error("No project is open. Open or create a project first; screens are stored next to it.");
    const out: HmiFile = {
      version: 1,
      screens: data.screens,
      ...(data.symbols && Object.keys(data.symbols).length ? { symbols: data.symbols } : {}),
      ...(data.translations && Object.keys(data.translations).length ? { translations: data.translations } : {}),
    };
    writeFileSync(f, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    return f;
  }

  screens(): Screen[] {
    return (this.read().screens ?? []).flatMap((s) => {
      const r = screenSchema.safeParse(s);
      return r.success ? [r.data] : [];
    });
  }

  /** The project's own symbols (only those that still pass the checks). */
  symbols(): SymbolLib {
    const out: SymbolLib = {};
    for (const [name, raw] of Object.entries(this.read().symbols ?? {})) {
      const r = symbolSchema.safeParse(raw);
      if (r.success && !svgProblems(r.data.svg).length) out[name] = r.data;
    }
    return out;
  }

  /** Standard and project symbols together. */
  library(): SymbolLib {
    return { ...BUILTIN_SYMBOLS, ...this.symbols() };
  }

  saveSymbol(name: string, def: SymbolDef): { file: string; replaced: boolean } {
    const data = this.read();
    const symbols = { ...(data.symbols ?? {}) };
    const replaced = name in symbols;
    symbols[name] = def;
    return { file: this.store({ ...data, screens: data.screens ?? [], symbols }), replaced };
  }

  translations(): Record<string, Record<string, string>> {
    return this.read().translations ?? {};
  }

  /** Adds (or with replace, sets) one language's translations; returns how many it holds now. */
  setTranslations(language: string, texts: Record<string, string>, replace = false): number {
    const data = this.read();
    const all = { ...(data.translations ?? {}) };
    all[language] = { ...(replace ? {} : all[language] ?? {}), ...texts };
    for (const k of Object.keys(all[language]!)) if (!all[language]![k]) delete all[language]![k];
    if (!Object.keys(all[language]!).length) delete all[language];
    this.store({ ...data, screens: data.screens ?? [], translations: all });
    return Object.keys(all[language] ?? {}).length;
  }

  removeSymbol(name: string): boolean {
    const data = this.read();
    if (!data.symbols || !(name in data.symbols)) return false;
    const { [name]: _gone, ...rest } = data.symbols;
    this.store({ ...data, screens: data.screens ?? [], symbols: rest });
    return true;
  }

  screen(name?: string): Screen | undefined {
    const all = this.screens();
    return name ? all.find((s) => s.name.toLowerCase() === name.toLowerCase()) : all[0];
  }

  save(screen: Screen): { file: string; replaced: boolean } {
    const data = this.read();
    const all = this.screens();
    const i = all.findIndex((s) => s.name.toLowerCase() === screen.name.toLowerCase());
    if (i >= 0) all[i] = screen;
    else all.push(screen);
    return { file: this.store({ ...data, screens: all }), replaced: i >= 0 };
  }

  remove(name: string): boolean {
    if (!this.file()) return false;
    const data = this.read();
    const all = this.screens();
    const left = all.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
    if (left.length === all.length) return false;
    this.store({ ...data, screens: left });
    return true;
  }

  /** What every page shows besides its tiles: the page list, the HMI's alarms and the project's symbols. */
  page(): PageContext {
    const all = this.screens();
    const symbols = this.symbols();
    const translations = this.translations();
    return {
      pages: all.map((x) => ({ name: x.name, title: x.title, ...(x.icon ? { icon: x.icon } : {}) })),
      alarms: allAlarms(all),
      ...(Object.keys(symbols).length ? { symbols } : {}),
      ...(Object.keys(translations).length ? { languages: Object.keys(translations) } : {}),
    };
  }

  sim(): { state?: string } {
    const s = currentCodesysSim(this.ctx);
    return s ? { state: s.state } : {};
  }

  /** The screen's variables from the running simulation (at most every 200 ms; nothing when none runs). */
  async values(screen: Screen): Promise<{ values: Values; errors: Record<string, string> }> {
    if (!currentCodesysSim(this.ctx)) return { values: {}, errors: {} };
    const hit = this.cache.get(screen.name);
    if (hit && Date.now() - hit.at < 200) return hit;
    if (this.reading) await this.reading.catch(() => undefined);
    const alarms = allAlarms(this.screens());
    // After hmi_export_codesys these are CODESYS alarms (group AG_HMI, in this order): read their state too.
    const statePaths = alarms.map((_, k) => `${alarmPath(HMI_ALARM_GROUP, k)}.m_eState`);
    const names = [...new Set([...screenVariables(screen), ...alarms.map((x) => x.active), ...statePaths])];
    if (!names.length) return { values: {}, errors: {} };
    const p = this.ctx.bridge.call<{ values: Values; errors?: Record<string, string> }>("sim.read", { names }, { timeoutMs: 5_000 });
    this.reading = p;
    try {
      const r = await p;
      const values: Values = { ...(r.values ?? {}) };
      const errors = { ...(r.errors ?? {}) };
      alarms.forEach((a, k) => {
        const raw = values[statePaths[k]!];
        delete values[statePaths[k]!];
        delete errors[statePaths[k]!];
        if (raw !== undefined) values[`@alarm:${a.active}`] = alarmState(raw);
      });
      // The PLC's alarm history (after hmi_export_codesys), for alarms widgets with history: once a second.
      const histN = Math.max(0, ...screen.widgets.map((w) => (w.type === "alarms" ? (w.history ?? 0) : 0)));
      if (histN) {
        if (!this.history || Date.now() - this.history.at > 1000) {
          try {
            const h = await readHistory(this.ctx, histN);
            const text = (g: string, id: string) => (g === HMI_ALARM_GROUP ? alarms[Number(id) - 1]?.text : undefined) ?? `${g}/${id}`;
            this.history = { at: Date.now(), json: JSON.stringify(h.events.map((e) => ({ t: e.time.slice(11), x: text(e.group, e.alarm), s: STATE_TEXT[e.state], st: e.state }))) };
          } catch {
            this.history = { at: Date.now(), json: "[]" };
          }
        }
        values["@history"] = this.history.json;
      }
      const out = { at: Date.now(), values, errors };
      this.cache.set(screen.name, out);
      return out;
    } finally {
      this.reading = undefined;
    }
  }

  /** A write from the HMI page: only into CODESYS's own simulation. */
  async write(variable: string, value: string): Promise<string> {
    if (!currentCodesysSim(this.ctx)) throw new Error("The simulation isn't running: start it to operate the screen.");
    if (variable.startsWith("@ack:")) {
      // Acknowledge an HMI alarm in CODESYS's alarm manager (the HMI must have been exported).
      const k = allAlarms(this.screens()).findIndex((a) => a.active === variable.slice(5));
      if (k < 0) throw new Error(`${variable.slice(5)} is not an alarm on any HMI screen.`);
      await this.ctx.bridge.call("sim.write", { values: { [`${alarmPath(HMI_ALARM_GROUP, k)}.m_xToAcknowledge`]: "TRUE" } }, { timeoutMs: 5_000 });
      this.cache.clear();
      return `acknowledged ${variable.slice(5)}`;
    }
    const known = this.screens().some((s) => screenVariables(s).includes(variable));
    if (!known) throw new Error(`${variable} is not on any HMI screen.`);
    await this.ctx.bridge.call("sim.write", { values: { [variable]: value } }, { timeoutMs: 5_000 });
    this.cache.clear();
    return `${variable} := ${value}`;
  }
}

/** Example values for a screen without a simulation: mid-range numbers, alternate BOOLs. */
export function previewValues(screen: Screen): Values {
  const out: Values = {};
  screenVariables(screen).forEach((v, i) => {
    out[v] = /^[xb]|run|on|open|active|fault|alarm|start|stop/i.test(v.split(".").pop() ?? "") ? (i % 3 === 2 ? "FALSE" : "TRUE") : String(35 + ((i * 17) % 50));
  });
  for (const w of screen.widgets) if (w.type === "alarms") w.items.forEach((a, i) => (out[a.active] = i === 0 ? "TRUE" : "FALSE"));
  return out;
}

/** A self-contained page that shows one screen with fixed values (for screenshots). */
export function staticPage(screen: Screen, values: Values, sim: { state?: string }, script: string, page: PageContext = {}): string {
  const data = JSON.stringify({ screen, values, sim, page }).replace(/</g, "\\u003c");
  const cv = canvasOf(screen);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${screen.title.replace(/[<&]/g, "")}</title>
<style>html,body{margin:0;background:#05080f}body{width:${cv.w}px;height:${cv.h}px;overflow:hidden}</style></head>
<body data-page="static"><div id="stage"></div><script>window.HMI_STATIC=${data};</script><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}

/**
 * A picture of symbols for the model: each in its off, on and fault colours,
 * with its ports marked and named. Returns the page and its pixel size.
 */
export function symbolSheet(entries: [string, SymbolDef][], theme: "dark" | "light" = "dark"): { html: string; size: { w: number; h: number } } {
  const rowH = 128;
  const W = 920;
  const rows = entries.map(([name, d], k) => {
    const fit = Math.min(64, (40 * d.viewBox[0]) / d.viewBox[1]);
    const cell = (cls: string, ports: boolean) => {
      const marks = ports
        ? Object.entries(symbolPorts(d, { x: 0, y: 0, size: fit }, 1))
            .map(([pn, p]) => `<circle cx="${p.at[0]}" cy="${p.at[1]}" r="1.6" fill="#f472b6"/><text x="${p.at[0]}" y="${p.at[1] - 2.6}" class="pn">${pn}</text>`)
            .join("")
        : "";
      return `<svg width="190" height="114" viewBox="-40 -24 80 48"><g class="${cls}">${symbolMarkup(name, d, fit)}</g>${marks}</svg>`;
    };
    return `<div class="row" style="top:${44 + k * rowH}px"><div class="nm">${name.replace(/[<&]/g, "")}<div class="ds">${(d.description ?? "").replace(/[<&]/g, "")}</div><div class="ds">ports: ${Object.keys(d.ports).join(", ") || "none"}</div></div>${cell("sym", true)}${cell("sym on", false)}<span class="fault">${cell("sym", false)}</span></div>`;
  });
  const h = 44 + entries.length * rowH + 10;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${HMI_CSS}
html,body{margin:0}body{width:${W}px;height:${h}px;overflow:hidden}
.sheet{position:relative;width:${W}px;height:${h}px;border-radius:0}
.hd{position:absolute;top:12px;left:250px;display:flex;gap:0;color:var(--muted);font:600 12px "Segoe UI";letter-spacing:.08em;text-transform:uppercase}.hd span{width:198px;text-align:center}
.row{position:absolute;left:12px;right:12px;height:${rowH - 8}px;display:flex;align-items:center;gap:8px;border-radius:12px;background:var(--tile);border:1px solid var(--tile-bd)}
.row svg{overflow:visible}.nm{width:228px;padding-left:14px;font:650 15px "Segoe UI";color:var(--fg)}.ds{font:400 11.5px "Segoe UI";color:var(--muted);margin-top:4px}
.pn{font:600 3.6px "Segoe UI";fill:#f472b6;text-anchor:middle}.sym,.sym *{animation:none!important}
</style></head><body><div class="hmi sheet theme-${theme}"><div class="hd"><span>off · ports</span><span>on</span><span>fault</span></div>${rows.join("")}</div></body></html>`;
  return { html, size: { w: W, h } };
}

/** Edge or Chrome on this machine, for headless screenshots. */
export function findBrowser(): string | undefined {
  const pf = [process.env["PROGRAMFILES(X86)"], process.env.PROGRAMFILES, process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const cands = [
    ...pf.map((d) => join(d, "Microsoft", "Edge", "Application", "msedge.exe")),
    ...pf.map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe")),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return cands.find((c) => existsSync(c));
}

/** Renders a page to PNG with a headless browser; returns the PNG bytes. */
export async function screenshot(html: string, browser = findBrowser(), size: { w: number; h: number } = { w: 1280, h: 720 }): Promise<Buffer> {
  if (!browser) throw new Error("No Edge or Chrome found for screenshots.");
  const dir = mkdtempSync(join(tmpdir(), "cmcp-hmi-"));
  try {
    const page = join(dir, "screen.html");
    const png = join(dir, "screen.png");
    writeFileSync(page, html, "utf8");
    // A headless browser now and then hangs at start: give each try 25 s, and try twice with a fresh profile.
    let last: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            browser,
            ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(dir, `profile${attempt}`)}`, `--window-size=${size.w},${size.h}`, "--virtual-time-budget=4000", `--screenshot=${png}`, `file:///${page.replace(/\\/g, "/")}`],
            { timeout: 25_000, windowsHide: true },
            (err) => (existsSync(png) ? resolve() : reject(err ?? new Error("the browser wrote no screenshot"))),
          );
        });
        return readFileSync(png);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new Error("the browser wrote no screenshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
