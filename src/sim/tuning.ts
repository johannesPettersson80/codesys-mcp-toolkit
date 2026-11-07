/**
 * Loop tuning with truST's Control Studio (`trust-control-studio`), on the
 * simulation's mirror: set up a loop from the program's own variables,
 * identify the plant with a setpoint step (or a manual output step) while
 * the simulation runs freely,
 * search the program's own controller coefficients against the fitted model,
 * and validate the candidate with the actual ST in isolated runs.
 *
 * Control Studio never writes to the CODESYS project. The gains it finds are
 * a proposal: Claude changes them in CODESYS (write_object), so CODESYS stays
 * the source of truth.
 *
 * Built against truST 0.34.0; the workarounds for its gaps are marked with
 * their TRUST-GAPS ids (S5, S6, S9, S10, S11, S12).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TuningLoop, TuningTrace } from "./panel-types.js";
import type { StudioAnswer, TrustRuntime } from "./runtime.js";

/** What the tuning needs from the simulation controller. */
export interface TuningHost {
  /** Start the simulation (sync, build) if it isn't running; returns what it did. */
  ensureStarted(): Promise<string | undefined>;
  /** The mirror folder (the truST project). */
  mirrorPath(): string | undefined;
  trust(): TrustRuntime;
  /** Run fn while the simulation runs freely at `speed` (breakpoints off); paused at a scan start after. */
  freeRun<T>(label: string, speed: number, fn: () => Promise<T>): Promise<T>;
  /** Mark the simulation busy (shown in the panel) while fn runs. */
  runBusy<T>(label: string, fn: () => Promise<T>): Promise<T>;
  journal: { add(kind: string, text: string, data?: Record<string, unknown>): void };
}

export class TuningError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Range {
  symbol: string;
  unit?: string;
  min: number;
  max: number;
}

export interface Requirements {
  reference_change?: number;
  maximum_error?: number;
  settling_band?: number;
  settling_time_s?: number;
  duration_s?: number;
  maximum_overshoot_pct?: number;
  transfer_tolerance?: number;
}

export interface SetupArgs {
  name: string;
  pv: Range;
  sp: string;
  mv: Range;
  mode: { symbol: string; true_means: "Manual" | "Auto" };
  manual_output: string;
  coefficients: { symbol: string; values: number[]; unit?: string }[];
  startup_flag?: string;
  action?: "direct" | "reverse";
  family?: string;
  /** The output step when identifying with method "step" (S12: keep it small). */
  step?: number;
  /** How long the identification step runs, in simulated seconds. */
  experiment_s?: number;
  requirements?: Requirements;
  replace?: boolean;
}

/** truST's loop-id slug: "LT101 level" -> "lt101-level". */
export function loopSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function loopIdOf(name: string): string {
  return `loop:${loopSlug(name)}`;
}

const firstName = (symbol: string) => symbol.split(".")[0] ?? symbol;

/**
 * S9: Control Studio 0.34 needs every loop signal in one PROGRAM instance;
 * GVL members (`GVL_IO.x`) fail at Identify. Returns the instance, or throws
 * with what to change.
 */
export function checkLoopSignals(a: SetupArgs, instances: string[]): string {
  const named: [string, string][] = [
    ["measurement (pv)", a.pv.symbol],
    ["setpoint (sp)", a.sp],
    ["output (mv)", a.mv.symbol],
    ["mode", a.mode.symbol],
    ["manual output", a.manual_output],
    ...a.coefficients.map((c): [string, string] => ["coefficient", c.symbol]),
    ...(a.startup_flag ? [["startup flag", a.startup_flag] as [string, string]] : []),
  ];
  const programs = new Set(instances.filter((i) => !/^MCP_/i.test(i)).map((i) => i.toLowerCase()));
  const inst = firstName(a.pv.symbol);
  const outside = named.filter(([, s]) => firstName(s).toLowerCase() !== inst.toLowerCase() || !programs.has(firstName(s).toLowerCase()));
  if (!outside.length) return inst;
  const list = outside.map(([what, s]) => `${what} ${s}`).join(", ");
  throw new TuningError(
    "loop_signals",
    [
      `truST's Control Studio (0.34) can only tune a loop whose signals all belong to one PROGRAM; these don't${programs.has(inst.toLowerCase()) ? ` belong to ${inst}` : ""}: ${list}.`,
      `Programs here: ${[...programs].length ? instances.filter((i) => programs.has(i.toLowerCase())).join(", ") : "none"}.`,
      "GVL members (GVL_IO.x) are not accepted as loop signals (TRUST-GAPS S9). To tune, the program needs its own variables for them:",
      "- the measurement and the output as the program's variables mapped to the I/O, e.g. `lrLevel AT %IL0 : LREAL;` and `lrFlowCmd AT %QL0 : LREAL;` (the measurement must be an input the program only reads),",
      "- the setpoint, a BOOL mode (Manual/Auto) and a manual output as the program's variables.",
      "This changes the project's I/O layout: ask the user before restructuring. truST plans to accept GVL signals later.",
    ].join("\n"),
  );
}

