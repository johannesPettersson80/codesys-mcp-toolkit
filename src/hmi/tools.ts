/**
 * The model's HMI actions: design screens, look at them, open the live page.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import { reportProgress } from "../progress.js";
import { currentCodesysSim } from "../codesys/simulation.js";
import { HISTORY, historyCode, installHistory } from "../codesys/alarm-history.js";
import { listAlarms } from "../codesys/alarm-tools.js";
import type { AppContext } from "../tools.js";
import { findBrowser, hmiScript, previewValues, printPdf, screenshot, staticPage, symbolSheet, type HmiService } from "./service.js";
import { PID_SIZE, pidSheet, processOf } from "./pid.js";
import { BUILTIN_SYMBOLS, importSvg, svgProblems, symbolSchema, type SymbolDef } from "./symbols.js";
import { nativePlan } from "./native.js";
import { canvasOf, tileBox } from "./render.js";
import { textWarnings } from "./labels.js";
import { connectionWarnings, overlapWarnings } from "./route.js";
import { TEMPLATES } from "./templates.js";
import { allAlarms, layoutProblems, screenSchema, screenTexts, screenVariables, translateScreen } from "./spec.js";

const text = (t: string, isError = false): ActionResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

/** What to do when the library repository lacks FloatingPointUtils (seen on a CODESYS SP22 install). */
export const missingFpu = (): string =>
  "This CODESYS's library repository has no FloatingPointUtils, which CODESYS's visualization libraries need, so a visualization can't compile here. Install it into this CODESYS (with the CODESYS Installer, or in Tools > Library Repository > Install), then run hmi_export_codesys again. The browser HMI (open_hmi) works without it.";

