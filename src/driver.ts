/**
 * Who drives: Claude or the user. "Pause Claude" in the panel holds Claude's
 * tools that change the project or the simulation, so the user can explore
 * without Claude acting at the same time. Reads stay allowed.
 */

/** The panel view that fits what Claude is doing. "review" is decided by the panel. */
export type View = "code";

const CODE_TOOLS = new Set(["open_project", "create_project", "write_object", "create_object", "delete_object", "rename_object", "revert_object", "compile", "add_library", "remove_library", "configure_task"]);

/** Which view a tool belongs to (undefined for reads, which don't move the panel). */
export function viewOf(tool: string): View | undefined {
  return CODE_TOOLS.has(tool) ? "code" : undefined;
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
  return `paused_by_user: The user paused Claude in the panel (since ${d.since}), so ${tool} is held. Wait for them to resume, or ask in the chat what they found. Reading tools still work.`;
}
