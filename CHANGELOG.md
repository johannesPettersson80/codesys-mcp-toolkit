# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0-alpha.0] - unreleased

Rewrite. See README "Migrating from v1".

### Changed
- CODESYS runs once per session with a watcher script (file-queue IPC,
  JSON op requests, heartbeat, hang/crash detection and restart) instead of
  a cold `--runscript` per call.
- ESM TypeScript on MCP SDK v2 (`@modelcontextprotocol/server`), Node 20+.
- Tools act on the open project; new tool set (`read_objects`,
  `write_object`, `create_object`, `get_project_tree`, `search_code`,
  `compile`, `list_libraries`, `add_library`, `list_tasks`, `codesys_status`, ...).
- Structured Text only; graphical objects are listed as `[non-ST]`.
- Offline only: no online/login/download APIs (enforced by tests).

### Added
- Simulation in [truST](https://github.com/johannesPettersson80/trust-platform)
  (simulated I/O only, never a controller): `sync_mirror`, `sim_start`,
  `sim_stop`, `sim_status`, `run_scans`, `run_for`, `set_breakpoint` (with ST
  conditions), `clear_breakpoint`, `continue`, `step_over` / `step_in` /
  `step_out`, `read_vars`, `write_var`, `force_var`, `unforce_var`,
  `set_plant_param`, `run_experiment`, `experiment_log`.
- `plant.toml`: truST plant models wired to ST variables by name, plus simple
  simulated device feedback (valve limit switches, pump running).
- Options `--trust-runtime`, `--mirror-dir`, `--no-sim`.
- `get_outline`, `get_io_list`: the project's structure and interfaces, and
  its I/O variables, from one export instead of reading every object.
- `get_library_api`: interfaces of referenced source libraries.
- `checkpoint`, `get_changes`, `revert_object`: change tracking against
  snapshots, with an automatic `session-start` snapshot on open.
- `save_scenario`, `run_scenarios`: saved experiments with expectations, as
  regression checks.
- `run_tests`: unit tests that live in the CODESYS project as programs marked
  `{attribute 'test'}`, run in truST, with results by CODESYS object.
- `open_sim_panel`: a live, read-only panel (MCP App).
  - **Browser workspace:** opening or creating a project opens the same
    workspace in the default browser, served on 127.0.0.1 with a token, for
    chats that can't show MCP Apps. Options `--viewer-port`, `--no-viewer`.
- Panel views that follow Claude's work: Code (live code with new lines
  marked), Unit tests, Simulation, Tuning (experiment runs overlaid and
  compared) and Review (accept or revert each changed object, with its
  added/removed line counts; in the chat card the changes open in place). New app-only
  tool `get_experiments`.
- Loop tuning with truST's Control Studio (truST 0.34+): `tune_setup`,
  `tune_run` (`identify`, `search`, `validate`, `cancel`) and `tune_status`.
  Identifies the plant on the free-running simulation, searches the program's
  own controller coefficients against the fitted model and validates the
  candidate with the actual ST. Works around truST 0.34's gaps (search
  budget, requirements and Auto-entry tolerance, stuck journals, a refused
  hand-back after validation) and refuses
  GVL loop signals with what to change. The Tuning view shows the model fit,
  the candidates and the validation (app-only tool `get_tuning`).
- `compile` checks every POU, GVL and DUT, including those no task calls (it
  sets "link always" for the build and restores it); `deep` also generates
  code, `clean` builds from scratch.
- CODESYS V3.5 SP22: the toolkit passes the install's additional folder
  (`CODESYS\AdditionalFolders\Default`, where SP22 keeps add-ons such as
  Scripting) as `--additionalfolder`, and reads profiles from it.
  `--codesys-additional-folder` overrides it.
- `codesys_status` and the panel show the Scripting add-on version next to
  the CODESYS install and compiler version. The server log says why an install
  was picked.