/** The requirements Control Studio checks, with defaults scaled to the signal ranges. */
export function requirementsFor(a: SetupArgs): Record<string, number> {
  const pvSpan = a.pv.max - a.pv.min;
  const mvSpan = a.mv.max - a.mv.min;
  const exp = a.experiment_s ?? 300;
  const r = a.requirements ?? {};
  const round = (x: number) => Number(x.toPrecision(3));
  return {
    referenceChange: r.reference_change ?? round(pvSpan * 0.08),
    maximumError: r.maximum_error ?? round(pvSpan * 0.04),
    settlingBand: r.settling_band ?? round(pvSpan * 0.01),
    settlingTimeSeconds: r.settling_time_s ?? Math.round(exp * 0.75),
    durationSeconds: r.duration_s ?? Math.round(exp * 1.5),
    maximumOvershootPercent: r.maximum_overshoot_pct ?? 10,
    // S11: without a tolerance the hand-back to Auto is refused even when bumpless.
    transferTolerance: r.transfer_tolerance ?? round(mvSpan * 0.01),
  };
}

/** Control Studio's setup draft (the "Other law" search structure). */
export function draftFor(a: SetupArgs, instance: string): Record<string, unknown> {
  return {
    structure: "search",
    name: a.name,
    action: a.action ?? "direct",
    family: a.family ?? "robust", // S7: no plain PI family yet; "robust" fits a Kp/Ti search
    instance,
    processVariable: { symbol: a.pv.symbol, ...(a.pv.unit ? { unit: a.pv.unit } : {}), minimum: a.pv.min, maximum: a.pv.max },
    setpoint: { symbol: a.sp },
    manipulatedVariable: { symbol: a.mv.symbol, ...(a.mv.unit ? { unit: a.mv.unit } : {}), minimum: a.mv.min, maximum: a.mv.max },
    mode: { symbol: a.mode.symbol, whenTrue: a.mode.true_means },
    manualOutput: a.manual_output,
    coefficients: a.coefficients.map((c) => ({ symbol: c.symbol, ...(c.unit ? { unit: c.unit } : {}), values: c.values.join(", ") })),
    ...(a.startup_flag ? { startupFlag: a.startup_flag } : {}),
    experimentDurationSeconds: a.experiment_s ?? 300,
    experimentStep: a.step ?? Number(((a.mv.max - a.mv.min) * 0.1).toPrecision(3)),
  };
}

/** S6: raise the search budget in the loop file (setup writes 50,000 scans and 60 s). */
export function raiseBudget(loop: Record<string, unknown>): boolean {
  const p = (loop.controller as { project?: Record<string, unknown> } | undefined)?.project;
  if (!p) return false;
  let changed = false;
  if (!(Number(p.maximumCycles) >= 10_000_000)) {
    p.maximumCycles = 10_000_000;
    changed = true;
  }
  if (!(Number(p.wallBudgetMs) >= 3_600_000)) {
    p.wallBudgetMs = 3_600_000;
    changed = true;
  }
  return changed;
}

/** Downsample parallel time/value arrays to at most n points. */
export function downsample(t: number[], v: (number | null)[], n = 300): { t: number[]; v: (number | null)[] } {
  if (t.length <= n) return { t, v };
  const step = Math.ceil(t.length / n);
  const keep = (_: unknown, i: number) => i % step === 0 || i === t.length - 1;
  return { t: t.filter(keep), v: v.filter(keep) };
}

type Json = Record<string, unknown>;

