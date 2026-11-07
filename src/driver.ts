/**
 * Who drives: Claude or the user. "Pause Claude" in the panel holds Claude's
 * tools that change the project or the simulation, so the user can explore
 * without Claude acting at the same time. Reads stay allowed.
 */

/** The panel view that fits what Claude is doing. "review" is decided by the panel. */
export type View = "code" | "tests" | "simulation" | "tuning";

const VIEW_OF: Record<string, View> = {};
for (const t of ["open_project", "create_project", "write_object", "create_object", "delete_object", "rename_object", "revert_object", "compile", "add_library"]) VIEW_OF[t] = "code";
VIEW_OF.run_tests = "tests";
for (const t of ["sync_mirror", "sim_start", "sim_stop", "run_scans", "run_for", "set_breakpoint", "clear_breakpoint", "continue", "step_over", "step_in", "step_out", "write_var", "force_var", "unforce_var", "set_plant_param"]) VIEW_OF[t] = "simulation";
for (const t of ["run_experiment", "run_scenarios", "save_scenario"]) VIEW_OF[t] = "tuning";

/** Which view a tool belongs to (undefined for reads, which don't move the panel). */
export function viewOf(tool: string): View | undefined {
  return VIEW_OF[tool] ?? (tool.startsWith("tune_") || tool.startsWith("tuning_") ? "tuning" : undefined);
}

export class Driver {
  held = false;
  since?: string;
  /** What Claude did last that moves the panel, and when (ms since epoch). */
  phase?: { view: View; tool: string; at: number };

  /** When Claude last called any tool (ms since epoch). */
  lastCallAt?: number;

  /** Called for every tool Claude calls. */
  note(tool: string): void {
    this.lastCallAt = Date.now();
    const view = viewOf(tool);
    if (view) this.phase = { view, tool, at: this.lastCallAt };
  }

  hold(on: boolean): void {
    this.held = on;
    this.since = on ? new Date().toISOString() : undefined;
  }
}

export function heldMessage(d: Driver, tool: string): string {
  return `paused_by_user: The user paused Claude in the panel (since ${d.since}) and is driving the simulation, so ${tool} is held. Wait for them to resume, or ask in the chat what they found. Reading tools still work.`;
}
