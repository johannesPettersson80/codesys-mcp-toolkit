/**
 * The simulation controller: mirror sync, build, run, breakpoints, stepping,
 * variables, plant parameters and experiments, on top of trust-runtime.
 *
 * The simulation is kept paused between calls, so every run is a known number
 * of scans in simulated time (the plant advances in lockstep with scans and
 * freezes while paused).
 *
 * Hard rule: the simulation path never connects to a CODESYS controller or
 * online application. It reads the CODESYS project only through
 * `CodesysSource` (export + task list), and talks only to the trust-runtime
 * it started on 127.0.0.1 (see control.ts and runtime.ts).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TreeNode } from "../codesys/st.js";
import { evaluateCondition, parseExpr } from "./expr.js";
import { Journal } from "./journal.js";
import { Recorder, type TrendPoint } from "./recorder.js";
import { checkExpectations, parseScenarios, stringifyScenarios, validateScenario, type Scenario } from "./scenarios.js";
import type { PanelLocation, PanelState, SignalRole, SourceView } from "./panel-types.js";
import { composeMirror, fromMirror, HARNESS, HARNESS_FILE, partLines, toMirror, type TaskInfo } from "./mirror.js";
import { readManifest, writeMirror, type Manifest, type SyncResult } from "./mirror-store.js";
import { applyOverride, parsePlantConfig, simulationToml, type ParamOverride, type PlantConfig } from "./plant.js";
import { TrustError } from "./control.js";
import { findTrustRuntime, TrustRuntime, TESTED_TRUST_VERSION, type Diagnostic, type TestRun } from "./runtime.js";
import { formatValue, numeric, parseTrustValue, toTrustLiteral, type StValue } from "./values.js";

/** Read-only view of the CODESYS project: the only CODESYS access the simulation has. */
export interface CodesysSource {
  exportSt(): Promise<TreeNode[]>;
  tasks(): Promise<TaskInfo[]>;
  projectPath(): string | undefined;
}

export class SimError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Breakpoint {
  id: number;
  obj: string;
  part: "decl" | "impl";
  line: number;
  file: string;
  line0: number;
  condition?: string;
}

export interface Location {
  reason: string;
  file: string;
  line0: number;
  obj?: string;
  part?: "decl" | "impl";
  line?: number;
  harness: boolean;
  breakpoint?: Breakpoint;
}

export interface ExperimentSpec {
  name?: string;
  duration_s: number;
  speed?: number;
  pv?: string;
  sp?: { var: string; value: string | number; at_s?: number };
  set?: Record<string, string | number>;
  force?: { var: string; value: string | number; at_s?: number; until_s?: number }[];
  watch?: string[];
  samples?: number;
  restart?: boolean;
}

export interface ExperimentResult {
  n: number;
  name: string;
  at: string;
  spec: ExperimentSpec;
  metrics: Record<string, number | string | null>;
  watch: Record<string, string>;
  /** Numeric statistics of the watched variables (for scenario expectations). */
  watchStats: Record<string, { final: number | null; finalText: string; min: number | null; max: number | null }>;
  samples: { t: number; values: Record<string, number | null> }[];
  summary: string;
}