/** The loop as the panel shows it, from its loop file (control-loops/<slug>.json). */
export function loopFromFile(j: Json): TuningLoop {
  const sig = (j.signals ?? {}) as Record<string, { symbol?: string; unit?: string } | undefined>;
  const ctl = (j.controller ?? {}) as { modeSignal?: string; manualOutputSignal?: string; project?: { axes?: { symbol: string; values: number[] }[] } };
  const params = ((j.parameterBinding as { parameters?: { symbol: string; unit?: string }[] } | undefined)?.parameters ?? []) as { symbol: string; unit?: string }[];
  return {
    id: String(j.id),
    name: String(j.name ?? j.id),
    signals: {
      pv: sig.processVariable?.symbol ?? "",
      sp: sig.setpoint?.symbol,
      mv: sig.manipulatedVariable?.symbol ?? "",
      mode: ctl.modeSignal,
      manualOutput: ctl.manualOutputSignal,
      pvUnit: sig.processVariable?.unit,
      mvUnit: sig.manipulatedVariable?.unit,
    },
    coefficients: (ctl.project?.axes ?? []).map((a) => ({ symbol: a.symbol, values: a.values, unit: params.find((p) => p.symbol === a.symbol)?.unit })),
  };
}

export function parseModel(r: Json): NonNullable<TuningLoop["model"]> {
  const plot = (r.plot ?? {}) as { timeSeconds?: number[]; traces?: { role: string; symbol: string; unit?: string; values: (number | null)[] }[] };
  const t = plot.timeSeconds ?? [];
  return {
    at: new Date().toISOString(),
    equation: String(r.equation ?? ""),
    keyNumbers: typeof r.keyNumbers === "string" ? r.keyNumbers : undefined,
    type: typeof r.modelType === "string" ? r.modelType : undefined,
    provisional: r.provisional === true,
    traces: (plot.traces ?? []).map((x) => {
      const d = downsample(t, x.values);
      return { name: x.symbol, role: x.role, unit: x.unit, t: d.t, v: d.v };
    }),
  };
}

export function parseSearch(r: Json): NonNullable<TuningLoop["search"]> {
  const trials = ((r.trials ?? []) as { parameters?: Record<string, number>; score?: number; bounds?: string }[]).map((x) => ({
    parameters: x.parameters ?? {},
    score: typeof x.score === "number" ? x.score : null,
    met: x.bounds === "met",
  }));
  return {
    at: new Date().toISOString(),
    status: String(r.status ?? ""),
    scoreUnit: typeof r.scoreUnit === "string" ? r.scoreUnit : undefined,
    selected: typeof r.selected === "number" ? r.selected : undefined,
    trials,
  };
}

export function parseValidation(r: Json): NonNullable<TuningLoop["validation"]> {
  const plot = (r.plot ?? {}) as Record<string, { name?: string; timeSeconds?: number[]; values?: (number | null)[] } | string | undefined>;
  const unit = typeof plot.unit === "string" ? plot.unit : undefined;
  const traces: TuningTrace[] = [];
  for (const key of ["current", "tuned"]) {
    const s = plot[key];
    if (!s || typeof s !== "object" || !s.timeSeconds) continue;
    const d = downsample(s.timeSeconds, s.values ?? []);
    traces.push({ name: s.name ?? key, role: key, unit, t: d.t, v: d.v });
  }
  const failure = r.failure as { message?: string } | undefined;
  return {
    at: new Date().toISOString(),
    status: String(r.status ?? ""),
    rows: ((r.table ?? []) as { title?: string; measured?: string; limit?: string; verdict?: string }[]).map((x) => ({
      title: String(x.title ?? ""),
      measured: String(x.measured ?? ""),
      limit: String(x.limit ?? ""),
      verdict: String(x.verdict ?? ""),
    })),
    traces,
    ...(failure?.message ? { failure: failure.message } : {}),
  };
}

/** The selected trial's settings, and the axes where it sits at the grid's edge. */
export function selectedTrial(loop: TuningLoop): { parameters: Record<string, number>; edges: string[] } | undefined {
  const s = loop.search;
  if (!s || s.selected === undefined) return undefined;
  const trial = s.trials[s.selected];
  if (!trial) return undefined;
  const edges: string[] = [];
  for (const c of loop.coefficients) {
    const v = trial.parameters[c.symbol];
    if (v === undefined || c.values.length < 2) continue;
    if (v === Math.min(...c.values) || v === Math.max(...c.values)) edges.push(c.symbol);
  }
  return { parameters: trial.parameters, edges };
}