- Build properties: objects excluded from the build are marked in the tree
  and left out of the simulation. The application's compiler defines and,
  with Scripting 4.2, the project defines and compiler version are reported;
  the simulation mirror resolves `{IF defined (X)}` blocks with them, line
  for line (truST can't take defines).
- `get_devices`: the device tree and its I/O channels with their mapped
  variables; `get_io_list` includes the device-tree mappings.
- `read_objects` returns graphical bodies (SFC, CFC, LD, FBD) as PLCopenXML.
- `open_project` opens `.projectarchive` files; `save_project` can write one.
- `remove_library`.
- Checkpoints keep graphical bodies as PLCopenXML; `revert_object` re-imports
  a deleted graphical object instead of recreating it as empty ST.
- Compile messages give the real column (from CODESYS's offset; its own
  text says column 1) and the token length; the full-screen editor marks
  lines with errors and warnings.
- `configure_task`: create and configure tasks (kind, interval, priority,
  event, core, watchdog) and add program calls; `list_tasks` shows the event,
  core and watchdog. Removing a call is refused with an explanation: SP21's
  scripting can't do it.
- Tool annotations (read-only, non-destructive, destructive; all local), so
  clients can tell harmless tools from ones that overwrite project code.
- Shared session: server processes started with the same options share one
  background owner (one CODESYS, one simulation), so the panel shows the
  project the chat works on. `--no-shared` runs in-process as before.
  - **In the chat:** a compact card with status, what Claude is working on,
    changes, compile, tests and experiments.
  - **Full screen:** a CODESYS-style workspace with the project tree and
    badges, editor tabs (current line, breakpoints, inline values, diff
    against the session start), an inspector (watch, locals, breakpoints,
    I/O), and trend, plant, tests, problems and activity tabs.
  - **Follow Claude** opens what Claude edits and where the simulation stops.
  - **Selections** are sent to Claude as model context.
  - **Panel-only tools** (`get_sim_state`, `get_events`, `get_source`,
    `get_trend`, `get_workspace`, `get_object`, `get_locals`, `get_values`)
    are hidden from clients without MCP Apps support. They read a project
    cache that the tools keep current, so the panel never calls CODESYS.
  - **Interaction:**
    - set breakpoints from the gutter;
    - Continue (in the background), Pause and step from a run bar;
    - force, set or release variables from the watch list;
    - edit plant parameters (one restart for a batch);
    - accept or revert Claude's change per object (a `review` checkpoint
      the badges and diffs compare with);
    - **Pause Claude**, which holds Claude's changing tools with a
      `paused_by_user` answer while the user drives.
    User actions are journaled as "User: …" and sent to Claude as model
    context. They use app-only `ui_*` tools.

### Fixed
- A dialog CODESYS waits on during a call ends the call in about 15 seconds
  with an error that names it. Before, the call ran into its timeout (up to 5
  minutes).
- A request file held for a moment by another process (antivirus, indexer) no
  longer fails the call with `bad_request`.
- The simulation doesn't guess `project_defined` on Scripting 4.1, which can't
  read project defines: those blocks are left for truST and reported.
  Conditions after the branch CODESYS takes are ignored.
- `compile` returns errors and warnings with object, line and code (#10).
- `write_var`, `force_var` and experiment settings refuse a name the program
  doesn't have. truST 0.34 accepts such a write and drops it, so a typo looked
  applied.
- Build errors in the simulation map to CODESYS lines from truST's structured
  diagnostics (`trust-lsp check --format json`, truST 0.34+), with the
  error code; the text output is still parsed when trust-lsp is missing.
- Non-ASCII text round-trips (UTF-8 end to end) (#9).
- Reads work in Claude Desktop because they are tools, not resources (#6).
- Declarations that drop or change the object header are rejected (#5).
- Functions get their return type (#8).
- Object kinds come from type GUIDs, so localised CODESYS works.
- Interfaces are created without the implicit `__System.IQueryInterface` base.

## [1.1.16] - 2025-05-06

### Fixed
- Reverted to v1.1.3 code base which has working POU creation functionality
- Fixed path handling by using simpler approach from v1.1.3
- Restored original Application object finding logic that worked in v1.1.3

## [1.0.0] - 2025-04-23

### Added
- Initial release of the MCP server for CODESYS
- Command-line interface with configuration options
- Project management functionality:
  - Opening existing CODESYS projects
  - Creating new CODESYS projects
  - Saving projects
- POU (Program Organization Unit) management:
  - Creating POUs (Programs, Function Blocks, Functions)
  - Setting POU code (declaration and implementation)
  - Creating properties and methods for Function Blocks
- Project compilation support
- Resources for querying:
  - Project status
  - Project structure
  - POU code
- Documentation for installation and usage
