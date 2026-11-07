/**
 * Tool annotations, so clients can tell harmless tools from ones that change
 * the CODESYS project. Under the MCP spec a tool without hints counts as
 * possibly destructive and open-world, which makes clients ask for approval
 * on every simulation step.
 *
 * - read: changes nothing (reads, compile, tests in truST, status).
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
  checkpoint: "safe",
  // project: changes that overwrite or remove content
  write_object: "destructive",
  delete_object: "destructive",
  rename_object: "destructive",
  revert_object: "destructive",
  // simulation (truST only, never a controller)
  sim_status: "read",
  read_vars: "read",
  experiment_log: "read",
  run_tests: "read",
  open_sim_panel: "read",
  sync_mirror: "safe",
  sim_start: "safe",
  sim_stop: "safe",
  run_scans: "safe",
  run_for: "safe",
  set_breakpoint: "safe",
  clear_breakpoint: "safe",
  continue: "safe",
  step_over: "safe",
  step_in: "safe",
  step_out: "safe",
  write_var: "safe",
  force_var: "safe",
  unforce_var: "safe",
  set_plant_param: "safe",
  run_experiment: "safe",
  run_scenarios: "safe",
  save_scenario: "safe",
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