const fmtNum = (x: number) => (Math.abs(x) >= 1000 || (Math.abs(x) < 0.01 && x !== 0) ? x.toPrecision(3) : String(Number(x.toPrecision(4))));
const short = (symbol: string) => symbol.split(".").pop()!;
const STILL_CHANGING = /still changing|settl/i;

/** Loop tuning on the simulation's mirror (one per SimController). */
export class Tuning {
  private loops = new Map<string, TuningLoop>();
  /** Bumped on every change, so the panel knows to fetch get_tuning. */
  version = 0;

  constructor(private readonly host: TuningHost) {}

  private dir(): string {
    const d = this.host.mirrorPath();
    if (!d) throw new TuningError("no_mirror", "No simulation mirror yet. Call sim_start first.");
    return d;
  }

  private changed(loop?: TuningLoop): void {
    if (loop) this.loops.set(loop.id, loop);
    this.version++;
  }

  private async studio<T = Json>(verb: string, args: string[], label: string): Promise<StudioAnswer<T>> {
    return this.host.runBusy(label, () => this.host.trust().studio<T>(this.dir(), verb, args));
  }

  /**
   * A verb that checks the runtime is alive. Search and Validate run isolated
   * simulations, but truST 0.34 still polls the target's status and times out
   * on a paused one, so the simulation runs freely (at 1x) meanwhile.
   */
  private async live(verb: string, args: string[], label: string, speed = 20): Promise<StudioAnswer<Json>> {
    await this.host.ensureStarted();
    return this.host.freeRun(label, speed, () => this.host.trust().studio<Json>(this.dir(), verb, args));
  }

  /**
   * A verb that needs the loop settled in Auto (Identify; Validate's live
   * model check): let it settle first, then retry while truST says the
   * measurement is still changing.
   */
  private async settled(verb: string, args: string[], label: string, speed: number, settleS: number): Promise<{ r: StudioAnswer<Json>; tries: number }> {
    await this.host.ensureStarted();
    const wallMs = (simS: number) => Math.round((simS * 1000) / speed);
    let tries = 0;
    const r = await this.host.freeRun(label, speed, async () => {
      await new Promise((res) => setTimeout(res, wallMs(settleS)));
      for (;;) {
        tries++;
        const a = await this.host.trust().studio<Json>(this.dir(), verb, args);
        const msg = `${a.failure?.message ?? ""} ${(a.failure as { detail?: string } | undefined)?.detail ?? ""}`;
        if (!a.failure || !STILL_CHANGING.test(msg) || tries >= 8) return a;
        await new Promise((res) => setTimeout(res, wallMs(60)));
      }
    });
    return { r, tries };
  }

  private failText(step: string, a: StudioAnswer<unknown>): string {
    const f = a.failure ?? { message: "no answer" };
    const detail = (f as { detail?: string }).detail;
    let hint = "";
    if (/unfinished operation/i.test(f.message)) hint = "\nA previous operation is still journaled: call tune_run with step 'cancel', then try again.";
    else if (/program instance not found|belong to one compiled program/i.test(f.message)) hint = "\nThe loop's signals must all be variables of one PROGRAM, not GVL members (TRUST-GAPS S9).";
    else if (/transfer tolerance/i.test(f.message)) hint = "\nThe hand-back to Auto was refused: make the controller bumpless (track the manual output while in Manual) or raise requirements.transfer_tolerance in tune_setup.";
    else if (/bounded input step|pre- and post-step/i.test(f.message))
      hint =
        "\ntruST 0.34's step fit rejects some recordings at random (TRUST-GAPS S13): identify again with method 'setpoint-step'. If the plant hit a limit or trip, use a smaller step (S12; tune_setup with replace: true).";
    return `${step} failed: ${f.message}${detail && detail !== f.message ? `\n${detail}` : ""}${f.nextAction && f.nextAction !== "none" ? ` (truST suggests: ${f.nextAction})` : ""}${hint}`;
  }