const GUIDE = `A screen is a ${"12x8"} grid of tiles (change with grid). Each widget has at: [column, row, width, height], 1-based, no overlaps.
The machine (screen machine, the same on every page): its state small in the top bar's left corner (an icon in a ring and the text, detail: a STRING under it such as 'error-free for 2 h 23 min', and a thin line in the state's colour under the bar), and Start, Stop, Reset and the mode in a bar along the bottom: {states: [{on, text, tone}] most important first (Fault alarm, Manual accent, Production ok, Ready warn), idle: {text: 'Stopped', tone: 'neutral'}, detail, start, stop, reset, mode: {variable, options: ['Manual', 'Auto']}}. Never show the machine's state as a big coloured card.
Widgets: state (a unit's state on a card: icon in a ring, a thin line in the state's colour on top, optional Start/Stop/Reset), mode (segmented switch, e.g. options ['Manual', 'Auto'] on a BOOL), value (big number in the accent and its unit; min/max add a thin scale, set shows Actual and Set side by side and a set-point marker; trend: true a sparkline), gauge (half circle), bar (with an optional set marker), status (lamps), buttons (tap/toggle/set/reset; Start in the accent, Stop dark, the rest outlined, with icons; tone only for a real state colour), switch, setpoint (set value with - and +; actual: the measured value large beside it), trend (up to 6 series), alarms, text, line: the process as station tiles on a product path for an overview, {type: 'line', stations: [{name: 'Pump', tag: 'P-201', symbol: 'pump', on: 'PLC_PRG.xRun', fault: '...', warning: '...', manual: '...', value: 'PLC_PRG.rFlow', unit: 'm³/h', screen: 'Process', feed: {name: 'Steam', symbol: 'control_valve', on: '...'}}, ...]} (2-12 stations left to right; each tile shows its pictogram (tank, pump, valve, fan or any symbol), key value and state signs, and a tap opens its page), and process: a mimic diagram whose items sit in a 0..100 x 0..100 box (x across, y down): tank, pump, fan, valve, junction, pipe, sensor, lamp, label, and symbol: {type: 'symbol', symbol: 'motor', x, y, size, label: 'M-201', on: 'PLC_PRG.xRun', fault: '...', warning: '...', manual: '...', rotate: 90} for the standard symbols (motor, conveyor, heat_exchanger, mixer, filter, compressor, cylinder, level_switch, pressure_switch, check_valve, control_valve) and the project's own (hmi_save_symbol). hmi_symbols shows them all with their ports.
Connect pipes to ports, never by guessing points: {type: 'pipe', from: 'T-101.right', to: 'P-101.in', flow: 'PLC_PRG.xRun'}. The toolkit routes it with right angles and it meets the symbols exactly. A symbol's name is its id, or its label. Ports: tank top, bottom, left, right, left-high, right-high; pump and fan in (left), out (right), top, bottom; valve in, out (left/right, or bottom/top when vertical: true); junction c (for tees). A pipe end can also be a point [x, y] at the diagram's edge. via: [[x, y]] makes it pass points. For straight runs give connected symbols the same y (or x); a valve on a vertical pipe is vertical: true.
Variables are full instance paths: 'PLC_PRG.fbPump.xRunning', 'GVL.rLevel'. bands colour a value by range: [{from: 0, tone: 'accent'}, {from: 90, tone: 'alarm'}]. Tones: accent, ok, warn, alarm, neutral.
Look: a calm, flat design system shared by the browser and CODESYS: colour means state (running, warning, alarm, manual) or what the operator can act on, never decoration. theme 'light' (default), 'dark' or 'contrast' (black and white, strong colours: bright light, poor eyesight), the same on every page; accent: '#e30613' puts the company colour on the current page, set-points and primary buttons (text on it turns black or white to stay readable). Every card can have an icon before its title (icon: 'temperature', 'pressure', 'flow', 'level', 'speed', 'power', 'energy', 'time', 'count', 'pump', 'valve', 'heater', 'tank', 'machine', 'alarm', 'info', 'settings', 'recipe', 'trend', ...); titles in sentence case (cards show them in small capitals). The top bar shows the screen's title and info: up to 4 fields such as {label: 'Order', text: '4711'} or {label: 'Produced', value: 'PLC_PRG.rLitres', unit: 'l'}. With more than one page a navigation rail on the left links them, each with the page's icon (screen icon: 'home', 'process', 'trend', 'alarm', 'recipe', 'settings'). Equipment state is three separate things, each with its own sign (never a coloured or grey-filled symbol, never words): the run state before the name (▶ running, ■ stopped; driven equipment: running on pumps and fans, on on symbols and stations), a valve's position as its fill (closed filled, open hollow, as on a P&ID), the mode after the name (manual: a hand in Manual, nothing in Auto) and the condition at the symbol's corner (warning: an amber triangle, fault: a red alarm circle, which wins; nothing when OK). A switch is an instrument with on (TRUE when tripped: xPressureLow, not xPressureOk): its bubble stays white and gets the same badge, red with tone: 'alarm', else amber. Station tiles use the same signs and turn their top edge amber or red for a warning or alarm. A value that belongs to the equipment (a control valve's opening, a pump's speed) goes on it as value/unit/decimals, shown under its name, not as a separate sensor. Pipes with flow turn darker; nothing moves.
access: {min: 'Maintenance'} on a tile lets only that group and up operate it in CODESYS (after Login; lower groups and nobody logged in see it greyed out, or not at all with below: 'hide'). Groups: Operator, Maintenance, Admin.
Make the diagram a process: every piece of equipment on a pipe (in and out), tanks fed and emptied, a heat exchanger with both circuits (product in/out, heating medium top/bottom), instruments on the line or vessel they measure ({type: 'instrument', tag: 'PSL-201', at: 'J1.c'} on a junction in the line), a motor's shaft against the machine it drives, line ends at the diagram's edge with a label (Feed, Steam, To filling); hmi_save_screen lists what doesn't fit.
For documentation, hmi_pid exports a screen's process diagram as an engineering P&ID sheet (PDF, SVG or PNG).
Good screens: the machine's state and commands in the frame (machine), an overview with the line of stations across the top and key values (with their scale and set-point) in a row of equal cards, alarms and status below; the process diagram large on its own page; titles short; tag names on symbols (P-101, T-101).`;

