/**
 * The model's HMI actions: design screens, look at them, open the live page.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import { currentCodesysSim } from "../codesys/simulation.js";
import type { AppContext } from "../tools.js";
import { findBrowser, hmiScript, previewValues, screenshot, staticPage, type HmiService } from "./service.js";
import { nativePlan } from "./native.js";
import { layoutProblems, screenSchema, screenVariables } from "./spec.js";

const text = (t: string, isError = false): ActionResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });

const GUIDE = `A screen is a ${"12x8"} grid of tiles (change with grid). Each widget has at: [column, row, width, height], 1-based, no overlaps.
Widgets: value (big number, optional sparkline), gauge, bar, status (LED list), buttons (tap/toggle/set/reset), switch, setpoint (+/- and slider), trend (up to 6 series), alarms, text, and process: a mimic diagram whose items sit in a 0..100 x 0..100 box (x across, y down): tank, pump, fan, valve, junction, pipe, sensor, lamp, label.
Connect pipes to ports, never by guessing points: {type: 'pipe', from: 'T-101.right', to: 'P-101.in', flow: 'PLC_PRG.xRun'}. The toolkit routes it with right angles and it meets the symbols exactly. A symbol's name is its id, or its label. Ports: tank top, bottom, left, right, left-high, right-high; pump and fan in (left), out (right), top, bottom; valve in, out (left/right, or bottom/top when vertical: true); junction c (for tees). A pipe end can also be a point [x, y] at the diagram's edge. via: [[x, y]] makes it pass points. For straight runs give connected symbols the same y (or x); a valve on a vertical pipe is vertical: true.
Variables are full instance paths: 'PLC_PRG.fbPump.xRunning', 'GVL.rLevel'. bands colour a value by range: [{from: 0, tone: 'accent'}, {from: 90, tone: 'alarm'}]. Tones: accent, ok, warn, alarm, neutral.
Good screens: the process diagram large on the left (about 8x5), key numbers and status on the right, controls and trends along the bottom; titles short; tag names on symbols (P-101, T-101).`;

export function registerHmiActions(reg: RegisterAction, ctx: AppContext, hmi: HmiService, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  reg(
    "hmi_save_screen",
    {
      description: `Create or replace an HMI screen for the open project (stored next to it as <project>.hmi.json). It shows live in the browser page (open_hmi) and the panel while CODESYS's simulation runs, and buttons, switches and setpoints write to the simulation. After saving, call hmi_screenshot to look at it and fix what looks off.\n${GUIDE}`,
      inputSchema: z.object({ screen: screenSchema }),
    },
    async ({ screen }) => {
      if (!ctx.project) return text("No project is open: open or create one first; screens are stored next to it.", true);
      const problems = layoutProblems(screen);
      if (problems.length) return text(`Not saved: fix the layout first.\n- ${problems.join("\n- ")}`, true);
      const vars = screenVariables(screen);
      const roots = new Set(vars.map((v) => v.split(".")[0]!.toLowerCase()));
      const unknown = ctx.cache ? [...roots].filter((r) => !ctx.cache!.get(r) && !/^(gvl|io|hmi)/i.test(r)) : [];
      const r = hmi.save(screen);
      const warn = unknown.length ? `\nCheck these: no object named ${unknown.map((u) => `'${u}'`).join(", ")} in the project (the first part of a variable path must be a program or GVL).` : "";
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
      }),
    },
    async ({ screen: name, values }) => {
      const s = hmi.screen(name);
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
        const png = await screenshot(staticPage(s, shown, hmi.sim(), script));
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, { type: "text", text: `Screen '${s.name}' (1280x720) with ${source}.` }] };
      } catch (e) {
        return text(`Screenshot failed: ${(e as Error).message}`, true);
      }
    },
  );

  reg(
    "hmi_export_codesys",
    {
      description:
        "Build an HMI screen as a native CODESYS visualization in the project (Visu_<screen>), so it ships with the application: rounded cards, gradients, SVG pump, fan and valve symbols in an embedded image pool, live values, bars and tank levels, colour states, buttons, switches and setpoints. A generated program PRG_HMI_<screen> scales values for bars and levels; it is called from VISU_TASK. Returns a picture of the visualization. Trends are shown as values (CODESYS's trend element can't be created by script). Rebuilds the visualization if it exists.",
      inputSchema: z.object({ screen: z.string().optional().describe("Screen name (default: the first)") }),
    },
    async ({ screen: name }) => {
      const s = hmi.screen(name);
      if (!s) return text(name ? `No screen named '${name}'.` : "This project has no HMI screens yet: create one with hmi_save_screen.", true);
      const b = ctx.bridge;
      if (!(await b.waitReady(ctx.startWaitMs))) return text("CODESYS is still starting; try again shortly.", true);
      const plan = nativePlan(s);
      const dir = mkdtempSync(join(tmpdir(), "cmcp-visu-"));
      try {
        const images = plan.images.map((img) => {
          const path = join(dir, `${img.id}.svg`);
          writeFileSync(path, img.svg, "utf8");
          return { id: img.id, path };
        });
        const notes: string[] = [];
        // The helper program first: the visualization refers to its variables.
        try {
          await b.call("object.write", { path: plan.helper.name, declaration: plan.helper.declaration, implementation: plan.helper.implementation });
        } catch {
          await b.call("object.create", { kind: "program", name: plan.helper.name, declaration: plan.helper.declaration, implementation: plan.helper.implementation });
        }
        const built = await b.call<{ name: string; elements: number; warnings: string[] }>(
          "visu.build",
          { name: plan.visu, replace: true, background: plan.background, elements: plan.elements, image_pool: plan.imagePool, images, save: ctx.autosave },
          { timeoutMs: 300_000 },
        );
        for (const task of ["VISU_TASK", "MainTask"]) {
          try {
            await b.call("task.configure", { name: task, add_calls: [plan.helper.name], save: ctx.autosave });
            notes.push(`${plan.helper.name} runs in ${task}.`);
            break;
          } catch {
            /* try the next task */
          }
        }
        const build = await b.call<{ messages: { severity: string; text: string; object?: string }[] }>("build", {}, { timeoutMs: 900_000 });
        const errors = build.messages.filter((m) => /error/i.test(m.severity));
        if (errors.length) {
          const fpu = errors.some((m) => /\bFPU\b|FloatingPointUtils/.test(m.text));
          notes.push(
            fpu
              ? `The build has ${errors.length} errors because this CODESYS's library repository lacks FloatingPointUtils, which the visualization libraries need. Install it with the CODESYS Installer (or Tools > Library Repository), then compile again.`
              : `The build has ${errors.length} errors, for example: ${errors.slice(0, 3).map((m) => `${m.object ?? ""} ${m.text}`.trim()).join("; ")}`,
          );
        } else notes.push("Compiles with 0 errors. Start the simulation to see it live.");
        if (built.warnings.length) notes.push(`Not applied (${built.warnings.length}): ${built.warnings.slice(0, 6).join("; ")}`);
        const png = join(dir, "visu.png");
        let image: ActionResult["content"] = [];
        try {
          await b.call("visu.render", { name: plan.visu, path: png, width: 1280, height: 720 }, { timeoutMs: 60_000 });
          image = [{ type: "image", data: readFileSync(png).toString("base64"), mimeType: "image/png" }];
        } catch (e) {
          notes.push(`No picture: ${(e as Error).message}`);
        }
        return { content: [...image, { type: "text", text: `Built ${built.name} (${built.elements} elements) from screen '${s.name}', with image pool ${plan.imagePool} and program ${plan.helper.name}.\n${notes.join("\n")}` }] };
      } catch (e) {
        return text(`${(e as { code?: string }).code ? `${(e as { code: string }).code}: ` : ""}${(e as Error).message}`, true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
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