  /** Loops defined in the mirror (control-loops/*.json), with this session's results. */
  async list(): Promise<TuningLoop[]> {
    const dir = this.host.mirrorPath();
    if (dir && existsSync(join(dir, "control-loops"))) {
      for (const f of await readdir(join(dir, "control-loops"))) {
        if (!f.endsWith(".json")) continue;
        try {
          const fromFile = loopFromFile(JSON.parse(await readFile(join(dir, "control-loops", f), "utf8")) as Json);
          const known = this.loops.get(fromFile.id);
          this.loops.set(fromFile.id, known ? { ...known, ...fromFile, requirements: known.requirements } : fromFile);
        } catch {
          /* a loop file truST can't read either; setup reports it */
        }
      }
    }
    return [...this.loops.values()];
  }

  /** Synchronous snapshot for the panel. */
  panelLoops(): TuningLoop[] {
    return [...this.loops.values()];
  }

  private async loop(id: string): Promise<TuningLoop> {
    const full = id.startsWith("loop:") ? id : `loop:${id}`;
    const l = (await this.list()).find((x) => x.id === full || x.name.toLowerCase() === id.toLowerCase());
    if (!l) throw new TuningError("no_loop", `No tuning loop '${id}'. Loops: ${[...this.loops.keys()].join(", ") || "none"}. Create one with tune_setup.`);
    return l;
  }

  async setup(a: SetupArgs): Promise<string> {
    const out: string[] = [];
    const started = await this.host.ensureStarted();
    if (started) out.push(started.split("\n")[0]!);
    const dir = this.dir();
    const offer = await this.studio<{ formModel?: { instances?: string[] }; loops?: { loopId: string; name: string }[] }>("setup", [], "Tuning: reading the project's loops");
    if (offer.failure) throw new TuningError("setup_failed", this.failText("Reading the project", offer));
    const instance = checkLoopSignals(a, offer.result?.formModel?.instances ?? []);
    const id = loopIdOf(a.name);
    const exists = (offer.result?.loops ?? []).some((l) => l.loopId === id) || existsSync(join(dir, "control-loops", `${loopSlug(a.name)}.json`));
    if (exists && !a.replace) throw new TuningError("loop_exists", `Loop ${id} exists already. Pass replace: true to set it up again (its identification and search results are dropped), or use it with tune_run.`);
    if (exists) await this.forget(id);

    const work = join(dir, ".control-studio");
    await mkdir(work, { recursive: true });
    const draftFile = join(work, `draft-${loopSlug(a.name)}.json`);
    await writeFile(draftFile, JSON.stringify(draftFor(a, instance), null, 2), "utf8");
    const r = await this.studio("setup", ["--draft", draftFile], `Tuning: setting up ${a.name}`);
    if (r.failure) throw new TuningError("setup_failed", this.failText("Setup", r));
    const realId = /"(loop:[a-z0-9-]+)"/.exec(JSON.stringify(r.result ?? {}))?.[1] ?? id;
    const file = join(dir, "control-loops", `${realId.slice(5)}.json`);
    const loopJson = JSON.parse(await readFile(file, "utf8")) as Json;
    if (raiseBudget(loopJson)) {
      await writeFile(file, JSON.stringify(loopJson, null, 2) + "\n", "utf8"); // S6
      out.push("Raised the search budget to 10,000,000 scans / 60 min (truST 0.34 sets too little, TRUST-GAPS S6).");
    }
    // S5/S11: requirements (with the Auto-entry tolerance) only through serve, and before any operation.
    const change = requirementsFor(a);
    await this.host.runBusy("Tuning: setting requirements", () =>
      this.host.trust().studioRpc("controlStudio/inputs", { projectRoot: dir.replace(/\\/g, "/"), runtimeId: "simulator", loopId: realId, change }),
    );
    const loop: TuningLoop = { ...loopFromFile(loopJson), requirements: change };
    this.changed(loop);
    this.host.journal.add("tuning", `Tuning loop ${realId} set up`, { loop: realId });
    out.push(
      `Loop ${realId} ("${a.name}") set up in truST's Control Studio on ${instance}.`,
      `Searches ${a.coefficients.map((c) => `${short(c.symbol)} in {${c.values.join(", ")}}`).join(" × ")} (${a.coefficients.reduce((n, c) => n * c.values.length, 1)} candidates).`,
      `Identification: a setpoint step of ${change.referenceChange} in Auto (or, with method 'step', a ${draftFor(a, instance).experimentStep} step of ${a.mv.symbol} in Manual), up to ${a.experiment_s ?? 300} s.`,
      `Requirements: ${Object.entries(change)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}.`,
      "Next: tune_run with step 'identify' (the simulation runs freely while truST steps the output).",
    );
    return out.join("\n");
  }

