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
  signals: PanelSignal[];
  plants: { id: string; model: string; inputs: string[]; outputs: string[]; display?: PlantDisplay }[];
  feedback: { signal: string; follows: string; delay_ms: number; invert: boolean }[];
  experiments: { n: number; name: string; at: string; metrics: Record<string, number | string | null> }[];
  /** The last run_tests result. */
  tests?: { at: string; total: number; passed: number; failed: number; failing: string[] };
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
