/**
 * Event journal: an append-only, sequence-numbered log of simulation events
 * (started, stopped, breakpoint hit, step, force, parameter change,
 * experiment result). The panel (Phase 3) polls it with `since(seq)`.
 */

export type EventKind =
  | "mirror_synced"
  | "sim_built"
  | "sim_started"
  | "sim_stopped"
  | "sim_exited"
  | "ran"
  | "stopped"
  | "breakpoint_set"
  | "breakpoint_cleared"
  | "stepped"
  | "var_written"
  | "var_forced"
  | "var_unforced"
  | "plant_param"
  | "experiment"
  | "tests";

export interface SimEvent {
  seq: number;
  at: string;
  kind: EventKind;
  text: string;
  data?: Record<string, unknown>;
}

export class Journal {
  private events: SimEvent[] = [];
  private seq = 0;

  constructor(private readonly capacity = 5000) {}

  add(kind: EventKind, text: string, data?: Record<string, unknown>): SimEvent {
    const e: SimEvent = { seq: ++this.seq, at: new Date().toISOString(), kind, text, ...(data ? { data } : {}) };
    this.events.push(e);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return e;
  }

  since(seq: number, limit = 500): SimEvent[] {
    const i = this.events.findIndex((e) => e.seq > seq);
    return i < 0 ? [] : this.events.slice(i, i + limit);
  }

  get last(): number {
    return this.seq;
  }

  tail(n: number): SimEvent[] {
    return this.events.slice(-n);
  }
}
