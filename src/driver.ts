/**
 * Who drives: Claude or the user. "Pause Claude" in the panel holds Claude's
 * tools that change the project or the simulation, so the user can explore
 * without Claude acting at the same time. Reads stay allowed.
 */

export class Driver {
  held = false;
  since?: string;

  hold(on: boolean): void {
    this.held = on;
    this.since = on ? new Date().toISOString() : undefined;
  }
}

export function heldMessage(d: Driver, tool: string): string {
  return `paused_by_user: The user paused Claude in the panel (since ${d.since}) and is driving the simulation, so ${tool} is held. Wait for them to resume, or ask in the chat what they found. Reading tools still work.`;
}
