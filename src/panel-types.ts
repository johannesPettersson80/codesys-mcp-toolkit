/** Data the panel reads through its app-only tools. Shared by server and panel. */

export interface PanelState {
  /** False when a newer panel took over; this one should stop polling. */
  current: boolean;
  /** The user paused Claude ("Pause Claude"): Claude's changing tools are held. */
  held?: boolean;
  heldSince?: string;
  /** What Claude did last that moves the panel's view, and how long it has been quiet since. */
  phase?: { view: "code"; tool: string; quietMs: number };
  /** CODESYS's own simulation, while it runs. */
  codesysSim?: { state: string; forced: string[]; cycles: number };
}