export interface SimOptions {
  /** trust-runtime executable (else TRUST_RUNTIME or PATH). */
  trustRuntime?: string;
  /** Folder that holds one mirror folder per project. */
  mirrorRoot: string;
  log?: (m: string) => void;
  git?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtS = (ms: number) => `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;

export class SimController {
  readonly journal = new Journal();
  private runtime?: TrustRuntime;
  private manifest?: Manifest;
  private mirrorDir?: string;
  private plant?: PlantConfig;
  private plantFile?: string;
  private overrides: ParamOverride[] = [];
  private builtHash?: string;
  private breakpoints = new Map<number, Breakpoint>();
  private nextBp = 1;
  private sourceCache = new Map<string, string[]>();
  timeScale = 10;
  private experiments: ExperimentResult[] = [];
  private forced = new Set<string>();
  /** Trend samples for the panel. */
  readonly recorder = new Recorder();
  /** What the simulation is busy with right now (for the panel). */
  activity?: string;
  /** Signals of the experiment that is running (shown in the panel). */
  private experimentSignals: string[] = [];
  private trustVersion?: string;

  constructor(
    private readonly codesys: CodesysSource,
    private readonly o: SimOptions,
  ) {}

  // ------------------------------------------------------------ mirror

  mirrorFolder(project = this.codesys.projectPath()): string {
    if (!project) throw new SimError("no_project", "No CODESYS project is open. Call open_project first.");
    const base = basename(project).replace(/\.project$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_");
    const h = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 8);
    return join(this.o.mirrorRoot, `${base}-${h}`);
  }

  defaultPlantFile(project = this.codesys.projectPath()): string | undefined {
    if (!project) return undefined;
    const own = join(dirname(project), basename(project).replace(/\.project$/i, "") + ".plant.toml");
    if (existsSync(own)) return own;
    const shared = join(dirname(project), "plant.toml");
    return existsSync(shared) ? shared : own;
  }

  private async loadPlant(file?: string): Promise<void> {
    const f = file ?? this.defaultPlantFile();
    this.plantFile = f && existsSync(f) ? f : undefined;
    this.plant = this.plantFile ? parsePlantConfig(await readFile(this.plantFile, "utf8")) : undefined;
  }

  private effectivePlant(): PlantConfig | undefined {
    if (!this.plant) return undefined;
    const copy: PlantConfig = structuredClone(this.plant);
    for (const o of this.overrides) applyOverride(copy, o);
    return copy;
  }

  /** Save plant.toml text (validated) next to the project. */
  async savePlant(text: string): Promise<string> {
    parsePlantConfig(text);
    const f = this.defaultPlantFile();
    if (!f) throw new SimError("no_project", "No CODESYS project is open.");
    await writeFile(f, text.endsWith("\n") ? text : text + "\n", "utf8");
    this.overrides = [];
    return f;
  }

  async sync(plantFile?: string): Promise<SyncResult & { dir: string; plantFile?: string }> {
    const project = this.codesys.projectPath();
    const dir = this.mirrorFolder(project);
    await this.loadPlant(plantFile);
    const [nodes, tasks] = [await this.codesys.exportSt(), await this.codesys.tasks()];
    const plant = this.effectivePlant();
    const c = composeMirror(nodes, tasks, { plant });
    const simToml = simulationToml(plant, { timeScale: this.timeScale, traceCapacity: 1000, addresses: c.addresses });
    const r = await writeMirror(dir, c, simToml, project, this.o.git ?? true);
    this.manifest = r.manifest;
    this.mirrorDir = dir;
    this.sourceCache.clear();
    // Breakpoints follow their CODESYS line; drop the ones whose line vanished.
    for (const bp of [...this.breakpoints.values()]) {
      const m = toMirror(this.files(), bp.obj, bp.line, bp.part);
      if (m) Object.assign(bp, { file: m.path, line0: m.line0 });
      else this.breakpoints.delete(bp.id);
    }
    this.journal.add("mirror_synced", `Mirror synced: ${r.changed.length} object(s) changed`, { changed: r.changed, dir });
    return { ...r, dir, plantFile: this.plantFile };
  }

  private files(): { path: string; map: Manifest["map"][string] }[] {
    return Object.entries(this.manifest?.map ?? {}).map(([path, map]) => ({ path, map }));
  }

  private async mirrorHash(dir: string): Promise<string> {
    const h = createHash("sha256");
    for (const f of [...(this.manifest?.files ?? [])].sort()) {
      if (f.startsWith(".")) continue;
      h.update(f).update(await readFile(join(dir, f), "utf8").catch(() => ""));
    }
    return h.digest("hex");
  }

  /** Mirror text as the user wrote it in CODESYS: E#X enum literals back to E.X. */
  private asCodesys(line: string): string {
    const enums = new Set((this.manifest?.enums ?? []).map((e) => e.toLowerCase()));
    if (!enums.size) return line;
    return line.replace(/\b([A-Za-z_][A-Za-z0-9_]*)#([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, e: string, x: string) => (enums.has(e.toLowerCase()) ? `${e}.${x}` : m));
  }

  private async sourceLines(file: string): Promise<string[]> {
    let l = this.sourceCache.get(file);
    if (!l && this.mirrorDir) {
      l = (await readFile(join(this.mirrorDir, file), "utf8").catch(() => "")).split("\n");
      this.sourceCache.set(file, l);
    }
    return l ?? [];
  }

  /** Map truST diagnostics (byte offsets in mirror files) to CODESYS objects and lines. */
  async mapDiagnostics(diags: Diagnostic[]): Promise<string[]> {
    const out: string[] = [];
    for (const d of diags) {
      let where = d.file;
      if (d.start !== undefined && this.mirrorDir) {
        const text = await readFile(join(this.mirrorDir, d.file), "utf8").catch(() => "");
        const line0 = Buffer.from(text, "utf8").subarray(0, d.start).toString("utf8").split("\n").length - 1;
        const o = fromMirror(this.files(), d.file, line0);
        where = o ? `${o.obj} (${o.part === "decl" ? "declaration" : "implementation"} line ${o.line})` : `${d.file} line ${line0 + 1} (generated)`;
      }
      out.push(`${where}: ${d.message}`);
    }
    return out;
  }

  // ------------------------------------------------------------ runtime

  private getRuntime(): TrustRuntime {
    if (!this.runtime) {
      const exe = findTrustRuntime(this.o.trustRuntime);
      if (!exe) {
        throw new SimError(
          "no_trust_runtime",
          "trust-runtime was not found. Install truST (https://github.com/johannesPettersson80/trust-platform/releases) and pass --trust-runtime <path>, or put it on PATH.",
        );
      }
      this.runtime = new TrustRuntime(exe, this.o.log);
      this.runtime.onExit = (info) => this.journal.add("sim_exited", info);
    }
    return this.runtime;
  }

  get running(): boolean {
    return !!this.runtime?.running && !!this.runtime.control;
  }

  private ctl() {
    const c = this.runtime?.control;
    if (!this.running || !c) throw new SimError("not_running", "The simulation is not running. Call sim_start.");
    return c;
  }

  async start(o: { timeScale?: number; sync?: boolean } = {}): Promise<string> {
    const notes: string[] = [];
    const rt = this.getRuntime();
    if (this.running) await this.stop();
    const version = await rt.version();
    this.trustVersion = version;
    if (version !== TESTED_TRUST_VERSION) notes.push(`Note: trust-runtime ${version}; this toolkit was tested with ${TESTED_TRUST_VERSION}.`);
    const tc = await rt.toolchain();
    if (!tc.installed) {
      throw new SimError(
        "no_toolchain",
        `truST's compiler toolchain is not installed, and building would download it (about 180 MB) without asking. Install it once with:\n  "${rt.exe}" toolchain install\nthen call sim_start again.`,
      );
    }
    if (o.timeScale) this.timeScale = o.timeScale;
    if (o.sync !== false) {
      const r = await this.sync();
      notes.push(`Mirror synced (${r.changed.length} object(s) changed${r.committed ? `, commit ${r.committed}` : ""}).`);
    } else if (!this.manifest) {
      const dir = this.mirrorFolder();
      this.manifest = await readManifest(dir);
      if (!this.manifest) throw new SimError("no_mirror", "No mirror yet. Call sync_mirror first.");
      this.mirrorDir = dir;
    }
    const dir = this.mirrorDir!;
    for (const w of this.manifest!.warnings) notes.push(`Warning: ${w}`);
    const hash = await this.mirrorHash(dir);
    if (hash !== this.builtHash || !existsSync(join(dir, "program.tpi"))) {
      const b = await rt.build(dir);
      if (!b.ok) {
        const mapped = b.diagnostics.length ? await this.mapDiagnostics(b.diagnostics) : [b.output.split("\n").slice(-15).join("\n")];
        throw new SimError("build_failed", `truST could not build the mirror:\n${mapped.join("\n")}`);
      }
      this.builtHash = hash;
      this.journal.add("sim_built", `Built in ${fmtS(b.ms)}`);
      notes.push(`Built in ${fmtS(b.ms)}.`);
    }
    const before = await this.freshStart();
    this.journal.add("sim_started", `Simulation started (time scale ${this.timeScale}x)`, { pid: rt.pid, dir });
    return [
      `Simulation running in truST (pid ${rt.pid}), paused at the start of scan ${before + 1}. Cycle ${this.manifest!.cycleMs} ms (task ${this.manifest!.clockTask}), time scale ${this.timeScale}x.`,
      `Plant: ${this.plant ? this.plant.plants.map((p) => `${p.id} (${p.model})`).join(", ") || "none" : "none (no plant.toml)"}${this.plant?.feedback.length ? `, ${this.plant.feedback.length} feedback signal(s)` : ""}.`,
      ...notes,
      "Use run_scans / run_for to advance time, set_breakpoint + continue to stop in code.",
    ].join("\n");
  }

  async stop(): Promise<string> {
    if (!this.runtime?.running) return "The simulation is not running.";
    await this.runtime.stop();
    this.journal.add("sim_stopped", "Simulation stopped");
    return "Simulation stopped.";
  }

  /**
   * Start trust-runtime from fresh PLC and plant state and pause at the start
   * of a scan. truST can't start paused (TRUST-GAPS B14) and its control
   * `restart` doesn't reset plants (B13), so this starts a new process at 1x
   * and pauses as soon as the control endpoint answers: a few scans run first.
   * Returns the number of scans that ran before the pause.
   */
  private async freshStart(): Promise<number> {
    const rt = this.getRuntime();
    if (rt.running) await rt.stop();
    await rt.start(this.mirrorDir!, { timeScale: 1, cycleMs: this.manifest!.cycleMs, pause: true });
    await this.ensurePaused();
    await this.setHarnessBreakpoint(1);
    await this.ctl().request("resume");
    const stop = await this.waitForStop(15_000, false);
    await this.setHarnessBreakpoint(0);
    if (!stop) throw new SimError("start_failed", "The simulation did not reach a scan start after starting.");
    // Always hand over after at least one complete scan, so first-scan
    // initialisation in the program has run whatever the pause timing was.
    if ((await this.scan()) < 1) await this.runScansRaw(1);
    this.forced.clear();
    await this.setTimeScale(this.timeScale);
    await this.pushAllBreakpoints();
    this.recorder.reset();
    await this.record();
    return this.scan();
  }

  private async setHarnessBreakpoint(count: number): Promise<void> {
    const line = this.manifest!.harnessLine0;
    await this.ctl().request(
      "breakpoints.set",
      count > 0 ? { source: HARNESS_FILE, lines: [line], options: [{ hit_condition: { op: "=", count } }] } : { source: HARNESS_FILE, lines: [] },
    );
  }

  /**
   * Wait for the runtime to stop. Breakpoints with a condition whose condition
   * is false are resumed here (conditions are evaluated by the toolkit, see expr.ts).
   */
  private async waitForStop(timeoutMs: number, userOnly: boolean): Promise<Location | undefined> {
    const c = this.ctl();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.running) throw new SimError("sim_exited", `The simulation stopped unexpectedly. ${this.runtime?.exitInfo ?? ""}\n${await this.runtime?.logTail(10)}`);
      const r = await c.request<{ stops: { path?: string; line?: number; reason: string }[] }>("debug.stops");
      for (const s of r.stops) {
        // Pause records are ours (ensurePaused); they never end a wait.
        if (s.reason === "pause") continue;
        const loc = this.locate(s);
        if (loc.harness && userOnly) continue;
        if (loc.breakpoint?.condition) {
          let hit: boolean;
          try {
            hit = await evaluateCondition(loc.breakpoint.condition, (p) => this.readValue(p));
          } catch (e) {
            this.journal.add("stopped", `Condition of breakpoint #${loc.breakpoint.id} failed: ${(e as Error).message}`);
            return loc;
          }
          if (!hit) {
            await c.request("resume");
            break;
          }
        }
        return loc;
      }
      await sleep(r.stops.length ? 0 : 4);
    }
    return undefined;
  }

  private locate(s: { path?: string; line?: number; reason: string }): Location {
    const file = (s.path ?? "").replace(/\\/g, "/");
    const line0 = s.line ?? 0;
    const harness = file.toLowerCase().endsWith(HARNESS_FILE.toLowerCase());
    const origin = harness ? undefined : fromMirror(this.files(), file, line0);
    const bp = [...this.breakpoints.values()].find((b) => b.file.toLowerCase() === file.toLowerCase() && b.line0 === line0);
    return { reason: s.reason, file, line0, harness, breakpoint: s.reason === "breakpoint" ? bp : undefined, ...(origin ? { obj: origin.obj, part: origin.part, line: origin.line } : {}) };
  }

  async readValue(path: string): Promise<StValue> {
    const r = await this.ctl().request<{ value: string }>("eval", { expr: path });
    return parseTrustValue(r.value);
  }

  async scan(): Promise<number> {
    const v = await this.readValue(`${HARNESS}.nScan`);
    return v.kind === "number" ? v.value : 0;
  }

  private async where(loc: Location | undefined, opts: { locals?: boolean } = {}): Promise<string> {
    const scan = await this.scan().catch(() => 0);
    const time = `scan ${scan}, sim time ${fmtS(scan * this.manifest!.cycleMs)}`;
    if (!loc) return `Running (${time}).`;
    if (loc.harness) return `Paused at the start of a scan (${time}).`;
    const what = loc.breakpoint ? `breakpoint #${loc.breakpoint.id}${loc.breakpoint.condition ? ` (${loc.breakpoint.condition})` : ""}` : loc.reason;
    const place = loc.obj ? `${loc.obj}${loc.part === "decl" ? " declaration" : ""} line ${loc.line}` : `${loc.file}:${loc.line0 + 1} (generated code)`;
    const out = [`Stopped (${what}) at ${place}, ${time}.`];
    const src = await this.sourceLines(loc.file);
    for (let i = Math.max(0, loc.line0 - 2); i <= Math.min(src.length - 1, loc.line0 + 2); i++) {
      const o = fromMirror(this.files(), loc.file, i);
      if (!o || o.obj !== loc.obj || o.part !== loc.part) continue;
      out.push(`${i === loc.line0 ? ">" : " "} ${String(o.line).padStart(4)} | ${this.asCodesys(src[i] ?? "")}`);
    }
    try {
      const st = await this.ctl().request<{ stack_frames: { name: string; line: number; source?: { path?: string } }[] }>("debug.stack");
      if (st.stack_frames.length > 1) {
        out.push(
          "Call stack: " +
            st.stack_frames
              .map((f) => {
                const o = f.source?.path ? fromMirror(this.files(), f.source.path, f.line) : undefined;
                return o ? `${o.obj} line ${o.line}` : f.name;
              })
              .join(" <- "),
        );
      }
    } catch {
      /* stack is best effort */
    }
    if (opts.locals !== false) {
      const l = await this.locals().catch(() => "");
      if (l) out.push(`Locals: ${l}`);
    }
    return out.join("\n");
  }

  private async locals(): Promise<string> {
    const c = this.ctl();
    const sc = await c.request<{ scopes: { name: string; variablesReference: number }[] }>("debug.scopes", { frame_id: 1 });
    const ref = sc.scopes.find((s) => s.name === "Locals")?.variablesReference;
    if (!ref) return "";
    const v = await c.request<{ variables: { name: string; type: string; value: string; variablesReference: number }[] }>("debug.variables", { variables_reference: ref });
    const items = v.variables.map((x) => (x.variablesReference ? `${x.name} : ${x.type}` : `${x.name} = ${x.value}`));
    return items.slice(0, 40).join(", ") + (items.length > 40 ? `, ... (${items.length - 40} more)` : "");
  }

  async status(): Promise<string> {
    const lines: string[] = [];
    if (!this.running) {
      lines.push(`Simulation: not running.${this.runtime?.exitInfo ? ` Last: ${this.runtime.exitInfo}.` : ""}`);
    } else {
      const st = await this.ctl().request<{ paused: boolean; last_stop?: { path?: string; line?: number; reason: string } | null }>("debug.state");
      lines.push(`Simulation: running in truST (pid ${this.runtime!.pid}), ${st.paused ? "paused" : "running"}, time scale ${this.timeScale}x.`);
      lines.push(await this.where(st.paused && st.last_stop ? this.locate(st.last_stop) : undefined, { locals: false }));
    }
    if (this.mirrorDir) lines.push(`Mirror: ${this.mirrorDir}`);
    if (this.plantFile) lines.push(`Plant: ${this.plantFile}${this.overrides.length ? ` (+${this.overrides.length} override(s): ${this.overrides.map((o) => `${o.plant}.${o.key}=${JSON.stringify(o.value)}`).join(", ")})` : ""}`);
    if (this.breakpoints.size) lines.push(`Breakpoints: ${[...this.breakpoints.values()].map((b) => `#${b.id} ${b.obj}:${b.line}${b.condition ? ` if ${b.condition}` : ""}`).join("; ")}`);
    if (this.forced.size) lines.push(`Forced: ${[...this.forced].join(", ")}`);
    if (this.experiments.length) lines.push(`Experiments: ${this.experiments.length} (last: ${this.experiments.at(-1)!.name})`);
    return lines.join("\n");
  }

  // ------------------------------------------------------------ running

  /** Pause (if running) and drain the stop records, so the next wait sees only new stops. */
  private async ensurePaused(): Promise<void> {
    const c = this.ctl();
    if (!(await c.request<{ paused: boolean }>("debug.state")).paused) {
      await c.request("pause");
      for (let i = 0; i < 200 && !(await c.request<{ paused: boolean }>("debug.state")).paused; i++) await sleep(10);
    }
    await c.request("debug.stops");
  }

  /** Run n scans; stops early at a user breakpoint. Returns where it stopped. */
  private async runScansRaw(n: number, o: { keepHarness?: boolean; before?: number } = {}): Promise<{ loc?: Location; ran: number; scan: number }> {
    const c = this.ctl();
    await this.ensurePaused();
    const before = o.before ?? (await this.scan());
    await this.setHarnessBreakpoint(n);
    await c.request("resume");
    const estimate = (n * this.manifest!.cycleMs) / this.timeScale;
    const loc = await this.waitForStop(estimate * 5 + 15_000, false);
    if (!o.keepHarness || !loc?.harness) await this.setHarnessBreakpoint(0);
    if (!loc) await this.ensurePaused();
    const scan = await this.scan();
    return { loc, ran: scan - before, scan };
  }

  async runScans(n: number): Promise<string> {
    if (!Number.isInteger(n) || n < 1) throw new SimError("bad_args", "n must be a positive whole number of scans.");
    return this.busy(`Running ${n} scan(s) (${fmtS(n * (this.manifest?.cycleMs ?? 0))} simulated)`, async () => {
      const { loc, ran } = await this.runScansRaw(n);
      const early = loc && !loc.harness;
      this.journal.add(early ? "stopped" : "ran", early ? `Stopped after ${ran} scan(s)` : `Ran ${ran} scan(s)`, { ran, ...(early ? { obj: loc.obj, line: loc.line } : {}) });
      await this.record();
      return `${early ? `Stopped early after ${ran} of ${n} scan(s).` : `Ran ${ran} scan(s) (${fmtS(ran * this.manifest!.cycleMs)} simulated).`}\n${await this.where(loc, { locals: !!early })}`;
    });
  }

  /** Mark what the simulation is busy with (shown in the panel) while fn runs. */
  private async busy<T>(text: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.activity;
    this.activity = text;
    try {
      return await fn();
    } finally {
      this.activity = prev;
    }
  }

  async setTimeScale(speed: number): Promise<void> {
    if (!(speed >= 1)) throw new SimError("bad_args", "speed must be >= 1");
    await this.ctl().request("config.set", { "simulation.time_scale": speed });
    this.timeScale = speed;
  }

  async runFor(seconds: number, speed?: number): Promise<string> {
    if (speed) await this.setTimeScale(speed);
    const n = Math.max(1, Math.round((seconds * 1000) / this.manifest!.cycleMs));
    return this.runScans(n);
  }

  async cont(timeoutMs: number): Promise<string> {
    return this.busy("Running until a breakpoint", async () => {
      const c = this.ctl();
      await c.request("debug.stops");
      await c.request("resume");
      const loc = await this.waitForStop(timeoutMs, true);
      if (!loc) {
        await this.ensurePaused();
        await this.record();
        const scan = await this.scan();
        return `No breakpoint was hit within ${fmtS(timeoutMs)} of wall time; paused at scan ${scan} (sim time ${fmtS(scan * this.manifest!.cycleMs)}).`;
      }
      this.journal.add("stopped", `Stopped at ${loc.obj ?? loc.file}:${loc.line ?? loc.line0 + 1}`, { reason: loc.reason, obj: loc.obj, line: loc.line });
      await this.record();
      return this.where(loc);
    });
  }

  async step(kind: "step_over" | "step_in" | "step_out"): Promise<string> {
    const c = this.ctl();
    const st = await c.request<{ paused: boolean }>("debug.state");
    if (!st.paused) throw new SimError("not_paused", "Stepping needs a paused simulation; set a breakpoint and call continue first.");
    await c.request("debug.stops");
    await c.request(kind);
    const loc = await this.waitForStop(10_000, false);
    this.journal.add("stepped", `${kind} -> ${loc?.obj ?? loc?.file ?? "?"}:${loc?.line ?? ""}`, { obj: loc?.obj, line: loc?.line });
    if (loc?.harness) return `The scan ended; ${await this.where(loc)}`;
    return this.where(loc);
  }

  // ------------------------------------------------------------ breakpoints

  async setBreakpoint(obj: string, line: number, condition?: string, part: "decl" | "impl" = "impl"): Promise<string> {
    if (!this.manifest) throw new SimError("no_mirror", "No mirror yet. Call sync_mirror or sim_start first.");
    if (condition) parseExpr(condition);
    const files = this.files();
    const exact = Object.values(this.manifest.map).some((m) => m.some((o) => o?.obj.toLowerCase() === obj.toLowerCase()));
    if (!exact) throw new SimError("not_found", `${obj} is not in the mirror. Use a path like PRG_Tank or FB_PI/Reset (sync_mirror after changes).`);
    const max = partLines(files, obj, part);
    if (line < 1 || line > max) throw new SimError("bad_line", `${obj} has ${max} ${part === "impl" ? "implementation" : "declaration"} line(s).`);
    const m = toMirror(files, obj, line, part)!;
    const bp: Breakpoint = { id: this.nextBp++, obj: files.flatMap((f) => f.map).find((o) => o?.obj.toLowerCase() === obj.toLowerCase())!.obj, part, line, file: m.path, line0: m.line0, condition };
    this.breakpoints.set(bp.id, bp);
    let note = "";
    if (this.running) {
      const r = await this.pushBreakpoints(bp.file);
      const resolved = r.find((x) => x.requested === bp.line0);
      if (!resolved || resolved.line0 === undefined) {
        this.breakpoints.delete(bp.id);
        await this.pushBreakpoints(bp.file);
        throw new SimError("no_statement", `No statement at ${obj} line ${line}; pick a line with code.`);
      }
      if (resolved.line0 !== bp.line0) {
        const o = fromMirror(files, bp.file, resolved.line0);
        bp.line0 = resolved.line0;
        if (o) bp.line = o.line;
        note = ` (moved to the statement starting at line ${bp.line})`;
      }
    } else note = " (applies when the simulation starts)";
    this.journal.add("breakpoint_set", `Breakpoint #${bp.id} at ${bp.obj}:${bp.line}${condition ? ` if ${condition}` : ""}`, { id: bp.id, obj: bp.obj, line: bp.line, condition });
    return `Breakpoint #${bp.id} at ${bp.obj} line ${bp.line}${condition ? `, condition: ${condition}` : ""}${note}.`;
  }

  async clearBreakpoint(sel: { id?: number; obj?: string; line?: number; all?: boolean }): Promise<string> {
    const hit = [...this.breakpoints.values()].filter(
      (b) => sel.all || b.id === sel.id || (sel.obj && b.obj.toLowerCase() === sel.obj.toLowerCase() && (sel.line === undefined || b.line === sel.line)),
    );
    if (!hit.length) return "No matching breakpoint.";
    const files = new Set(hit.map((b) => b.file));
    for (const b of hit) this.breakpoints.delete(b.id);
    if (this.running) for (const f of files) await this.pushBreakpoints(f);
    this.journal.add("breakpoint_cleared", `Cleared ${hit.map((b) => `#${b.id}`).join(", ")}`);
    return `Cleared ${hit.map((b) => `#${b.id} (${b.obj}:${b.line})`).join(", ")}.`;
  }

  private async pushBreakpoints(file: string): Promise<{ requested: number; line0?: number }[]> {
    const bps = [...this.breakpoints.values()].filter((b) => b.file === file).sort((a, b) => a.line0 - b.line0);
    const lines = [...new Set(bps.map((b) => b.line0))];
    const r = await this.ctl().request<{ resolved: { line: number }[] }>("breakpoints.set", { source: file, lines });
    // truST answers one resolved entry per line it could place, in order.
    return lines.map((l, i) => ({ requested: l, line0: r.resolved[i]?.line }));
  }

  private async pushAllBreakpoints(): Promise<void> {
    for (const f of new Set([...this.breakpoints.values()].map((b) => b.file))) await this.pushBreakpoints(f);
  }

  private async silenceBreakpoints(on: boolean): Promise<void> {
    for (const f of new Set([...this.breakpoints.values()].map((b) => b.file))) {
      if (on) await this.ctl().request("breakpoints.set", { source: f, lines: [] });
      else await this.pushBreakpoints(f);
    }
  }

  // ------------------------------------------------------------ variables

  async readVars(names: string[]): Promise<string> {
    const out: string[] = [];
    for (const n of names) {
      try {
        out.push(`${n} = ${formatValue(await this.readValue(n))}`);
      } catch (e) {
        const msg = (e as Error).message;
        out.push(`${n}: ${/unknown identifier/i.test(msg) ? "unknown (check the path; property values can't be read in the simulation yet, read the backing variable)" : msg}`);
      }
    }
    return out.join("\n");
  }

  /** The I/O address of a plant-wired variable (its value comes from the I/O image). */
  private ioAddress(name: string): string | undefined {
    return this.manifest?.addresses[name.toLowerCase()];
  }

  /** Force (or release) a variable; plant-wired variables are forced on their I/O address. */
  private async rawForce(name: string, value?: string): Promise<void> {
    const c = this.ctl();
    const address = this.ioAddress(name);
    if (value === undefined) {
      if (address) await c.request("io.unforce", { address });
      else await c.request("var.unforce", { target: `global:${name}` });
    } else if (address) await c.request("io.force", { address, value: toTrustLiteral(value) });
    else await c.request("var.force", { target: `global:${name}`, value: toTrustLiteral(value) });
  }

  private async rawWrite(name: string, value: string): Promise<void> {
    await this.ctl().request("set", { target: `global:${name}`, value: toTrustLiteral(value) });
  }

  async writeVar(name: string, value: string): Promise<string> {
    await this.rawWrite(name, value);
    this.journal.add("var_written", `${name} := ${value}`, { name, value });
    const note = this.ioAddress(name) ? " The plant drives this variable each scan, so use force_var to hold a value." : "";
    return `${name} := ${value} (applied at the start of the next scan).${note}`;
  }

  async forceVar(name: string, value: string): Promise<string> {
    await this.rawForce(name, value);
    this.forced.add(name);
    this.journal.add("var_forced", `${name} forced to ${value}`, { name, value });
    const a = this.ioAddress(name);
    return `${name}${a ? ` (${a})` : ""} forced to ${value} until unforce_var.`;
  }

  async unforceVar(name: string): Promise<string> {
    await this.rawForce(name);
    this.forced.delete(name);
    this.journal.add("var_unforced", `${name} released`, { name });
    return `${name} released.`;
  }

  // ------------------------------------------------------------ plant

  async setPlantParam(plant: string, key: string, value: unknown): Promise<string> {
    if (!this.plant) throw new SimError("no_plant", "No plant.toml is loaded. Pass plant text to sync_mirror first.");
    const o: ParamOverride = { plant, key, value };
    applyOverride(structuredClone(this.plant), o);
    this.overrides = this.overrides.filter((x) => !(x.plant.toLowerCase() === plant.toLowerCase() && x.key === key));
    this.overrides.push(o);
    this.journal.add("plant_param", `${plant}.${key} = ${JSON.stringify(value)}`, { plant, key, value });
    // truST never hot-replaces a plant: a parameter change needs a restart.
    if (this.mirrorDir && this.manifest) {
      const addresses = new Map(Object.entries(this.manifest.addresses));
      await writeFile(join(this.mirrorDir, "simulation.toml"), simulationToml(this.effectivePlant(), { timeScale: this.timeScale, traceCapacity: 1000, addresses }), "utf8");
    }
    if (this.running) {
      await this.start({ sync: false });
      return `${plant}.${key} = ${JSON.stringify(value)}. truST applies plant changes only on restart, so the simulation restarted from scan 0 (PLC and plant state reset).`;
    }
    return `${plant}.${key} = ${JSON.stringify(value)} (applies at sim_start).`;
  }

  // ------------------------------------------------------------ experiments

  async runExperiment(spec: ExperimentSpec): Promise<string> {
    if (!(spec.duration_s > 0)) throw new SimError("bad_args", "duration_s must be > 0");
    this.ctl();
    return (await this.runExperimentResult(spec)).summary;
  }

  /** Run an experiment and return the full result (metrics, watched-variable statistics, samples). */
  async runExperimentResult(spec: ExperimentSpec): Promise<ExperimentResult> {
    if (!(spec.duration_s > 0)) throw new SimError("bad_args", "duration_s must be > 0");
    this.ctl();
    return this.busy(`Experiment "${spec.name ?? `experiment ${this.experiments.length + 1}`}" starting`, () => this.experimentImpl(spec));
  }

  private async experimentImpl(spec: ExperimentSpec): Promise<ExperimentResult> {
    const label = spec.name ?? `experiment ${this.experiments.length + 1}`;
    const cycle = this.manifest!.cycleMs;
    const total = Math.max(1, Math.round((spec.duration_s * 1000) / cycle));
    const samples = Math.min(Math.max(spec.samples ?? 200, 10), 2000);
    const every = Math.max(1, Math.round(total / samples));
    const toScan = (s: number | undefined) => Math.min(total, Math.max(0, Math.round(((s ?? 0) * 1000) / cycle)));

    await this.ensurePaused();
    await this.silenceBreakpoints(true);
    const prevScale = this.timeScale;
    try {
      if (spec.restart !== false) await this.freshStart();
      await this.setTimeScale(spec.speed ?? 100);
      for (const [k, v] of Object.entries(spec.set ?? {})) await this.rawWrite(k, String(v));

      type Ev = { at: number; run: () => Promise<void> };
      const events: Ev[] = [];
      if (spec.sp) {
        const sp = spec.sp;
        events.push({ at: toScan(sp.at_s), run: () => this.rawWrite(sp.var, String(sp.value)) });
      }
      for (const f of spec.force ?? []) {
        events.push({ at: toScan(f.at_s), run: () => this.rawForce(f.var, String(f.value)) });
        events.push({ at: f.until_s !== undefined ? toScan(f.until_s) : total, run: () => this.rawForce(f.var) });
      }
      events.sort((a, b) => a.at - b.at);

      const own = [...new Set([spec.pv, spec.sp?.var, ...(spec.watch ?? [])].filter((x): x is string => !!x))];
      this.experimentSignals = own;
      const watched = [...new Set([...own, ...this.panelSignals().map((s) => s.name)])];
      const rows: { t: number; values: Record<string, number | null>; raw: Record<string, string> }[] = [];
      const sample = async (scan: number) => {
        const values: Record<string, number | null> = {};
        const raw: Record<string, string> = {};
        this.activity = `Experiment "${label}": ${((scan * cycle) / 1000).toFixed(0)} of ${spec.duration_s} s simulated`;
        for (const w of watched) {
          try {
            const v = await this.readValue(w);
            values[w] = numeric(v) ?? null;
            raw[w] = formatValue(v);
          } catch {
            values[w] = null;
            raw[w] = "?";
          }
        }
        rows.push({ t: (scan * cycle) / 1000, values: Object.fromEntries(own.map((w) => [w, values[w] ?? null])), raw });
        this.recorder.add(((startScan + scan) * cycle) / 1000, values);
      };

      let scan = 0;
      let lastScan = await this.scan();
      const startScan = lastScan;
      const runEvents = async () => {
        while (events.length && events[0]!.at <= scan) await events.shift()!.run();
      };
      await runEvents();
      await sample(0);
      const t0 = Date.now();
      while (scan < total) {
        const nextEvent = events.length ? events[0]!.at : total;
        const target = Math.min(total, scan + every, Math.max(nextEvent, scan + 1));
        const r = await this.runScansRaw(target - scan, { keepHarness: true, before: lastScan });
        if (r.ran <= 0) throw new SimError("stalled", "The simulation did not advance.");
        if (r.loc && !r.loc.harness) throw new SimError("stopped", `The experiment stopped unexpectedly at ${r.loc.obj ?? r.loc.file}:${r.loc.line ?? r.loc.line0 + 1} (${r.loc.reason}).`);
        lastScan = r.scan;
        scan += target - scan;
        await sample(scan);
        await runEvents();
        if (Date.now() - t0 > 600_000) throw new SimError("timeout", "The experiment took more than 10 minutes of wall time; use a higher speed or fewer samples.");
      }

      const n = this.experiments.length + 1;
      const name = spec.name ?? `experiment ${n}`;
      const metrics = analyse(rows, spec);
      const watch: Record<string, string> = {};
      const watchStats: ExperimentResult["watchStats"] = {};
      for (const w of spec.watch ?? []) {
        watch[w] = describeSeries(rows, w);
        const nums = rows.map((r) => r.values[w]).filter((v): v is number => typeof v === "number");
        const last = rows.at(-1);
        watchStats[w] = {
          final: typeof last?.values[w] === "number" ? last.values[w] : null,
          finalText: last?.raw[w] ?? "?",
          min: nums.length ? Math.min(...nums) : null,
          max: nums.length ? Math.max(...nums) : null,
        };
      }
      const prev = [...this.experiments].reverse().find((e) => e.name === name || (spec.pv && e.spec.pv === spec.pv));
      const summary = summarize(name, spec, metrics, watch, prev, Date.now() - t0);
      const result: ExperimentResult = { n, name, at: new Date().toISOString(), spec, metrics, watch, watchStats, samples: rows.map(({ t, values }) => ({ t, values })), summary };
      this.experiments.push(result);
      this.journal.add("experiment", summary.split("\n")[0]!, { n, name, metrics });
      if (this.mirrorDir) await appendFile(join(this.mirrorDir, "experiments.jsonl"), JSON.stringify({ ...result, samples: undefined }) + "\n", "utf8").catch(() => undefined);
      return result;
    } finally {
      this.experimentSignals = [];
      await this.setHarnessBreakpoint(0).catch(() => undefined);
      await this.setTimeScale(prevScale).catch(() => undefined);
      await this.silenceBreakpoints(false).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------ tests

  private lastTests?: PanelState["tests"];

  /**
   * Run the project's tests (POUs marked {attribute 'test'}) in truST.
   * Separate from the simulation: it doesn't stop or change a running one.
   */
  async runTests(o: { filter?: string; sync?: boolean; timeoutS?: number } = {}): Promise<{ text: string; ok: boolean; run?: TestRun }> {
    if (o.sync !== false) await this.sync();
    else if (!this.manifest) {
      const dir = this.mirrorFolder();
      this.manifest = await readManifest(dir);
      if (!this.manifest) throw new SimError("no_mirror", "No mirror yet. Call sync_mirror first.");
      this.mirrorDir = dir;
    }
    const declared = this.manifest!.tests ?? [];
    if (!declared.length) {
      return {
        ok: true,
        text: [
          "No tests in the project. A test is a PROGRAM (or FUNCTION_BLOCK) whose declaration starts with {attribute 'test'}, for example:",
          "  {attribute 'test'}",
          "  PROGRAM T_PI_Proportional",
          "  VAR fb : FB_PI; END_VAR",
          "  fb(bEnable := TRUE, rPV := 0.5, rSP := 1.0);",
          "  ASSERT_NEAR(EXPECTED := 25.0, ACTUAL := fb.rY, DELTA := 0.5);",
          "Nothing calls it, so CODESYS doesn't compile it; run_tests runs it in truST.",
        ].join("\n"),
      };
    }
    const run = await this.busy("Running tests", () => this.getRuntime().test(this.mirrorDir!, { filter: o.filter, timeoutS: o.timeoutS }));
    if (!run.ran) {
      const mapped = run.diagnostics.length ? await this.mapDiagnostics(run.diagnostics) : [run.output.split("\n").slice(-15).join("\n")];
      this.journal.add("tests", "Tests could not be built", { errors: mapped.length });
      return { ok: false, run, text: `The tests could not be built:\n${mapped.join("\n")}` };
    }
    const objOf = (t: TestRun["tests"][number]) => {
      const byName = declared.find((d) => d.name.toLowerCase() === t.name.toLowerCase());
      if (byName) return byName.path;
      return t.file && t.line ? (fromMirror(this.files(), t.file, t.line - 1)?.obj ?? t.name) : t.name;
    };
    const failing = run.tests.filter((t) => t.status !== "passed");
    const lines = [
      `Tests: ${run.passed} passed, ${run.failed} failed${run.errors ? `, ${run.errors} error(s)` : ""} (${run.total} total, ${fmtS(run.durationMs)}).${o.filter ? ` Filter: "${o.filter}".` : ""}`,
      ...failing.map((t) => `FAIL ${objOf(t)}: ${t.message ?? t.status}`),
      ...run.tests.filter((t) => t.status === "passed").map((t) => `pass ${objOf(t)}`),
    ];
    if (failing.length) lines.push("Note: truST reports the test, not the failing assertion line yet (TRUST-GAPS T2), and time doesn't advance inside a test (T1).");
    this.lastTests = { at: new Date().toISOString(), total: run.total, passed: run.passed, failed: run.failed + run.errors, failing: failing.map(objOf) };
    this.journal.add("tests", `Tests: ${run.passed} passed, ${run.failed + run.errors} failed`, { total: run.total, failing: this.lastTests.failing });
    return { ok: failing.length === 0, run, text: lines.join("\n") };
  }

  // ------------------------------------------------------------ panel (read-only)

  /** The signals the panel shows: plant wiring, device feedback, the running experiment. */
  panelSignals(): { name: string; role: SignalRole; plant?: string }[] {
    const out = new Map<string, { name: string; role: SignalRole; plant?: string }>();
    const plant = this.effectivePlant();
    for (const p of plant?.plants ?? []) {
      for (const v of p.outputs) out.set(v.toLowerCase(), { name: v, role: "plant_out", plant: p.id });
      for (const v of p.inputs) out.set(v.toLowerCase(), { name: v, role: "plant_in", plant: p.id });
    }
    for (const f of plant?.feedback ?? []) {
      if (!out.has(f.follows.toLowerCase())) out.set(f.follows.toLowerCase(), { name: f.follows, role: "command" });
      out.set(f.signal.toLowerCase(), { name: f.signal, role: "feedback" });
    }
    for (const v of this.experimentSignals) if (!out.has(v.toLowerCase())) out.set(v.toLowerCase(), { name: v, role: "experiment" });
    return [...out.values()];
  }

  /** Record one trend sample of the panel signals (best effort). */
  private async record(values?: Record<string, number | null>): Promise<void> {
    if (!this.running || !this.manifest) return;
    try {
      const scan = await this.scan();
      if (!values) {
        values = {};
        for (const s of this.panelSignals()) {
          try {
            values[s.name] = numeric(await this.readValue(s.name)) ?? null;
          } catch {
            values[s.name] = null;
          }
        }
      }
      this.recorder.add((scan * this.manifest.cycleMs) / 1000, values);
    } catch {
      /* the panel's trend is best effort */
    }
  }

  /**
   * A snapshot for the panel. Read-only towards the runtime: it never drains
   * stop records or changes the run state, so it is safe while a tool runs.
   */
  async panelState(): Promise<Omit<PanelState, "current">> {
    const plant = this.effectivePlant();
    const base: Omit<PanelState, "current"> = {
      status: "stopped",
      project: this.codesys.projectPath(),
      trust: this.trustVersion,
      scan: 0,
      simTime: 0,
      timeScale: this.timeScale,
      cycleMs: this.manifest?.cycleMs,
      activity: this.activity,
      breakpoints: [...this.breakpoints.values()].map((b) => ({ id: b.id, obj: b.obj, line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
      signals: this.panelSignals().map((s) => ({ ...s, address: this.ioAddress(s.name), forced: this.forced.has(s.name) })),
      plants: (plant?.plants ?? []).map((p) => ({ id: p.id, model: p.model, inputs: p.inputs, outputs: p.outputs, ...(p.display ? { display: p.display } : {}) })),
      feedback: plant?.feedback ?? [],
      experiments: this.experiments.map((e) => ({ n: e.n, name: e.name, at: e.at, metrics: e.metrics })),
      ...(this.lastTests ? { tests: this.lastTests } : {}),
      journalSeq: this.journal.last,
      trendEpoch: this.recorder.epoch,
      warnings: this.manifest?.warnings ?? [],
      ...(this.runtime?.exitInfo && !this.running ? { exitInfo: this.runtime.exitInfo } : {}),
    };
    if (!base.project) return { ...base, status: "no_project" };
    if (!this.manifest) return { ...base, status: "no_mirror" };
    if (!this.running) return base;
    try {
      const st = await this.ctl().request<{ paused: boolean; last_stop?: { path?: string; line?: number; reason: string } | null }>("debug.state");
      const scan = await this.scan();
      const values: Record<string, number | null> = {};
      for (const s of base.signals) {
        try {
          const v = await this.readValue(s.name);
          s.value = formatValue(v);
          s.num = numeric(v) ?? null;
        } catch {
          s.value = "?";
          s.num = null;
        }
        values[s.name] = s.num ?? null;
      }
      if (!st.paused) this.recorder.add((scan * this.manifest.cycleMs) / 1000, values);
      let location: PanelLocation | undefined;
      if (st.paused && st.last_stop) {
        const l = this.locate(st.last_stop);
        location = { reason: l.reason, harness: l.harness, ...(l.obj ? { obj: l.obj, part: l.part, line: l.line } : {}), ...(l.breakpoint ? { breakpoint: l.breakpoint.id } : {}) };
      }
      return { ...base, status: st.paused ? "paused" : "running", scan, simTime: (scan * this.manifest.cycleMs) / 1000, location, trendEpoch: this.recorder.epoch };
    } catch {
      return base;
    }
  }

  /**
   * Locals and call stack while paused inside user code (read-only; for the
   * workspace inspector and inline values).
   */
  async panelLocals(): Promise<{ paused: boolean; stack: { obj?: string; line?: number; name: string }[]; locals: { name: string; type: string; value: string; expandable: boolean }[] }> {
    if (!this.running) return { paused: false, stack: [], locals: [] };
    const c = this.ctl();
    const st = await c.request<{ paused: boolean; last_stop?: { path?: string } | null }>("debug.state");
    if (!st.paused || !st.last_stop || (st.last_stop.path ?? "").toLowerCase().endsWith(HARNESS_FILE.toLowerCase())) return { paused: st.paused, stack: [], locals: [] };
    const frames = await c.request<{ stack_frames: { name: string; line: number; source?: { path?: string } }[] }>("debug.stack").catch(() => ({ stack_frames: [] }));
    const stack = frames.stack_frames.map((f) => {
      const o = f.source?.path ? fromMirror(this.files(), f.source.path, f.line) : undefined;
      return o ? { obj: o.obj, line: o.line, name: f.name } : { name: f.name };
    });
    const sc = await c.request<{ scopes: { name: string; variablesReference: number }[] }>("debug.scopes", { frame_id: 1 }).catch(() => ({ scopes: [] }));
    const ref = sc.scopes.find((s) => s.name === "Locals")?.variablesReference;
    if (!ref) return { paused: true, stack, locals: [] };
    const v = await c.request<{ variables: { name: string; type: string; value: string; variablesReference: number }[] }>("debug.variables", { variables_reference: ref });
    return { paused: true, stack, locals: v.variables.map((x) => ({ name: x.name, type: x.type, value: this.asCodesys(x.value), expandable: x.variablesReference > 0 })) };
  }

  /** Values of chosen variables (watch list). */
  async panelValues(names: string[]): Promise<Record<string, { value?: string; num?: number | null; error?: string }>> {
    const out: Record<string, { value?: string; num?: number | null; error?: string }> = {};
    if (!this.running) return out;
    for (const n of names.slice(0, 50)) {
      try {
        const v = await this.readValue(n);
        out[n] = { value: formatValue(v), num: numeric(v) ?? null };
      } catch (e) {
        out[n] = { error: /unknown identifier/i.test((e as Error).message) ? "unknown" : (e as Error).message };
      }
    }
    return out;
  }

  /** The mirror file holding an object (or the current stop, or the first program), as CODESYS lines. */
  async sourceView(obj?: string): Promise<SourceView | undefined> {
    if (!this.manifest) return undefined;
    const files = this.files().filter((f) => f.path !== HARNESS_FILE && f.path !== "src/Configuration.st");
    let file: (typeof files)[number] | undefined;
    if (obj) {
      const key = obj.toLowerCase();
      file = files.find((f) => f.map.some((o) => o?.obj.toLowerCase() === key));
    }
    if (!file) {
      // Default: the first program a task runs (from the generated configuration).
      const cfg = await this.sourceLines("src/Configuration.st");
      const progs = cfg.map((l) => /^\s*PROGRAM\s+(\w+)\s+WITH/i.exec(l)?.[1]).filter((p): p is string => !!p && p !== HARNESS);
      for (const p of progs) {
        file = files.find((f) => f.map.some((o) => o?.obj.toLowerCase() === p.toLowerCase()));
        if (file) break;
      }
    }
    file ??= files.find((f) => f.map.some((o) => o?.part === "impl"));
    if (!file) return undefined;
    const text = await this.sourceLines(file.path);
    const title = file.map.find((o) => o)?.obj.split("/")[0] ?? file.path;
    return {
      file: file.path,
      title,
      lines: text.slice(0, text.at(-1) === "" ? -1 : undefined).map((t, i) => {
        const o = file!.map[i];
        return o ? { text: this.asCodesys(t), obj: o.obj, part: o.part, line: o.line } : { text: t };
      }),
    };
  }

  trend(epoch: number, since: number): { epoch: number; points: TrendPoint[]; reset: boolean } {
    return this.recorder.since(epoch, since);
  }

  // ------------------------------------------------------------ scenarios

  /** `<Project>.scenarios.toml` next to the project. */
  scenariosFile(project = this.codesys.projectPath()): string {
    if (!project) throw new SimError("no_project", "No CODESYS project is open. Call open_project first.");
    return join(dirname(project), basename(project).replace(/\.project$/i, "") + ".scenarios.toml");
  }

  async loadScenarios(): Promise<Scenario[]> {
    const f = this.scenariosFile();
    if (!existsSync(f)) return [];
    return parseScenarios(await readFile(f, "utf8"));
  }

  /** Add or replace a scenario by name (or delete it). */
  async saveScenario(s: Scenario, o: { delete?: boolean } = {}): Promise<string> {
    const list = await this.loadScenarios();
    const i = list.findIndex((x) => x.name.toLowerCase() === s.name.toLowerCase());
    if (o.delete) {
      if (i < 0) return `No scenario '${s.name}'.`;
      list.splice(i, 1);
    } else {
      const v = validateScenario(s as unknown as Record<string, unknown>);
      if (i >= 0) list[i] = v;
      else list.push(v);
    }
    const f = this.scenariosFile();
    await writeFile(f, stringifyScenarios(list), "utf8");
    return `${o.delete ? "Deleted" : i >= 0 ? "Updated" : "Saved"} scenario '${s.name}' in ${f} (${list.length} scenario(s)).`;
  }

  /** Run the saved scenarios (starting the simulation if needed) and check their expectations. */
  async runScenarios(o: { filter?: string } = {}): Promise<{ ok: boolean; text: string }> {
    let list = await this.loadScenarios();
    if (o.filter) list = list.filter((s) => s.name.toLowerCase().includes(o.filter!.toLowerCase()));
    if (!list.length) {
      return { ok: true, text: o.filter ? `No scenario matches '${o.filter}'.` : "No scenarios yet. Save one with save_scenario (an experiment plus expectations)." };
    }
    const notes: string[] = [];
    if (!this.running) {
      await this.start({ sync: true });
      notes.push("Started the simulation (mirror synced).");
    }
    const lines: string[] = [];
    let passed = 0;
    for (const s of list) {
      const { expect, ...spec } = s;
      const r = await this.runExperimentResult(spec);
      const checks = checkExpectations(expect, r.metrics, r.watchStats);
      const ok = checks.every((c) => c.ok);
      if (ok) passed++;
      lines.push(`${ok ? "PASS" : "FAIL"} ${s.name}${checks.length ? "" : " (no expectations)"}`);
      for (const c of checks) lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.text}`);
    }
    const failed = list.length - passed;
    this.journal.add("experiment", `Scenarios: ${passed} passed, ${failed} failed`, { passed, failed });
    return { ok: failed === 0, text: [...notes, `Scenarios: ${passed} passed, ${failed} failed (${list.length} total).`, ...lines].join("\n") };
  }

  experimentLog(): string {
    if (!this.experiments.length) return "No experiments yet.";
    return this.experiments.map((e) => `#${e.n} ${e.name} (${e.at}): ${Object.entries(e.metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`).join("\n");
  }
}

// ------------------------------------------------------------ analysis

type Row = { t: number; values: Record<string, number | null> };

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function analyse(rows: Row[], spec: ExperimentSpec): Record<string, number | string | null> {
  const m: Record<string, number | string | null> = {};
  if (!spec.pv) return m;
  const pv = rows.map((r) => ({ t: r.t, y: r.values[spec.pv!] })).filter((p): p is { t: number; y: number } => p.y !== null && p.y !== undefined);
  if (!pv.length) return { error: `no numeric values for ${spec.pv}` };
  m.pv_min = round(Math.min(...pv.map((p) => p.y)), 4);
  m.pv_max = round(Math.max(...pv.map((p) => p.y)), 4);
  m.pv_final = round(pv.at(-1)!.y, 4);
  const r = spec.sp ? Number(spec.sp.value) : NaN;
  if (!spec.sp || !Number.isFinite(r)) return m;
  const ts = spec.sp.at_s ?? 0;
  const after = pv.filter((p) => p.t >= ts);
  const y0 = (pv.filter((p) => p.t <= ts).at(-1) ?? pv[0]!).y;
  const step = r - y0;
  m.setpoint = r;
  m.start = round(y0, 4);
  if (Math.abs(step) < 1e-12) return m;
  const dir = Math.sign(step);
  const peak = dir > 0 ? Math.max(...after.map((p) => p.y)) : Math.min(...after.map((p) => p.y));
  m.overshoot_pct = round(Math.max(0, ((peak - r) * dir) / Math.abs(step)) * 100, 2);
  const at = (frac: number) => after.find((p) => (p.y - y0) * dir >= Math.abs(step) * frac)?.t;
  const t10 = at(0.1);
  const t90 = at(0.9);
  m.rise_time_s = t10 !== undefined && t90 !== undefined ? round(t90 - t10, 3) : null;
  const band = 0.02 * Math.abs(step);
  const lastOut = [...after].reverse().find((p) => Math.abs(p.y - r) > band);
  m.settling_time_s = !lastOut ? 0 : lastOut === after.at(-1) ? null : round(after[after.indexOf(lastOut) + 1]!.t - ts, 3);
  const tail = after.slice(Math.floor(after.length * 0.9));
  m.steady_state_error = round(r - tail.reduce((s, p) => s + p.y, 0) / tail.length, 4);
  let iae = 0;
  for (let i = 1; i < after.length; i++) iae += Math.abs(r - after[i]!.y) * (after[i]!.t - after[i - 1]!.t);
  m.iae = round(iae, 4);
  return m;
}

function describeSeries(rows: (Row & { raw?: Record<string, string> })[], name: string): string {
  const vals = rows.map((r) => r.values[name]);
  const raw = rows.map((r) => r.raw?.[name] ?? String(r.values[name]));
  const changes: string[] = [];
  for (let i = 1; i < rows.length; i++) if (raw[i] !== raw[i - 1]) changes.push(`${raw[i]} at ${rows[i]!.t.toFixed(2)} s`);
  const nums = vals.filter((v): v is number => typeof v === "number");
  if (nums.length && new Set(raw).size > 6) {
    return `start ${raw[0]}, end ${raw.at(-1)}, min ${round(Math.min(...nums), 4)}, max ${round(Math.max(...nums), 4)}`;
  }
  return `start ${raw[0]}${changes.length ? `; changed: ${changes.slice(0, 6).join(", ")}${changes.length > 6 ? `, ... (${changes.length} changes)` : ""}` : "; no change"}`;
}

function summarize(name: string, spec: ExperimentSpec, m: Record<string, number | string | null>, watch: Record<string, string>, prev: ExperimentResult | undefined, wallMs: number): string {
  const out = [`Experiment "${name}": ${spec.duration_s} s simulated in ${fmtS(wallMs)} wall time${spec.restart === false ? "" : " (fresh start)"}.`];
  const setTxt = Object.entries(spec.set ?? {}).map(([k, v]) => `${k}=${v}`);
  if (setTxt.length) out.push(`Settings: ${setTxt.join(", ")}`);
  if (spec.sp) out.push(`Step: ${spec.sp.var} -> ${spec.sp.value} at ${spec.sp.at_s ?? 0} s`);
  for (const f of spec.force ?? []) out.push(`Force: ${f.var} = ${f.value} from ${f.at_s ?? 0} s${f.until_s !== undefined ? ` to ${f.until_s} s` : ""}`);
  if (spec.pv) {
    const label: Record<string, string> = {
      overshoot_pct: "overshoot %",
      rise_time_s: "rise time (10-90%) s",
      settling_time_s: "settling time (2%) s",
      steady_state_error: "steady-state error",
      iae: "IAE",
      pv_min: "min",
      pv_max: "max",
      pv_final: "final",
      start: "value at the step",
      setpoint: "setpoint",
      error: "error",
    };
    out.push(`${spec.pv}:`);
    for (const [k, v] of Object.entries(m)) {
      let line = `  ${label[k] ?? k}: ${v === null ? (k === "settling_time_s" ? "not settled" : "n/a") : v}`;
      const pv = prev?.metrics[k];
      if (typeof v === "number" && typeof pv === "number" && pv !== v) line += ` (was ${pv})`;
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(watch)) out.push(`${k}: ${v}`);
  if (prev) out.push(`Compared with #${prev.n} ${prev.name}.`);
  return out.join("\n");
}