export function registerHmiActions(reg: RegisterAction, ctx: AppContext, hmi: HmiService, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  reg(
    "hmi_save_screen",
    {
      description: `Create or replace an HMI screen for the open project (stored next to it as <project>.hmi.json). It shows live in the browser page (open_hmi) and the panel while CODESYS's simulation runs, and buttons, switches and setpoints write to the simulation. After saving, call hmi_screenshot to look at it and fix what looks off.\n${GUIDE}`,
      inputSchema: z.object({ screen: screenSchema }),
    },
    async ({ screen }) => {
      if (!ctx.project) return text("No project is open: open or create one first; screens are stored next to it.", true);
      const lib = hmi.library();
      const problems = layoutProblems(screen, lib);
      if (problems.length) return text(`Not saved: fix the layout first.\n- ${problems.join("\n- ")}`, true);
      const vars = screenVariables(screen);
      const roots = new Set(vars.map((v) => v.split(".")[0]!.toLowerCase()));
      const unknown = ctx.cache ? [...roots].filter((r) => !ctx.cache!.get(r) && !/^(gvl|io|hmi)/i.test(r)) : [];
      const r = hmi.save(screen);
      // The cards sit right of the navigation rail when the HMI has more than one page.
      const rail = hmi.screens().length > 1;
      const looks = screen.widgets.flatMap((w) => {
        if (w.type !== "process") return [];
        const b = tileBox(screen, w.at, rail);
        return [...overlapWarnings(w.items, (b.h - 46) / (b.w - 32), lib), ...textWarnings(w.items, (b.h - 46) / (b.w - 32), lib)];
      });
      const flow = screen.widgets.flatMap((w) => {
        if (w.type !== "process") return [];
        const b = tileBox(screen, w.at, rail);
        return connectionWarnings(w.items, (b.h - 46) / (b.w - 32), lib);
      });
      const warn0 = (looks.length ? `\nLayout: ${looks.join(" ")}` : "") + (flow.length ? `\nProcess (check these: a diagram should show how the product flows):\n- ${flow.join("\n- ")}` : "");
      const warn = warn0 + (unknown.length ? `\nCheck these: no object named ${unknown.map((u) => `'${u}'`).join(", ")} in the project (the first part of a variable path must be a program or GVL).` : "");
      return text(`${r.replaced ? "Replaced" : "Saved"} screen '${screen.name}' (${screen.widgets.length} widgets, ${vars.length} variables) in ${r.file}.${warn}\nCall hmi_screenshot to see it.`);
    },
  );

  reg(
    "hmi_screenshot",
    {
      description: "Render an HMI screen to an image you can look at, to check and polish the layout. Uses live values while the simulation runs; otherwise example values (pass values to choose them). Trends show made-up history in a screenshot.",
      inputSchema: z.object({
        screen: z.string().optional().describe("Screen name (default: the first)"),
        values: z.record(z.string(), z.string()).optional().describe("Values to show instead, e.g. { 'PLC_PRG.rLevel': '72.5', 'PLC_PRG.xRun': 'TRUE' }"),
        language: z.string().optional().describe("Show it translated (a language from hmi_translate)"),
      }),
    },
    async ({ screen: name, values, language }) => {
      const s0 = hmi.screen(name);
      const map = language ? hmi.translations()[language] : undefined;
      if (language && !map) return text(`No translations for '${language}'. Languages: ${Object.keys(hmi.translations()).join(", ") || "none"} (add one with hmi_translate).`, true);
      const s = s0 && map ? translateScreen(s0, map) : s0;
      if (!s) return text(name ? `No screen named '${name}'. Screens: ${hmi.screens().map((x) => x.name).join(", ") || "none"}.` : "This project has no HMI screens yet: create one with hmi_save_screen.", true);
      const script = hmiScript();
      if (!script) return text("The HMI page isn't built. Run npm run build.", true);
      if (!findBrowser()) return text("Screenshots need Microsoft Edge or Google Chrome, and neither was found.", true);
      let shown = values ?? {};
      let source = values ? "the values you passed" : "example values (the simulation isn't running)";
      if (!values && currentCodesysSim(ctx)) {
        try {
          shown = (await hmi.values(s)).values as Record<string, string>;
          source = "live values from the simulation";
        } catch {
          /* fall back to examples */
        }
      }
      if (!values && !Object.keys(shown).length) shown = previewValues(s) as Record<string, string>;
      try {
        const page = hmi.page();
        const shownPage = map ? { ...page, lang: language, pages: page.pages?.map((p) => ({ ...p, title: map[p.title] ?? p.title })) } : page;
        const png = await screenshot(staticPage(s, shown, hmi.sim(), script, shownPage), undefined, canvasOf(s));
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: `Screen '${s.name}' (${s.size}) with ${source}.` }] };
      } catch (e) {
        return text(`Screenshot failed: ${(e as Error).message}`, true);
      }
    },
  );

  reg(
    "hmi_pid",
    {
      description:
        "Export a screen's process diagram as an engineering P&ID drawing for documentation: the same diagram drawn black on white (ISO 10628-2 symbols, ISA-5.1 instruments, line names, nothing live) on an A3 sheet with a frame, a legend of the symbols it uses and a title block. Saved next to the project as <project>.<screen>.pid.pdf (or .svg, .png); a picture of it comes back to check.",
      inputSchema: z.object({
        screen: z.string().optional().describe("Screen name (default: the first)"),
        diagram: z.string().optional().describe("The process card's title, when the screen has more than one"),
        drawing: z.string().optional().describe("Drawing number for the title block, e.g. 'PID-200-01'"),
        revision: z.string().optional().describe("Revision, e.g. 'B' (default A)"),
        date: z.string().optional().describe("Date in the title block (default today)"),
        format: z.enum(["pdf", "svg", "png"]).default("pdf"),
      }),
    },
    async ({ screen: name, diagram, drawing, revision, date, format }) => {
      const s = hmi.screen(name);
      if (!s) return text(name ? `No screen named '${name}'. Screens: ${hmi.screens().map((x) => x.name).join(", ") || "none"}.` : "This project has no HMI screens yet: create one with hmi_save_screen.", true);
      const w = processOf(s, diagram);
      if (!w) return text(`Screen '${s.name}' has no process diagram${diagram ? ` titled '${diagram}'` : ""}.`, true);
      const file = hmi.file();
      if (!file) return text("Open a project first: the drawing is saved next to it.", true);
      const { svg, symbols } = pidSheet(s, w, hmi.library(), { drawing, revision, date });
      const base = file.replace(/\.hmi\.json$/, `.${s.name}.pid`);
      const page = (paper: boolean) => `<!doctype html><html><head><meta charset="utf-8"><style>${paper ? "@page{size:420mm 297mm;margin:0}svg{width:420mm;height:297mm}" : ""}html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`;
      const out = `${base}.${format}`;
      try {
        if (format === "svg") writeFileSync(out, svg, "utf8");
        else if (!findBrowser()) return text("PDF and PNG need Microsoft Edge or Google Chrome, and neither was found: use format 'svg'.", true);
        else writeFileSync(out, format === "pdf" ? await printPdf(page(true)) : await screenshot(page(false), undefined, PID_SIZE));
      } catch (e) {
        return text(`The P&ID export failed: ${(e as Error).message}`, true);
      }
      const note = `Saved the P&ID of '${s.name}' as ${out} (A3; legend: ${symbols.join(", ")}).`;
      if (!findBrowser()) return text(note);
      try {
        const png = await screenshot(page(false), undefined, PID_SIZE);
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: note }] };
      } catch {
        return text(note);
      }
    },
  );

  const sheet = async (entries: [string, SymbolDef][], note: string): Promise<ActionResult> => {
    if (!findBrowser()) return text(`${note}\n(No picture: screenshots need Microsoft Edge or Google Chrome.)`);
    try {
      const { html, size } = symbolSheet(entries);
      const png = await screenshot(html, undefined, size);
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: note }] };
    } catch (e) {
      return text(`${note}\n(No picture: ${(e as Error).message})`);
    }
  };

  reg(
    "hmi_save_symbol",
    {
      description: `Add your own process-diagram symbol to the project (or replace one), drawn as SVG or imported from an SVG file, and get back a picture of it with the ports marked: look at it and fix what's off. Then place it on a process diagram as {type: 'symbol', symbol: '<name>', ...}; it works in the browser HMI and in the CODESYS export.
Draw in the symbol's box (viewBox, default 100x100) with g, path, rect, circle, ellipse, line, polyline, polygon, text and gradients. Fill the body with var(--state) (the surface; a valve's body is filled while it is closed) and draw outlines with var(--line) (stroke-width 2 with vector-effect="non-scaling-stroke"); var(--body), var(--body2) and var(--accent) are there too, so one drawing serves every theme. Don't colour the symbol by state: running, manual, warnings and alarms are signs the HMI draws beside it. Nothing moves. Ports are where pipes connect: { in: { x: 0, y: 50, dir: 'left' } } in box coordinates; put them on the outline. Scripts, styles, links and external images are refused.`,
      inputSchema: z.object({
        name: z.string().regex(/^[a-z][a-z0-9_]*$/).describe("Lower case, e.g. 'centrifuge'"),
        svg: z.string().optional().describe("The markup inside the box (no outer <svg>)"),
        file: z.string().optional().describe("Or an .svg file to import (its viewBox and content; style attributes become plain attributes)"),
        viewBox: z.tuple([z.number().positive(), z.number().positive()]).optional().describe("Box width and height (default 100x100, or the file's)"),
        ports: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.object({ x: z.number(), y: z.number(), dir: z.enum(["left", "right", "up", "down"]) })).optional(),
        description: z.string().max(200).optional(),
      }),
    },
    async ({ name, svg, file, viewBox, ports, description }) => {
      if (!ctx.project) return text("No project is open: open or create one first; symbols are stored next to it.", true);
      if (!svg === !file) return text("Give either svg (the markup) or file (an .svg file to import).", true);
      if (name in BUILTIN_SYMBOLS) return text(`'${name}' is a standard symbol; pick another name.`, true);
      let markup = svg ?? "";
      let box = viewBox;
      if (file) {
        try {
          const imported = importSvg(readFileSync(resolve(ctx.workspace, file), "utf8"));
          markup = imported.svg;
          box ??= imported.viewBox;
        } catch (e) {
          return text(`Couldn't import ${file}: ${(e as Error).message}`, true);
        }
      }
      const problems = svgProblems(markup);
      if (problems.length) return text(`Not saved: the symbol's SVG needs changes.\n- ${problems.join("\n- ")}`, true);
      const def = symbolSchema.parse({ svg: markup, ...(box ? { viewBox: box } : {}), ...(ports ? { ports } : {}), ...(description ? { description } : {}) });
      const [vw, vh] = def.viewBox;
      const off = Object.entries(def.ports).filter(([, p]) => p.x < 0 || p.y < 0 || p.x > vw || p.y > vh).map(([k]) => k);
      const r = hmi.saveSymbol(name, def);
      return sheet([[name, def]], `${r.replaced ? "Replaced" : "Saved"} symbol '${name}' (${vw}x${vh}, ports: ${Object.keys(def.ports).join(", ") || "none"}) in ${r.file}.${off.length ? ` Ports outside the box: ${off.join(", ")}.` : ""} Use it as {type: 'symbol', symbol: '${name}', x, y, size}.`);
    },
  );

  reg(
    "hmi_translate",
    {
      description:
        "Translate the HMI into another language: texts maps each text as written on the screens (titles, labels, button captions, alarm messages) to its translation. Merges with what the language has (replace: true starts it over; an empty translation removes one). Returns the texts still untranslated. The browser HMI gets language buttons in its header; hmi_export_codesys puts the alarm messages' translations in CODESYS's alarm text list (the native pages stay in the base language for now). Call without texts to get the list to translate.",
      inputSchema: z.object({
        language: z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/).describe("Language code, e.g. 'de', 'sv', 'zh'"),
        texts: z.record(z.string(), z.string()).optional(),
        replace: z.boolean().optional(),
      }),
    },
    async ({ language, texts, replace }) => {
      if (!ctx.project) return text("No project is open: open or create one first.", true);
      const all = screenTexts(hmi.screens());
      if (!all.length) return text("This project has no HMI screens to translate.", true);
      const known = new Set(all);
      const unknown = Object.keys(texts ?? {}).filter((k) => !known.has(k));
      const n = texts ? hmi.setTranslations(language, texts, !!replace) : Object.keys(hmi.translations()[language] ?? {}).length;
      const map = hmi.translations()[language] ?? {};
      const missing = all.filter((t) => !map[t]);
      return text(
        [
          texts ? `Saved ${n} translation(s) for '${language}'.` : `'${language}' has ${n} translation(s).`,
          unknown.length ? `Not on any screen (kept anyway, check the spelling): ${unknown.slice(0, 10).map((u) => JSON.stringify(u)).join(", ")}` : "",
          missing.length ? `Still untranslated (${missing.length}): ${JSON.stringify(missing)}` : `Every text on the screens has a '${language}' translation. hmi_screenshot with language: '${language}' shows it.`,
        ].filter(Boolean).join("\n"),
      );
    },
  );

  reg(
    "hmi_symbols",
    {
      description: "The process-diagram symbols you can place ({type: 'symbol', symbol: '<name>'}): the standard ones and the project's own, as a picture with their ports (valves also open and closed), and as a list.",
      inputSchema: z.object({ names: z.array(z.string()).optional().describe("Only these (default: all)") }),
    },
    async ({ names }) => {
      const lib = hmi.library();
      const custom = hmi.symbols();
      const entries = Object.entries(lib).filter(([n]) => !names || names.some((x) => x.toLowerCase() === n.toLowerCase()));
      if (!entries.length) return text(`No such symbols. Symbols: ${Object.keys(lib).join(", ")}.`, true);
      const list = entries.map(([n, d]) => `${n}${n in custom ? " (project)" : ""}: ${d.description ?? ""} [${d.viewBox.join("x")}; ports: ${Object.entries(d.ports).map(([k, p]) => `${k} ${p.dir}`).join(", ") || "none"}]`);
      return sheet(entries, list.join("\n"));
    },
  );

  reg(
    "hmi_delete_symbol",
    { description: "Delete one of the project's own symbols (screens that use it then refuse to save until it's replaced).", inputSchema: z.object({ name: z.string() }) },
    async ({ name }) => (hmi.removeSymbol(name) ? text(`Deleted symbol '${name}'.`) : text(`The project has no symbol '${name}'. Its symbols: ${Object.keys(hmi.symbols()).join(", ") || "none"}.`, true)),
  );

  reg(
    "hmi_export_codesys",
    {
      description:
        "Build the HMI as native CODESYS visualizations in the project, one per page (Visu_<screen>), so it ships with the application: the same design as the browser HMI (top bar, navigation rail linking the pages, cards with icons, the machine state and its Start/Stop bar, mode switch, scales with set-point markers); the first page is the start page of TargetVisu and WebVisu at the panel size, pumps and fans turn while running (8-frame animation), and a symbol with a faceplate opens it as a dialog (Dlg_<screen>_<tag>). SVG icons and symbols in an embedded image pool, live values, bars and tank levels, colour states, buttons, switches, setpoints and alarm rows. A generated program PRG_HMI_<screen> per page scales values and turns the impellers; it runs in VISU_TASK. Returns a picture of the first page. Trends are shown as values. Rebuilds what exists.",
      inputSchema: z.object({ screen: z.string().optional().describe("One page only (default: every page)") }),
    },
    async ({ screen: name }) => {
      const all = hmi.screens();
      const targets = name ? [hmi.screen(name)].filter((x): x is NonNullable<typeof x> => !!x) : all;
      if (!targets.length) return text(name ? `No screen named '${name}'.` : "This project has no HMI screens yet: create one with hmi_save_screen.", true);
      const b = ctx.bridge;
      if (!(await b.waitReady(ctx.startWaitMs))) return text("CODESYS is still starting; try again shortly.", true);
      const pages = all.map((x) => ({ name: x.name, title: x.title, ...(x.icon ? { icon: x.icon } : {}) }));
      // Visualizations don't compile without FloatingPointUtils: say so before minutes of building.
      reportProgress("checking the library repository");
      const fpu = await b.call<{ matches: unknown[]; repositories: string[] }>("library.find", { name: "FloatingPointUtils" }).catch(() => undefined);
      if (fpu && fpu.matches.length === 0) return text(missingFpu(), true);
      const dir = mkdtempSync(join(tmpdir(), "cmcp-visu-"));
      try {
        const notes: string[] = [];
        const warnings: string[] = [];
        const builtNames: string[] = [];
        let first: { visu: string; w: number; h: number } | undefined;
        const translations = hmi.translations();
        // The pages' alarms as CODESYS alarms first (timestamps and acknowledge in the PLC):
        // the alarm rows then follow their states.
        const alarms = allAlarms(all);
        let alarmIndex: Record<string, number> | undefined;
        if (alarms.length) {
          reportProgress(`alarms: ${alarms.length} into CODESYS alarm management`);
          try {
            const cls = (sev: string) => (sev === "info" ? "Info" : sev === "warning" ? "Warning" : "Error");
            const r = await b.call<{ alarms: string[] }>("alarms.configure", { group: "AG_HMI", alarms: alarms.map((a, i) => ({ id: i + 1, kind: "digital", expression: a.active, comparison: "Equal", compare_to: "TRUE", text: a.text, cls: cls(a.severity) })), save: false }, { timeoutMs: 120_000 });
            notes.push(`${r.alarms.length} alarm(s) in CODESYS alarm management (Alarm Configuration / AG_HMI); the alarm rows show their state and time, with ACK.`);
            alarmIndex = Object.fromEntries(alarms.map((a, i) => [a.active, i]));
          } catch (e) {
            warnings.push(`alarms: ${(e as Error).message}`);
          }
          // The alarms' history in the PLC (CODESYS's runtime alarm forgets its times once normal).
          if (alarmIndex) {
            try {
              const code = historyCode(await listAlarms(ctx), 100);
              const task = await installHistory(ctx, code, false);
              notes.push(`Alarm history: ${HISTORY.program}${task ? ` in ${task}` : ""} records every state change (alarm_history shows it).`);
            } catch (e) {
              warnings.push(`alarm history: ${(e as Error).message}`);
            }
          }
        }
        // The first page is built last, so a CODESYS window ends up showing the start page.
        for (const [k, s] of [...targets].reverse().entries()) {
          reportProgress(`page ${k + 1}/${targets.length}: Visu_${s.name}`);
          const plan = nativePlan(s, pages, hmi.symbols(), alarmIndex, Object.keys(translations), alarms.map((a) => a.text), Object.fromEntries(alarms.map((a) => [a.active, a.severity])));
          const images = plan.images.map((img) => {
            const path = join(dir, `${img.id}.svg`);
            writeFileSync(path, img.svg, "utf8");
            return { id: img.id, path };
          });
          // The helper program first: the visualization refers to its variables.
          try {
            await b.call("object.write", { path: plan.helper.name, declaration: plan.helper.declaration, implementation: plan.helper.implementation });
          } catch {
            await b.call("object.create", { kind: "program", name: plan.helper.name, declaration: plan.helper.declaration, implementation: plan.helper.implementation });
          }
          for (const d of plan.dialogs) {
            const r = await b.call<{ warnings: string[] }>("visu.build", { name: d.name, replace: true, background: d.background, elements: d.elements, size: d.size, dialog: true, save: false }, { timeoutMs: 900_000 });
            warnings.push(...r.warnings.map((w) => `${d.name}: ${w}`));
            builtNames.push(d.name);
          }
          const built = await b.call<{ name: string; elements: number; warnings: string[] }>(
            "visu.build",
            { name: plan.visu, replace: true, background: plan.background, elements: plan.elements, image_pool: plan.imagePool, images, size: plan.size, save: ctx.autosave },
            { timeoutMs: 900_000 },
          );
          warnings.push(...built.warnings.map((w) => `${plan.visu}: ${w}`));
          builtNames.push(`${built.name} (${built.elements} elements)`);
          first = { visu: plan.visu, w: plan.size[0], h: plan.size[1] };
          for (const task of ["VISU_TASK", "MainTask"]) {
            try {
              await b.call("task.configure", { name: task, add_calls: [plan.helper.name], save: false });
              break;
            } catch {
              /* try the next task */
            }
          }
        }
        // Alarm message translations into the alarm group's text list (CODESYS's alarm tables and
        // storage use them). The pages themselves don't switch language natively yet.
        if (Object.keys(translations).length && alarmIndex) {
          reportProgress("alarm message translations");
          try {
            const r = await b.call<{ languages: string[]; rows: number; added: number; errors: string[] }>("textlists.translate", { translations, alarm_group: "AG_HMI", global: false, save: false }, { timeoutMs: 120_000 });
            notes.push(`Alarm messages translated into ${r.languages.join(", ")} in CODESYS's alarm text list (${r.rows}). The native pages show the base language; the browser HMI switches languages.`);
            warnings.push(...r.errors.map((e) => `translation ${e}`));
          } catch (e) {
            warnings.push(`translations: ${(e as Error).message}`);
          }
        }
        // User groups for the Login button; users and passwords are the engineer's to add.
        try {
          await b.call("visu.users", { groups: ["Operator", "Maintenance", "Admin"], save: false }, { timeoutMs: 120_000 });
          notes.push("User groups Operator, Maintenance and Admin; add users in the Visualization Manager (User Management) for the Login button.");
        } catch (e) {
          warnings.push(`user groups: ${(e as Error).message}`);
        }
        // Start on the first page; the clients use the panel size.
        const startPage = `Visu_${all[0]!.name}`;
        const cv = canvasOf(all[0]!);
        try {
          const m = await b.call<{ updated: string[]; warnings: string[] }>("visu.manager", { start: startPage, width: cv.w, height: cv.h, save: ctx.autosave });
          notes.push(`Start page ${startPage} at ${cv.w}x${cv.h} in ${m.updated.join(", ") || "no client"}.`);
          warnings.push(...m.warnings);
        } catch (e) {
          warnings.push(`visualization manager: ${(e as Error).message}`);
        }
        reportProgress("compiling");
        const build = await b.call<{ messages: { severity: string; text: string; object?: string }[] }>("build", {}, { timeoutMs: 900_000 });
        const errors = build.messages.filter((m) => /error/i.test(m.severity));
        if (errors.length) {
          const noFpu = errors.some((m) => /\bFPU\b|FloatingPointUtils/.test(m.text));
          notes.push(
            noFpu
              ? `The build has ${errors.length} errors. ${missingFpu()}`
              : `The build has ${errors.length} errors, for example: ${errors.slice(0, 3).map((m) => `${m.object ?? ""} ${m.text}`.trim()).join("; ")}`,
          );
        } else notes.push("Compiles with 0 errors. Start the simulation to see it live.");
        const plain = warnings.filter((w) => /drawn without VisuFbElem/.test(w));
        const other = warnings.filter((w) => !plain.includes(w));
        if (plain.length)
          notes.push(
            plain.some((w) => /CODESYS's window/.test(w))
              ? `${plain.length} meter(s), bar display(s) or alarm table(s) drawn with plain elements: CODESYS's own ones can only be made with its window open (start the toolkit with --show-window and export again).`
              : `${plain.length} meter(s), bar display(s) or alarm table(s) drawn with plain elements: ${plain[0]}`,
          );
        if (other.length) notes.push(`Not applied (${other.length}): ${other.slice(0, 6).join("; ")}`);
        const png = join(dir, "visu.png");
        let image: ActionResult["content"] = [];
        if (first) {
          try {
            await b.call("visu.render", { name: first.visu, path: png, width: first.w, height: first.h }, { timeoutMs: 60_000 });
            image = [{ type: "image", data: readFileSync(png).toString("base64"), mimeType: "image/png" }];
          } catch (e) {
            notes.push(`No picture: ${(e as Error).message}`);
          }
        }
        return { content: [...image, { type: "text", text: [`Built ${builtNames.join(", ")}.`, ...notes].join("\n") }] };
      } catch (e) {
        return text(`${(e as { code?: string }).code ? `${(e as { code: string }).code}: ` : ""}${(e as Error).message}`, true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  reg(
    "hmi_template",
    {
      description: `Page templates for a complete HMI: ${Object.entries(TEMPLATES).map(([k, t]) => `${k} (${t.use})`).join("; ")}. Returns the template's screen description: adapt titles and replace the 'PRG.' variables with the program's, then save it with hmi_save_screen. Pages of one HMI share the header, which links to every page and counts the alarms of all pages.`,
      inputSchema: z.object({ kind: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]) }),
    },
    async ({ kind }) => text(`${TEMPLATES[kind]!.use}\n${JSON.stringify(TEMPLATES[kind]!.screen, null, 1)}`),
  );

  reg(
    "hmi_list",
    { description: "List the open project's HMI screens.", inputSchema: z.object({ screen: z.string().optional().describe("Return this screen's full description") }) },
    async ({ screen }) => {
      if (screen) {
        const s = hmi.screen(screen);
        return s ? text(JSON.stringify(s, null, 2)) : text(`No screen named '${screen}'.`, true);
      }
      const all = hmi.screens();
      return text(all.length ? all.map((s) => `${s.name}: "${s.title}" (${s.widgets.length} widgets, ${screenVariables(s).length} variables)`).join("\n") : "No HMI screens yet.");
    },
  );

  reg(
    "hmi_delete_screen",
    { description: "Delete an HMI screen.", inputSchema: z.object({ screen: z.string() }) },
    async ({ screen }) => (hmi.remove(screen) ? text(`Deleted screen '${screen}'.`) : text(`No screen named '${screen}'.`, true)),
  );

  reg(
    "open_hmi",
    {
      description: "Open the live HMI in the user's browser (full screen, live values from the simulation, buttons work). Call this only when the user asks to see or operate the HMI.",
      inputSchema: z.object({ screen: z.string().optional() }),
    },
    async ({ screen }) => {
      if (!ctx.viewer) return text("The browser page is switched off (--no-viewer).", true);
      const url = ctx.viewer.url.replace("/?t=", "/hmi?t=") + (screen ? `&s=${encodeURIComponent(screen)}` : "");
      ctx.viewer.open(true, url);
      return text(`The live HMI opened in the user's browser: ${url}${currentCodesysSim(ctx) ? "" : "\nThe simulation isn't running: start it (codesys_sim_start, then codesys_sim_control run) so the screen shows live values."}`);
    },
  );
  void run;
}
