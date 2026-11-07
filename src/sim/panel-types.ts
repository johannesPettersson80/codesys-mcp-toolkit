/** Data the simulation panel reads through its app-only tools. Shared by server and panel. */
import type { PlantDisplay } from "./plant.js";

export type SignalRole = "command" | "feedback" | "plant_in" | "plant_out" | "experiment";

export interface PanelSignal {
  name: string;
  role: SignalRole;
  plant?: string;
  address?: string;
  /** Value as Structured Text, when the simulation runs. */
  value?: string;
  num?: number | null;
  forced: boolean;
}

export interface PanelLocation {
  obj?: string;
  part?: "decl" | "impl";
  line?: number;
  reason: string;
  breakpoint?: number;
  /** Paused between scans (not inside user code). */
  harness: boolean;
}

export type PanelStatus = "no_project" | "no_mirror" | "stopped" | "running" | "paused";

export interface PanelState {
  /** False when a newer panel took over; this one should stop polling. */
  current: boolean;
  /** The user paused Claude ("Pause Claude"): Claude's changing tools are held. */
  held?: boolean;
  heldSince?: string;
  /** What Claude did last that moves the panel's view, and how long it has been quiet since. */
  phase?: { view: "code" | "tests" | "simulation" | "tuning"; tool: string; quietMs: number };
  status: PanelStatus;
  project?: string;
  trust?: string;
  scan: number;
  /** Simulated seconds since the runtime started. */
  simTime: number;
  timeScale: number;
  cycleMs?: number;
  activity?: string;
  location?: PanelLocation;
  breakpoints: { id: number; obj: string; line: number; condition?: string }[];
  /** Variables forced through force_var (any path, not only plant signals). */
  forced: string[];
  signals: PanelSignal[];
  plants: { id: string; model: string; inputs: string[]; outputs: string[]; display?: PlantDisplay; parameters?: Record<string, number>; initial_state?: number[] }[];
  feedback: { signal: string; follows: string; delay_ms: number; invert: boolean }[];
  experiments: { n: number; name: string; at: string; metrics: Record<string, number | string | null> }[];
  /** Changes when truST tuning results change (the panel then fetches get_tuning). */
  tuningVersion?: number;
  /** The last run_tests result. */
  tests?: { at: string; total: number; passed: number; failed: number; failing: string[]; results?: { name: string; obj: string; status: string; message?: string; durationMs?: number }[] };
  journalSeq: number;
  trendEpoch: number;
  warnings: string[];
  exitInfo?: string;
}

export interface SourceLine {
  text: string;
  obj?: string;
  part?: "decl" | "impl";
  line?: number;
}

export interface SourceView {
  file: string;
  /** The top-level object the file holds. */
  title: string;
  lines: SourceLine[];
}

/** A series for the Tuning view's charts (downsampled). */
export interface TuningTrace {
  name: string;
  role: string;
  unit?: string;
  t: number[];
  v: (number | null)[];
}

/** One loop that truST's Control Studio tunes (get_tuning). */
export interface TuningLoop {
  id: string;
  name: string;
  /** What the loop's signals and searched coefficients are. */
  signals: { pv: string; sp?: string; mv: string; mode?: string; manualOutput?: string; pvUnit?: string; mvUnit?: string };
  coefficients: { symbol: string; values: number[]; unit?: string }[];
  requirements?: Record<string, number | string>;
  /** The step running now, or the last one that failed. */
  busy?: string;
  error?: { step: string; message: string; nextAction?: string };
  model?: { at: string; equation: string; keyNumbers?: string; type?: string; provisional: boolean; traces: TuningTrace[] };
  search?: {
    at: string;
    status: string;
    scoreUnit?: string;
    selected?: number;
    trials: { parameters: Record<string, number>; score: number | null; met: boolean }[];
  };
  validation?: {
    at: string;
    status: string;
    rows: { title: string; measured: string; limit: string; verdict: string }[];
    traces: TuningTrace[];
    failure?: string;
  };
}

/** One experiment run for the panel's Tuning view (get_experiments). */
export interface ExperimentRun {
  n: number;
  name: string;
  at: string;
  /** Variables the run set before starting (tuning parameters such as fbPI._rKp). */
  set: Record<string, string | number | boolean>;
  pv?: string;
  sp?: { var: string; value: number | string; at_s?: number };
  metrics: Record<string, number | string | null>;
  /** The process variable over time (downsampled). */
  points: { t: number; pv: number | null }[];
}
