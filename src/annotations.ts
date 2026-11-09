/**
 * Tool annotations, so clients can tell harmless tools from ones that change
 * the CODESYS project. Under the MCP spec a tool without hints counts as
 * possibly destructive and open-world, which makes clients ask for approval
 * on every simulation step.
 *
 * - read: changes nothing (reads, compile, status).
 * - safe: changes only the simulation or adds something (new objects,
 *   checkpoints, scenarios); never overwrites or removes project content.
 * - destructive: can overwrite or remove project content.
 * Everything is local: openWorldHint is always false.
 */
type Kind = "read" | "safe" | "destructive";

const KIND: Record<string, Kind> = {
  // project: reading
  codesys_status: "read",
  get_project_tree: "read",
  read_objects: "read",
  search_code: "read",
  list_libraries: "read",
  list_tasks: "read",
  get_outline: "read",
  get_io_list: "read",
  get_devices: "read",
  get_library_api: "read",
  get_changes: "read",
  compile: "read",
  // project: changes that add or keep content
  open_project: "safe",
  create_project: "safe",
  save_project: "safe",
  close_project: "safe",
  create_object: "safe",
  add_library: "safe",
  remove_library: "destructive",
  checkpoint: "safe",
  // project: changes that overwrite or remove content
  write_object: "destructive",
  delete_object: "destructive",
  rename_object: "destructive",
  revert_object: "destructive",
  configure_task: "destructive",
  // CODESYS's own simulation (never a controller)
  codesys_sim_status: "read",
  codesys_sim_read: "read",
  codesys_sim_start: "safe",
  codesys_sim_stop: "safe",
  codesys_sim_control: "safe",
  codesys_sim_cycle: "safe",
  codesys_sim_write: "safe",
  codesys_sim_force: "safe",
  codesys_sim_unforce: "safe",
  // the panel
  open_sim_panel: "read",
};

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** The annotations for a tool, on top of any it declares itself. */
export function annotationsFor(name: string, own: ToolAnnotations = {}): ToolAnnotations {
  const kind = KIND[name];
  const base: ToolAnnotations =
    kind === "read" ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    : kind === "safe" ? { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    : kind === "destructive" ? { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
    : { openWorldHint: false };
  return { ...base, ...own };
}

export const annotatedTools = (): string[] => Object.keys(KIND);
