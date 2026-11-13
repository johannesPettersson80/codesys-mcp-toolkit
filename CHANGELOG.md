# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `get_devices` really shows Machine Expert modules by their module id. 2.1.1
  expected `get_module_identification()` to return an object, but in CODESYS
  and Machine Expert 2.3 it returns the module id as a string (empty for a
  device that isn't a module), so the module id was never read.

## [2.1.1] - 2026-11-13

### Fixed
- `get_devices` tells modules apart. A module is a device that exists only
  inside its owner, such as Machine Expert's local I/O and embedded functions.
  CODESYS reports the owner's type and id for it, so every device looked the
  same (#7). Modules now show their module id.

### Changed
- Releases are published from GitHub Actions through npm trusted publishing,
  so the npm package carries a provenance statement, and `server.json` goes to
  the MCP Registry in the same run.

## [2.1.0] - 2026-11-13

### Added
- `--attach <dir>` (experimental): work in a CODESYS / Machine Expert window you
  already have open. The server writes `start_attach.py`; run it in the window
  with Tools > Scripting > Execute Script File. A UI timer polls for requests, so
  the window stays usable. Nothing is started or killed. (#12, thanks @dFxed)
- EcoStruxure Machine Expert V2.3 works: `LogicBuilder.exe` has no profiles, so
  `--codesys-profile` is optional for products other than `CODESYS.exe` and
  `--profile` is left out when there is none. CODESYS behaviour is unchanged.
  (#7, #11, thanks @dFxed)

### Fixed
- `read_objects` says when the PLCopenXML export of a graphical object fails,
  instead of leaving its body out without a word. (#13, thanks @Alfabete-spec)
- `codesys_sim_start` refuses when the application is already logged in, which
  can happen in a window opened with `--attach`. It could otherwise have taken
  over a connection to a real controller.
- A result file that stays unreadable fails the call after a few seconds
  instead of being retried forever.

## [2.0.1] - 2026-11-10

### Added
- Listing in the official MCP Registry as
  `io.github.johannesPettersson80/codesys-mcp-toolkit`: `mcpName` in
  `package.json` and a `server.json`.

## [2.0.0] - 2026-11-09

Rewrite. See README "Migrating from v1".

### Changed
- CODESYS runs once per session with a watcher script (file-queue IPC,
  JSON op requests, heartbeat, hang/crash detection and restart) instead of
  a cold `--runscript` per call.
- ESM TypeScript on MCP SDK v2 (`@modelcontextprotocol/server`), Node 20+.
- One tool, `codesys`, so a client that asks for approval per tool asks once.
  Each operation is an action of it (`read_objects`, `write_object`,
  `create_object`, `get_project_tree`, `search_code`, `compile`,
  `list_libraries`, `add_library`, `list_tasks`, `codesys_status`, ...), and
  actions work on the open project. `help` lists them with their arguments,
  and `batch` runs several in one call.
- Structured Text only; graphical objects are listed as `[non-ST]`.
- No login or download to a controller. The online functions are used only
  for CODESYS's own simulation.
- Earlier development builds simulated in truST. That is gone; the options
  `--trust-runtime`, `--mirror-dir` and `--no-sim` are accepted and ignored,
  so existing client setups keep starting.

### Added
- CODESYS's own simulation, with nothing extra to install: `codesys_sim_start`,
  `codesys_sim_stop`, `codesys_sim_status`, `codesys_sim_control`,
  `codesys_sim_cycle`, `codesys_sim_read`, `codesys_sim_write`,
  `codesys_sim_force`, `codesys_sim_unforce`. Runs on the real compiler and
  libraries; the project is locked while it runs.
- `get_outline`, `get_io_list`: the project's structure and interfaces, and
  its I/O variables, from one export instead of reading every object.
- `get_library_api`: interfaces of referenced source libraries.
- `checkpoint`, `get_changes`, `revert_object`: change tracking against
  snapshots, with an automatic `session-start` snapshot on open.
- `open_sim_panel`: a live panel inside the chat (MCP App), which Claude opens
  after opening or creating a project. It is a separate tool with its own
  approval. Open workspace on the card expands it.
- `open_workspace`: the same workspace in the default browser, when the user
  asks for it, served on 127.0.0.1 with a token. Options `--viewer-port`,
  `--no-viewer`.
- Panel views that follow Claude's work: Code (live code with new lines
  marked) and Review (accept or revert each changed object, with its
  added/removed line counts; in the chat card the changes open in place).
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
- Build properties: objects excluded from the build are marked in the tree.
  The application's compiler defines and, with Scripting 4.2, the project
  defines and compiler version are reported.
- `get_devices`: the device tree and its I/O channels with their mapped
  variables; `get_io_list` includes the device-tree mappings.
- `read_objects` returns graphical bodies (SFC, CFC, LD, FBD) as PLCopenXML.
- `open_project` opens `.projectarchive` files; `save_project` can write one.
- `remove_library`. `add_library` also takes a bare title (`Util`), with an
  optional version.
- `get_library_api` lists compiled libraries and ones the project doesn't
  reference, with their descriptions, from CODESYS's library browser cache.
- A profile that isn't installed is refused at start, with the installed ones
  listed. The `--workspace` folder is created if missing.
- Profiles and templates are also found for programs laid out unlike
  `CODESYS.exe`. See `docs/machine-expert-testing.md` for testing with
  Schneider Machine Expert, which isn't supported yet.
- Checkpoints keep graphical bodies as PLCopenXML; `revert_object` re-imports
  a deleted graphical object instead of recreating it as empty ST.
- Compile messages give the real column (from CODESYS's offset; its own
  text says column 1) and the token length; the full-screen editor marks
  lines with errors and warnings.
- `configure_task`: create and configure tasks (kind, interval, priority,
  event, core, watchdog) and add program calls; `list_tasks` shows the event,
  core and watchdog. Removing a call is refused with an explanation: SP21's
  scripting can't do it.
- Shared session: server processes started with the same options share one
  background owner (one CODESYS), so the panel shows the project the chat
  works on. `--no-shared` runs in-process as before.
  - **In the chat:** a compact card with status, what Claude is working on
    and changes.
  - **Full screen:** a CODESYS-style workspace with the project tree and
    badges, editor tabs (diff against the session start), and problems and
    review tabs.
  - **Follow Claude** opens what Claude edits.
  - **Selections** are sent to Claude as model context.
  - **Panel-only tools** (`get_sim_state`, `get_workspace`, `get_object`) are
    hidden from clients without MCP Apps support. They read a project cache
    that the tools keep current, so the panel never calls CODESYS.
  - **Interaction:** accept or revert Claude's change per object (a `review`
    checkpoint the badges and diffs compare with), and **Pause Claude**, which
    holds Claude's changing tools with a `paused_by_user` answer. User actions
    are sent to Claude as model context. They use app-only `ui_*` tools.

### Fixed
- The server advertises the MCP Apps extension (`io.modelcontextprotocol/ui`)
  in its capabilities. A host may otherwise treat the card tool as plain text
  and show no card.
- `create_project` makes a project that compiles (#4). CODESYS's shipped
  `Standard.project` can be years old: SP22's names device 3.1.3.0 and
  `IoStandard, 3.1.3.1`. The new copy is brought up to the running CODESYS's
  device, compiler and libraries. Templates you pass and projects you open are
  never updated.
- `open_project` says when a project needs a newer compiler than the running
  CODESYS has, and so can't compile there.
- A start-up timeout or a crash during a call reports what the program printed.
- A dialog CODESYS waits on during a call ends the call in about 15 seconds
  with an error that names it. Before, the call ran into its timeout (up to 5
  minutes).
- A request file held for a moment by another process (antivirus, indexer) no
  longer fails the call with `bad_request`.
- `compile` returns errors and warnings with object, line and code (#10).
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