  /** Drop a loop's definition, study and journal from the mirror (setup again). */
  private async forget(id: string): Promise<void> {
    const dir = this.dir();
    const slug = id.replace(/^loop:/, "");
    await rm(join(dir, "control-loops", `${slug}.json`), { force: true });
    const studyRoot = join(dir, "control-studio");
    if (existsSync(studyRoot)) {
      for (const f of await readdir(studyRoot)) if (f.startsWith(`loop_${slug}-`)) await rm(join(studyRoot, f), { recursive: true, force: true });
    }
    await this.clearJournal();
    this.loops.delete(id);
  }

  /** S10: a refused hand-back leaves the operation journaled, and cancel can't end it. */
  private async clearJournal(): Promise<void> {
    const j = join(this.dir(), ".control-studio");
    if (!existsSync(j)) return;
    for (const f of await readdir(j)) if (!f.startsWith("draft-")) await rm(join(j, f), { recursive: true, force: true });
  }

  async identify(id: string, o: { speed?: number; method?: string; settle_s?: number } = {}): Promise<string> {
    const started = await this.host.ensureStarted();
    const loop = await this.loop(id);
    const speed = o.speed ?? 20;
    let r: StudioAnswer<Json>;
    let tries = 0;
    loop.busy = "identify";
    loop.error = undefined;
    this.changed(loop);
    try {
      ({ r, tries } = await this.settled("identify", ["--loop", loop.id, "--method", o.method ?? "setpoint-step"], `Tuning ${loop.name}: identifying the plant`, speed, o.settle_s ?? 60));
    } finally {
      loop.busy = undefined;
    }
    if (r.failure) {
      loop.error = { step: "identify", message: r.failure.message, nextAction: r.failure.nextAction };
      this.changed(loop);
      throw new TuningError("identify_failed", this.failText("Identify", r));
    }
    loop.model = parseModel(r.result ?? {});
    loop.search = undefined;
    loop.validation = undefined;
    this.changed(loop);
    this.host.journal.add("tuning", `Identified ${loop.id}: ${loop.model.equation}`, { loop: loop.id });
    return [
      ...(started ? [started.split("\n")[0]!] : []),
      `${loop.model.type ?? "Model"}${loop.model.provisional ? " (provisional)" : ""}: ${loop.model.equation}`,
      ...(loop.model.keyNumbers ? [loop.model.keyNumbers] : []),
      `Ran with the simulation free-running at ${speed}x${tries > 1 ? `, after ${tries - 1} wait(s) for the loop to settle` : ""}. The simulation is paused again.`,
      "Next: tune_run with step 'search'.",
    ].join("\n");
  }

  async search(id: string): Promise<string> {
    const loop = await this.loop(id); // truST keeps the model in its study and says so if there is none
    loop.busy = "search";
    loop.error = undefined;
    this.changed(loop);
    const n = loop.coefficients.reduce((k, c) => k * c.values.length, 1);
    let r: StudioAnswer<Json>;
    try {
      r = await this.live("tune", ["--loop", loop.id], `Tuning ${loop.name}: trying ${n} candidates on the model`);
    } finally {
      loop.busy = undefined;
    }
    if (r.failure) {
      loop.error = { step: "search", message: r.failure.message, nextAction: r.failure.nextAction };
      this.changed(loop);
      throw new TuningError("search_failed", this.failText("Search", r));
    }
    loop.search = parseSearch(r.result ?? {});
    loop.validation = undefined;
    this.changed(loop);
    const s = loop.search;
    const sel = selectedTrial(loop);
    const met = s.trials.filter((t) => t.met).length;
    this.host.journal.add("tuning", `Searched ${loop.id}: ${sel ? Object.entries(sel.parameters).map(([k, v]) => `${short(k)}=${v}`).join(", ") : s.status}`, { loop: loop.id });
    const ranked = s.trials
      .map((t, i) => ({ ...t, i }))
      .filter((t) => t.score !== null)
      .sort((a, b) => a.score! - b.score!)
      .slice(0, 5);
    return [
      `Search ${s.status}: ${s.trials.length} candidates run against the model, ${met} met the requirements.`,
      sel ? `Selected: ${Object.entries(sel.parameters).map(([k, v]) => `${k} = ${v}`).join(", ")}.` : "No candidate was selected.",
      `Best scores (${s.scoreUnit ?? "lower is better"}): ${ranked.map((t) => `${Object.values(t.parameters).join("/")} → ${fmtNum(t.score!)}${t.met ? "" : " (misses a requirement)"}`).join("; ")}.`,
      ...(sel?.edges.length ? [`${sel.edges.map(short).join(" and ")} sit at the edge of the grid: a wider grid (tune_setup with replace: true) may find better values.`] : []),
      "Next: tune_run with step 'validate' (runs the actual ST against the model, current settings vs the candidate).",
    ].join("\n");
  }

