/**
 * CODESYS Trace in the simulation: record variables every task cycle and get
 * the data back as a summary, a table and a chart (watcher/mcp_trace.py).
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import type { ActionResult, RegisterAction } from "../actions.js";
import { findBrowser, screenshot } from "../hmi/service.js";
import type { AppContext } from "../tools.js";
import { currentCodesysSim } from "./simulation.js";

export interface TraceData {
  vars: string[];
  t: number[];
  cols: number[][];
}

/** CODESYS's saved trace: a title, the project, a header 'Timestamp(ms) a b', then rows. */
export function parseTrace(text: string): TraceData {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const h = lines.findIndex((l) => /^Timestamp/i.test(l));
  if (h < 0) throw new Error("not a CODESYS trace file");
  const vars = lines[h]!.split(/\s+/).slice(1);
  const t: number[] = [];
  const cols: number[][] = vars.map(() => []);
  for (const l of lines.slice(h + 1)) {
    const p = l.split(/\s+/).map(Number);
    if (p.length < vars.length + 1 || p.some((x) => Number.isNaN(x))) continue;
    t.push(p[0]!);
    vars.forEach((_, i) => cols[i]!.push(p[i + 1]!));
  }
  return { vars, t, cols };
}

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(Math.abs(x) >= 100 ? 1 : 3).replace(/0+$/, "").replace(/\.$/, ""));

export function summarize(d: TraceData): string {
  if (!d.t.length) return "The trace recorded no samples (is the task running?).";
  const span = d.t[d.t.length - 1]! - d.t[0]!;
  const dt = d.t.length > 1 ? span / (d.t.length - 1) : 0;
  const lines = [`${d.t.length} samples over ${(span / 1000).toFixed(2)} s (about every ${Math.round(dt)} ms).`];
  d.vars.forEach((v, i) => {
    const c = d.cols[i]!;
    const bool = c.every((x) => x === 0 || x === 1);
    if (bool) {
      const edges: string[] = [];
      for (let k = 1; k < c.length; k++) if (c[k] !== c[k - 1]) edges.push(`${c[k] ? "TRUE" : "FALSE"} at ${d.t[k]} ms`);
      lines.push(`${v} (BOOL): starts ${c[0] ? "TRUE" : "FALSE"}, ${edges.length ? `then ${edges.slice(0, 12).join(", ")}${edges.length > 12 ? ` (+${edges.length - 12} more)` : ""}` : "never changes"}.`);
    } else {
      const min = Math.min(...c), max = Math.max(...c);
      lines.push(`${v}: first ${fmt(c[0]!)}, last ${fmt(c[c.length - 1]!)}, min ${fmt(min)} at ${d.t[c.indexOf(min)]} ms, max ${fmt(max)} at ${d.t[c.indexOf(max)]} ms.`);
    }
  });
  return lines.join("\n");
}

/** At most n rows, evenly spread, as a table. */
export function table(d: TraceData, n = 40): string {
  const step = Math.max(1, Math.ceil(d.t.length / n));
  const rows = [["t (ms)", ...d.vars].join("\t")];
  for (let k = 0; k < d.t.length; k += step) rows.push([d.t[k], ...d.cols.map((c) => fmt(c[k]!))].join("\t"));
  return rows.join("\n");
}

const COLORS = ["#38bdf8", "#a78bfa", "#fbbf24", "#34d399", "#f472b6", "#60a5fa"];

