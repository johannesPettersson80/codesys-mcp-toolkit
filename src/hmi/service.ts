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
import { currentCodesysSim } from "../codesys/simulation.js";
import type { AppContext } from "../tools.js";
import { CANVAS } from "./render.js";
import { screenSchema, screenVariables, type Screen } from "./spec.js";

export type Values = Record<string, string | undefined>;

interface HmiFile {
  version: 1;
  screens: Screen[];
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

  constructor(private ctx: AppContext) {}

  file(): string | undefined {
    const p = this.ctx.project?.path;
    if (!p) return undefined;
    return join(dirname(p), `${basename(p, extname(p))}.hmi.json`);
  }

  screens(): Screen[] {
    const f = this.file();
    if (!f || !existsSync(f)) return [];
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as HmiFile;
      return (raw.screens ?? []).flatMap((s) => {
        const r = screenSchema.safeParse(s);
        return r.success ? [r.data] : [];
      });
    } catch {
      return [];
    }
  }

  screen(name?: string): Screen | undefined {
    const all = this.screens();
    return name ? all.find((s) => s.name.toLowerCase() === name.toLowerCase()) : all[0];
  }

  save(screen: Screen): { file: string; replaced: boolean } {
    const f = this.file();
    if (!f) throw new Error("No project is open. Open or create a project first; screens are stored next to it.");
    const all = this.screens();
    const i = all.findIndex((s) => s.name.toLowerCase() === screen.name.toLowerCase());
    if (i >= 0) all[i] = screen;
    else all.push(screen);
    writeFileSync(f, `${JSON.stringify({ version: 1, screens: all } satisfies HmiFile, null, 2)}\n`, "utf8");
    return { file: f, replaced: i >= 0 };
  }

  remove(name: string): boolean {
    const f = this.file();
    if (!f) return false;
    const all = this.screens();
    const left = all.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
    if (left.length === all.length) return false;
    writeFileSync(f, `${JSON.stringify({ version: 1, screens: left } satisfies HmiFile, null, 2)}\n`, "utf8");
    return true;
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
    const names = screenVariables(screen);
    if (!names.length) return { values: {}, errors: {} };
    const p = this.ctx.bridge.call<{ values: Values; errors?: Record<string, string> }>("sim.read", { names }, { timeoutMs: 5_000 });
    this.reading = p;
    try {
      const r = await p;
      const out = { at: Date.now(), values: r.values ?? {}, errors: r.errors ?? {} };
      this.cache.set(screen.name, out);
      return out;
    } finally {
      this.reading = undefined;
    }
  }

  /** A write from the HMI page: only into CODESYS's own simulation. */
  async write(variable: string, value: string): Promise<string> {
    if (!currentCodesysSim(this.ctx)) throw new Error("The simulation isn't running: start it to operate the screen.");
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
export function staticPage(screen: Screen, values: Values, sim: { state?: string }, script: string): string {
  const data = JSON.stringify({ screen, values, sim }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${screen.title.replace(/[<&]/g, "")}</title>
<style>html,body{margin:0;background:#05080f}body{width:${CANVAS.w}px;height:${CANVAS.h}px;overflow:hidden}</style></head>
<body data-page="static"><div id="stage"></div><script>window.HMI_STATIC=${data};</script><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
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
export async function screenshot(html: string, browser = findBrowser()): Promise<Buffer> {
  if (!browser) throw new Error("No Edge or Chrome found for screenshots.");
  const dir = mkdtempSync(join(tmpdir(), "cmcp-hmi-"));
  try {
    const page = join(dir, "screen.html");
    const png = join(dir, "screen.png");
    writeFileSync(page, html, "utf8");
    await new Promise<void>((resolve, reject) => {
      execFile(
        browser,
        ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(dir, "profile")}`, `--window-size=${CANVAS.w},${CANVAS.h}`, "--virtual-time-budget=4000", `--screenshot=${png}`, `file:///${page.replace(/\\/g, "/")}`],
        { timeout: 60_000, windowsHide: true },
        (err) => (existsSync(png) ? resolve() : reject(err ?? new Error("the browser wrote no screenshot"))),
      );
    });
    return readFileSync(png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