  async validate(id: string): Promise<string> {
    const loop = await this.loop(id);
    loop.busy = "validate";
    loop.error = undefined;
    this.changed(loop);
    let r: StudioAnswer<Json>;
    try {
      r = (await this.settled("validate", ["--loop", loop.id], `Tuning ${loop.name}: validating the candidate`, 20, 30)).r;
    } finally {
      loop.busy = undefined;
    }
    if (r.failure && !r.result) {
      loop.error = { step: "validate", message: r.failure.message, nextAction: r.failure.nextAction };
      this.changed(loop);
      throw new TuningError("validate_failed", this.failText("Validate", r));
    }
    loop.validation = parseValidation(r.result ?? {});
    this.changed(loop);
    const v = loop.validation;
    const sel = selectedTrial(loop);
    this.host.journal.add("tuning", `Validated ${loop.id}: ${v.status}`, { loop: loop.id });
    return [
      `Validation: ${v.status}.`,
      ...v.rows.map((x) => `- ${x.title}: ${x.measured} (limit ${x.limit}) ${x.verdict}`),
      ...(v.failure ? [`truST: ${v.failure}`] : []),
      sel
        ? `To keep the candidate (${Object.entries(sel.parameters).map(([k, val]) => `${short(k)} = ${val}`).join(", ")}), change these values in CODESYS where the program sets them (write_object), then sim_start and run_experiment to confirm. truST never writes to the CODESYS project.`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  async cancel(id: string): Promise<string> {
    const loop = await this.loop(id);
    const r = await this.studio("cancel", ["--loop", loop.id], `Tuning ${loop.name}: cancelling`);
    loop.busy = undefined;
    loop.error = undefined;
    this.changed(loop);
    if (!r.failure) return `Cancelled ${loop.id}'s journaled operation.`;
    if (/no .*operation|nothing to cancel/i.test(r.failure.message)) return `${loop.id} has no unfinished operation.`;
    await this.clearJournal(); // S10
    return `truST could not cancel (${r.failure.message}); cleared the loop's operation journal in the mirror instead (TRUST-GAPS S10). Call sim_start for a clean simulation before the next step.`;
  }

  async status(id?: string): Promise<string> {
    const loops = await this.list();
    if (!loops.length) return "No tuning loops. Set one up with tune_setup (truST's Control Studio).";
    const show = id ? [await this.loop(id)] : loops;
    return show
      .map((l) => {
        const sel = selectedTrial(l);
        return [
          `${l.id} "${l.name}": pv ${l.signals.pv}, sp ${l.signals.sp ?? "?"}, mv ${l.signals.mv}, mode ${l.signals.mode ?? "?"}.`,
          `  Coefficients: ${l.coefficients.map((c) => `${c.symbol} {${c.values.join(", ")}}`).join("; ")}`,
          l.busy ? `  Busy: ${l.busy}` : "",
          l.error ? `  Last error (${l.error.step}): ${l.error.message}` : "",
          l.model ? `  Model: ${l.model.equation}${l.model.provisional ? " (provisional)" : ""}` : "  Model: not identified in this session",
          l.search ? `  Search: ${l.search.status}${sel ? `, selected ${Object.entries(sel.parameters).map(([k, v]) => `${short(k)}=${v}`).join(", ")}` : ""}` : "",
          l.validation ? `  Validation: ${l.validation.status}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n");
  }
}