/** A chart page: one lane per variable (booleans as steps), shared time axis. */
export function chartPage(d: TraceData, title: string): { html: string; w: number; h: number } {
  const W = 1000, lane = 110, top = 62, left = 70, right = 20;
  const H = top + d.vars.length * (lane + 34) + 14;
  const t0 = d.t[0] ?? 0, t1 = d.t[d.t.length - 1] ?? 1;
  const X = (t: number) => left + ((t - t0) / (t1 - t0 || 1)) * (W - left - right);
  const lanes = d.vars.map((v, i) => {
    const c = d.cols[i]!;
    const y0 = top + i * (lane + 34);
    const bool = c.every((x) => x === 0 || x === 1);
    const min = Math.min(...c), max = Math.max(...c);
    const lo = bool ? 0 : min === max ? min - 1 : min, hi = bool ? 1 : min === max ? max + 1 : max;
    const Y = (x: number) => y0 + lane - (bool ? 0.1 + 0.8 * x : (x - lo) / (hi - lo)) * lane;
    let path = "";
    c.forEach((x, k) => {
      const px = X(d.t[k]!).toFixed(1), py = Y(x).toFixed(1);
      if (!k) path = `M${px} ${py}`;
      else path += bool ? ` H${px} V${py}` : ` L${px} ${py}`;
    });
    const col = COLORS[i % COLORS.length]!;
    return `<text x="${left}" y="${y0 - 8}" class="n">${v.replace(/[<&]/g, "")}</text><text x="${left - 6}" y="${y0 + 12}" class="a">${bool ? "TRUE" : fmt(hi)}</text><text x="${left - 6}" y="${y0 + lane}" class="a">${bool ? "FALSE" : fmt(lo)}</text>
<line x1="${left}" x2="${W - right}" y1="${y0 + lane}" y2="${y0 + lane}" class="g"/><line x1="${left}" x2="${W - right}" y1="${y0}" y2="${y0}" class="g"/>
<path d="${path}" fill="none" stroke="${col}" stroke-width="2"/>`;
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#0b1220;font-family:"Segoe UI",system-ui,sans-serif}
text{fill:#8193ad;font-size:12px}.n{fill:#e6edf7;font-size:13px;font-weight:600}.a{text-anchor:end;font-size:11px}.g{stroke:#24324a}.t{fill:#e6edf7;font-size:16px;font-weight:650}</style></head>
<body><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><text x="8" y="26" class="t">${title.replace(/[<&]/g, "")}</text>
${lanes.join("\n")}<text x="${left}" y="${H - 8}">${t0} ms</text><text x="${W - right}" y="${H - 8}" class="a">${t1} ms</text></svg></body></html>`;
  return { html, w: W, h: H };
}

export function registerTraceActions(reg: RegisterAction, ctx: AppContext, run: (fn: () => Promise<string>) => Promise<ActionResult>): void {
  const b = ctx.bridge;
  reg(
    "trace_setup",
    {
      description: "Set up a CODESYS trace (before codesys_sim_start: it is part of the project): the variables to record every cycle of a task. Then start the simulation and call trace_record. Replaces a trace of the same name.",
      inputSchema: z.object({
        variables: z.array(z.string()).min(1).max(20).describe("e.g. ['PLC_PRG.rLevel', 'PLC_PRG.fbPump.xRunning']"),
        name: z.string().default("Trace_MCP"),
        task: z.string().optional().describe("Task to sample in (default: the first task)"),
        everyNCycles: z.number().int().min(1).max(1000).optional().describe("Record every n-th cycle"),
      }),
    },
    async ({ variables, name, task, everyNCycles }) =>
      run(async () => {
        const r = await b.call<{ name: string; task: string }>("trace.setup", { variables, name, task, every_n_cycles: everyNCycles, save: ctx.autosave }, { timeoutMs: 120_000 });
        return `Trace ${r.name} records ${variables.length} variable(s) in task ${r.task}. Start the simulation (codesys_sim_start, codesys_sim_control run), drive the inputs, then call trace_record.`;
      }),
  );
  reg(
    "trace_record",
    {
      description: "Record a trace in the running simulation for some seconds, then return what happened: a summary per variable (BOOL edges with times, min/max with times), a table and a chart image. Set the trace up first with trace_setup. Write or force inputs before or between recordings to test timing (e.g. a 500 ms blink, a start delay).",
      inputSchema: z.object({ name: z.string().default("Trace_MCP"), seconds: z.number().min(0.5).max(60).default(5) }),
    },
    async ({ name, seconds }) => {
      if (!currentCodesysSim(ctx)) return { content: [{ type: "text", text: "The simulation isn't running: call codesys_sim_start (and codesys_sim_control run) first." }], isError: true };
      const dir = mkdtempSync(join(tmpdir(), "cmcp-trace-"));
      try {
        const path = join(dir, "trace.txt");
        let d: TraceData | undefined;
        const r = await run(async () => {
          await b.call("trace.record", { name, ms: Math.round(seconds * 1000), path }, { timeoutMs: seconds * 1000 + 120_000 });
          d = parseTrace(readFileSync(path, "utf8"));
          return `${summarize(d)}\n\n${table(d)}`;
        });
        if (r.isError || !d || !findBrowser()) return r;
        try {
          const c = chartPage(d, name);
          const png = await screenshot(c.html, undefined, { w: c.w, h: c.h });
          return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }, ...r.content] };
        } catch (e) {
          return { content: [...r.content, { type: "text", text: `(No chart: ${(e as Error).message})` }] };
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
