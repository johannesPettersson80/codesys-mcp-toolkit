# Reference

The full detail behind the [README](../README.md): every action, how paths and
checks work, the simulation's behaviour and the live panel.

- [Actions](#actions)
- [Checked versions](#checked-versions)
- [Object paths](#object-paths)
- [Structured Text only](#structured-text-only)
- [Declaration checks](#declaration-checks)
- [What compile checks](#what-compile-checks)
- [Task calls](#task-calls)
- [CODESYS simulation](#codesys-simulation)
- [Live panel](#live-panel)

## Actions

Claude reaches all of these through one MCP tool, `codesys`:

```json
{ "action": "read_objects", "args": { "paths": ["PLC_PRG"] } }
```

The card in the chat is a separate tool, `open_sim_panel`, because MCP ties a
panel to one tool.

| Action | What it does |
| --- | --- |
| `help` | Lists the actions and their arguments, or one action's. |
| `batch` | Runs up to 50 actions in one call, in order. Much faster than separate calls: nearly all of a session's time is the round trip between calls. Every step is checked first; it stops at the first failure unless `continueOnError`. |
| `wait` | Pauses up to 60 s, so a batch can let a simulation timer elapse. |
| `codesys_status` | Connection state, CODESYS version, last project. Never waits on CODESYS. |
| `open_project` | Open a `.project`, or a `.projectarchive` (extracted next to it, never over an existing project). Opened without version upgrades. Reports the compiler version and defines. Refuses to drop unsaved changes unless `discardChanges`. |
| `create_project` | New project from CODESYS's `Standard.project` (default), `empty`, or your own template file. |
| `save_project` / `close_project` | Save (optionally also as a `.projectarchive` snapshot), or close the project. |
| `get_project_tree` | Objects with their kinds. Graphical objects (SFC, CFC, LD, FBD) are marked `[non-ST]`, objects excluded from the build `[excluded from build]`. |
| `read_objects` | Declaration and implementation of up to 50 objects. LD, FBD, CFC and SFC bodies come as `create_graphical`'s description (with a note and the PLCopenXML when something doesn't fit it, such as function boxes in a rung); an SFC with branches comes as a `chart`. |
| `write_object` | Replace a declaration and/or implementation. The header must match the object (see [Declaration checks](#declaration-checks)). |
| `create_object` | `program`, `function_block`, `function`, `method`, `property`, `action`, `interface`, `dut`, `gvl`, `persistent_vars` (a persistent variable list: `VAR_GLOBAL PERSISTENT RETAIN`), `folder`, optionally with code. |
| `delete_object` / `rename_object` | Delete or rename an object. |
| `search_code` | Text or regex search over all ST. |
| `compile` | Build the application and return errors and warnings with object, line and code. Also checks POUs no task calls (default); `deep` generates code too, `clean` builds from scratch. |
| `list_libraries` / `add_library` / `remove_library` | Library references. Add by title (`Util`, the newest installed unless you pass `version`) or full name (`Util, 3.5.17.0 (System)`). `list_libraries` marks references that take the newest installed version (`*`), which can differ between machines. |
| `find_library` | Search the installed libraries by title, company or category: every installed version, the default namespace, the categories, and how the open project references each. |
| `pin_library` | Fix a reference to one version: the version it uses now, or `version`. A placeholder (`#Standard`) is pinned with CODESYS's redirection, a `*` reference is replaced by the fixed version (its namespace kept). `unpin` goes back to the newest installed version, or the placeholder's own resolution. |
| `get_library_api` | What a library offers. A referenced source library (`.library`) gives the real interface of its FBs, functions and types. A compiled library, or one the project doesn't reference yet, gives its objects and descriptions from CODESYS's library browser, without parameters. |
| `create_graphical` | Create an LD, FBD or SFC program or function block from a description (`replace: true` replaces an existing one, e.g. after editing the description `read_objects` gave): ladder rungs (`when`: contacts in series `and` / parallel `or`, `NOT x` for a normally closed contact; `then`: coils, set, reset), FBD networks (functions such as AND or ADD, function blocks with instance and inputs, results to variables), SFC steps (actions in ST with qualifiers, a condition to the next step; one sequence whose last step jumps back), or an SFC `chart` with branches: steps and transitions top to bottom, `alternative` paths (one is taken; each starts with a condition), `parallel` paths (all run; they follow a transition and join before the next one) and jumps. `cfc` takes the same description as `fbd` and draws it as CFC. The declaration is given as ST. |
| `get_signature` | The real interface of POUs and types as CODESYS's compiler sees them (inputs, outputs, other variables, types, initial values, doc comments, methods and properties), for the project's code and for FBs in any referenced library, compiled ones included. Builds first if needed. |
| `find_references` | Every declaration, read, write, call and type use of a variable, POU or type in the application, with POU, line and column (CODESYS's cross-references). |
| `rename_symbol` | Rename a variable (owner + name) or a POU everywhere it is used, from CODESYS's cross-references: the declaration, every read, write and call, and instance declarations of a renamed FB. Refused when several objects declare the same variable name. Graphical bodies that need changes are listed, not changed. |
| `list_tasks` | Tasks with kind, interval, priority, event, watchdog and the programs they call. |
| `configure_task` | Create or change a task (kind, interval, priority, event, core, watchdog) and add the programs it calls. |
| `get_outline` | The project at a glance without reading every object: tasks and what they run, each POU's interface (inputs, outputs, methods, properties), interfaces, enums, structs, GVLs, tests. Pass `path` for one object in full or one folder. |
| `get_io_list` | Variables mapped to I/O (`AT %I…`, `%Q…`, `%M…` and the `%I*` / `%Q*` placeholders), with type, owner and comment, and the channels mapped to variables in the device tree. |
| `get_devices` | The device tree: identification, enabled state, and each device's I/O channels with the variable mapped to each (from CODESYS's I/O mapping export). |
| `find_device` / `add_device` | Search the device descriptions installed in CODESYS (fieldbus masters and slaves, adapters, I/O modules) and add one under a device in the tree (add, insert or plug into a slot). |
| `device_parameters` | A device's parameters and I/O channels from its device description, the device's own and its connectors' (keys like `c1/4`, nested elements `c0/1000/1000_0_0_0`): name, type, value and unit, the choices of an enumeration, read-only marks, and each channel's mapped variable and IEC address. `depth` limits nesting (default: one level, so registers but not their bits), `filter` and `channels` narrow it. |
| `configure_device` | Set parameters (`values: {key: value}`, an enumeration by identifier or name; arrays as `[192, 168, 1, 20]`) and map channels (`mappings: [{channel, variable, address?}]`: an existing variable as `Application.GVL_IO.xValve`, or a plain name for CODESYS to create; `""` unmaps; `address` fixes the IEC address, `null` makes it automatic). Offline; compile afterwards. |
| `checkpoint` / `get_changes` / `revert_object` | Snapshots of the project's ST, and of graphical bodies as PLCopenXML (one is taken automatically when a project is opened: `session-start`), what changed since one (with a line diff per object), and putting an object back, including its methods and properties. A deleted SFC, CFC, LD or FBD object is re-imported from its XML. |
| `trace_setup` / `trace_record` | CODESYS Trace in the simulation: set up the variables to record every cycle of a task (before `codesys_sim_start`), then record for some seconds. Returns a summary per variable (BOOL edges with times, min and max with times), a table and a chart image. |
| `breakpoint_set` / `breakpoint_clear` / `debug_status` / `debug_step` / `debug_continue` | Debugging in the simulation through CODESYS's breakpoint manager: a breakpoint at a line of a POU's implementation (with the instance for a function block), where the simulation is halted (POU, line, code), step over, into or out, and continue. Values are read with `codesys_sim_read` while halted. While halted, `debug_status` also shows the call stack (innermost first). |
| `breakpoint_on_change` | A data breakpoint: the simulation halts right after a statement writes the variable, optionally only when a condition holds (CODESYS then checks it on every write, which slows the simulation). The size comes from the variable's type; elementary variables only. |
| `watch` | A watch list in the simulation: `add`, `remove`, `clear`, then one read of all expressions, each marked with its value at the previous read. `samples` > 1 reads several times (`every` ms apart) and reports min, max and the number of changes. |
| `codesys_sim_test` | Test cases in the simulation: steps that write, force or unforce inputs, run exact cycles or wait in real time, and expect values (exact, or a comparison with an optional tolerance). Returns a pass/fail table with the actual values of failed checks. |
| `show_in_codesys` | With `--show-window`: open an object in its editor in the CODESYS window (a visualization, a POU, a device). While the simulation runs, a visualization runs there. |
| `open_workspace` | Open the live workspace in the browser. |
| `hmi_save_screen` | Create or replace an HMI screen: a grid of tiles (12 x 8 by default; `at` is `[column, row, width, height]`), each one widget bound to PLC variables by their full path. Widgets: `value`, `gauge`, `bar`, `status`, `buttons` (tap, toggle, set, reset), `switch`, `setpoint`, `trend`, `alarms`, `text`, `recipe` (see `create_recipes`), and `process`, a diagram in a 0..100 box with `tank`, `pump`, `fan`, `valve`, `pipe`, `sensor`, `lamp`, `junction`, `label` and `symbol` (see `hmi_symbols`). Pipes connect ports (`{from: 'T-101.right', to: 'P-101.in'}`) and are routed with right angles; ports: tank `top` `bottom` `left` `right` `left-high` `right-high`, pump and fan `in` `out` `top` `bottom`, valve `in` `out`, junction `c`. A symbol's name is its `id` or its label. Overlapping tiles and unknown ports are refused. Stored next to the project as `<project>.hmi.json`. |
| `hmi_template` | A ready layout for an `overview`, `unit`, `alarms`, `trends` or `settings` page, to adapt and save. Pages of one project share a header with links to every page and the count of active alarms across all pages. Screens can set `size` (1280x720, 1920x1080, 1024x768, 800x480); pumps, fans and valves can have a `faceplate` popup (auto, start, stop, open, close, reset, values, setpoint). Saving warns about symbols that overlap or leave the diagram. |
| `hmi_screenshot` | The screen as a PNG image, with live values while the simulation runs, otherwise example values or the values you pass. Needs Edge or Chrome. |
| `hmi_export_codesys` | Build the HMI as native CODESYS visualizations, one per page (`Visu_<screen>`), with page buttons, the start page and client size of TargetVisu and WebVisu, an embedded SVG image pool, turning pumps and fans, faceplates as dialogs (`Dlg_<screen>_<tag>`), the pages' alarms in CODESYS alarm management (`Alarm Configuration/AG_HMI`), user groups with a Login button, and a helper program per page (`PRG_HMI_<screen>`, in VISU_TASK). Compiles and returns a picture of the first page. Trends become value rows; gauges are the browser's arc gauge as pictures; alarm rows follow CODESYS's alarm states with time, state and an ACK button; symbols become one picture per state, chosen by their on and fault variables. Refuses at once when CODESYS's library repository lacks `FloatingPointUtils`. |
| `hmi_list` / `hmi_delete_screen` | The project's screens (or one screen's full description), and deleting one. |
| `open_hmi` | Open the live HMI in the browser: live values from the simulation, and buttons, switches and setpoints that write to it. After `hmi_export_codesys`, alarm rows follow CODESYS's alarm states and have an ACK button. |
| `hmi_symbols` | The process-diagram symbols you can place as `{type: 'symbol', symbol, x, y, size, rotate, on, fault, label, faceplate}`: the standard ones (`motor`, `conveyor`, `heat_exchanger`, `mixer`, `filter`, `compressor`, `cylinder`, `level_switch`, `pressure_switch`, `check_valve`, `control_valve`) and the project's own, as a picture in their off, on and fault colours with their ports, and as a list. |
| `hmi_save_symbol` / `hmi_delete_symbol` | Add (or replace) one of the project's own symbols: SVG markup in a box (`viewBox`, default 100 x 100) or an SVG file to import, ports (`{ in: { x, y, dir: 'left' } }`) and a description. Colours `var(--state)` (off grey, on green, fault red), `var(--body)`, `var(--body2)`, `var(--line)`, `var(--accent)`; `class="spin"` turns while on (browser). Allowed: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text` and gradients with presentation attributes; scripts, styles, links and external images are refused. Returns a picture of every state. Stored in `<project>.hmi.json`. |
| `hmi_translate` | Translations of the HMI per language (`language`, `texts: {original: translation}`, `replace`): titles, labels, button captions and alarm messages. Returns the texts still untranslated (call without `texts` for the list). The browser HMI gets language buttons in its header (the choice is remembered in the browser); `hmi_screenshot` takes `language`. The export writes the alarm messages' translations into CODESYS's alarm text list; native pages stay in the base language (CODESYS doesn't look up script-made texts in its GlobalTextList, checked on SP21). |
| `alarm_list` | The Alarm Configuration: each group's alarms with ID, condition, class and message. |
| `alarm_status` | Each alarm's state from CODESYS's alarm manager in the running simulation: normal, pending, active, active acknowledged, cleared and waiting for confirmation, cleared and not acknowledged. Lists the state variables (`__Alm__GVL.g_inst.gen_Inst_<group>_AlarmGroup.gen_ArrAllAlarms[k].m_eState`) for `codesys_sim_test`. |
| `alarm_acknowledge` | Acknowledge (or confirm) alarms in the simulation, by default every one that isn't normal, and report each one's state before and after. An Error-class alarm whose condition is still true stays active. |
| `create_recipes` | Recipes for setpoints as generated ST (`name`, `variables`, `recipes: {name: {variable: value}}`): `ST_Recipe_<name>`, `GVL_Recipe_<name>` (the recipes in a RETAIN array, and their names) and `PRG_Recipe_<name>` added to MainTask. `iApply := k` writes recipe k to the variables (through pointers, so program variables work too), `iSave := k` stores the current values in it; `iActive`, `sActive` say which was applied. The HMI widget `{type: 'recipe', recipe, recipes}` shows Apply and Save buttons in the browser and in CODESYS. Types are looked up in the declarations, or given as `{path, type}`. |
| `project_report` | A Markdown handover report next to the project (or at `path`): summary, tasks, I/O, device-tree mappings, alarms, HMI pages, libraries, devices, program structure, and a commissioning checklist built from the project. |
| `export_sources` | The project as plain text in a folder (default `<project>_src`): one `.st` per object, graphical bodies as `.xml`, `project.txt` (tasks, libraries, devices, alarms) and `hmi.json`. Rewrites only changed files and removes files of deleted objects that an earlier export wrote (listed in `.codesys-export.json`). |
| `compare_sources` | The open project compared with an `export_sources` folder or another `.project` file (opened without updates for the comparison, then the open project is opened again): objects only in one of them, and a line diff per changed object (`max_lines` in all). `path` limits it to one object or folder. |

Long actions send MCP progress notifications (`notifications/progress`) when the client asks for them with a progress token: the steps of an HMI export or a batch, and a heartbeat every 10 s.

The simulation actions are listed under [CODESYS simulation](#codesys-simulation).

## Checked versions

What we checked live, in CODESYS's own simulation (never on a controller).
`codesys_status` reports which optional features the CODESYS you run has, so an
action that can't work there says so instead of failing halfway.

| Feature | V3.5 SP21 | V3.5 SP22 Patch 4 | Machine Expert |
| --- | --- | --- | --- |
| ST: read, write, create, compile, simulation, sim tests | yes | yes | not rechecked for 2.x |
| `--show-window`, editors following the work | yes | yes | not checked |
| `show_in_codesys` | yes | not checked | not checked |
| Browser HMI (`open_hmi`), symbols, alarm ACK | yes | yes | not checked |
| Native HMI export (`hmi_export_codesys`): pages, symbols, gauges, faceplates | yes | needs FloatingPointUtils (missing on our SP22) | not checked |
| CODESYS alarms: export, `alarm_status`, `alarm_acknowledge` | yes | not checked | not checked |
| `get_signature`, `find_references` | yes | yes | not checked |
| `rename_symbol` | not checked | yes | not checked |
| `create_graphical` (LD, FBD, SFC) | yes | yes | not checked |
| SFC branches, CFC, `compare_sources` | not checked | yes | not checked |
| Reading LD, FBD, SFC as a description, `replace` | yes | yes | not checked |
| `trace_setup`, `trace_record` | yes (probe) | yes | not checked |
| Debugging (breakpoints, stepping, call stack) | yes (probe) | yes | not checked |
| `breakpoint_on_change`, `watch` | not checked | yes | not checked |
| `find_library`, `pin_library` | not checked | yes | not checked |
| HMI themes, native pipe flow, access rights per tile | yes | not checked | not checked |
| Native HMI export with CODESYS in German or Chinese | yes | not checked | not checked |
| `find_device`, `add_device`, `device_parameters`, `configure_device` | yes | yes | not checked |
| `project_report`, `export_sources` | yes | yes | not checked |

"Probe" means the CODESYS calls were checked by a probe script on that version,
not through the action itself.

## Object paths

Paths are relative to the active application:

- `PLC_PRG` is a POU.
- `FB_Pump/Start` is a method.
- `FB_Pump/Speed/Get` is a property accessor.
- `Folder/FB_X` is an object inside a folder.

A leading `/` starts at the project root, e.g. `/Device/Plc Logic/Application/PLC_PRG`.

## Structured Text only

Version 2 reads and edits text objects only:

- POUs, methods, properties and accessors, actions
- interfaces
- DUTs and GVLs

Objects with graphical bodies appear in the tree, but you can't edit them as ST.

## Declaration checks

`write_object` and `create_object` reject a declaration that would change the
object's kind or name. For example, replacing a program's declaration without
its `PROGRAM X` line ([#5](https://github.com/johannesPettersson80/codesys-mcp-toolkit/issues/5)).
A GVL must start with `VAR_GLOBAL`; a property accessor holds only `VAR` blocks.

## What compile checks

A CODESYS build only compiles POUs that a task reaches. So `compile` marks
every other POU, GVL and DUT "link always" for that one build, then puts the
flags back. New code that nothing calls yet is checked too. If the project had
no unsaved changes before, it is saved again afterwards with the same content,
so nothing is left behind. Programs marked `{attribute 'test'}` are left out.
Pass `check_all: false` for CODESYS's plain build.

## Task calls

`configure_task` can add a program call to a task. CODESYS V3.5 SP21's
scripting can't remove one: `remove()` leaves the call in place. The action
says so, and you remove it in CODESYS (Task Configuration > the task > select
the call > Remove Call).

## CODESYS simulation

`codesys_sim_start` compiles the project and loads it into CODESYS's own
simulation. It uses the real CODESYS compiler and libraries, needs no
controller and nothing installed beyond CODESYS.

| Action | What it does |
| --- | --- |
| `codesys_sim_start` | Compile and load the application, stopped (or running with `run: true`) |
| `codesys_sim_stop` | End the simulation, release forces, unlock the project |
| `codesys_sim_status` | The application's state and what is forced |
| `codesys_sim_control` | `run`, `stop`, `reset_warm` or `reset_cold` |
| `codesys_sim_cycle` | Run exactly N task cycles (about 0.1 s each) |
| `codesys_sim_read` | Read variables, e.g. `PLC_PRG.nCount` or `GVL_IO.xValve` |
| `codesys_sim_write` | Write values once; the program may overwrite them next cycle |
| `codesys_sim_force` | Hold values until released |
| `codesys_sim_unforce` | Release the named forces, or all of them |

- **The project is locked while it runs.** `compile`, `write_object` and the
  other actions that change the project are refused until `codesys_sim_stop`.
  The simulation setting on the device is never saved into your project.
- **It runs at real speed.** Timers follow the clock, even between single
  cycles: to let a `TON` elapse, wait and then run another cycle.
- **A force is applied between scans.** That suits inputs. If the program
  assigns a forced variable, code before the assignment sees the forced value;
  code after it, in the same scan, sees the program's own value.
- **A reset releases forced values**, as does `codesys_sim_stop`.
- **No breakpoints or stepping.** CODESYS's scripting offers none.

## Live panel

**Views.** The panel switches view by what Claude is doing:

| View | Shows | Comes up when Claude… |
|---|---|---|
| Code | the object Claude is writing, live, with new lines marked; compile problems | writes, creates, renames, reverts or compiles |
| Review | the objects Claude changed since you last accepted, each with its added and removed line counts, Changes, Accept and Revert. In the chat, Changes shows the changed lines in place (red and green, two lines of context); in full screen it opens the object with the diff | has unreviewed changes and has been quiet for 20 s |

Click a view to stay on it; **Follow Claude** switches back to following. The
full-screen workspace has the same view tabs and lays itself out for each.

**Open workspace** on the chat card switches to full screen, or expands in
place where the client has no full screen. The workspace is laid out like
CODESYS:

- **Project tree** with badges: changed since you last reviewed it (A/M),
  compile errors and what Claude touched last (✦). There's a filter box.
- **Editor tabs** with the declaration above the implementation. Line numbers
  and text are as in CODESYS, and lines with compile errors or warnings are
  marked. **Diff** shows the changes since you last reviewed the object (at
  first, since the session started).
- **Bottom tabs:** problems from the last compile, and the review list.
- **Follow Claude** (on by default) opens whatever Claude edits.

When you open or select something, the panel tells Claude, so "fix this"
refers to what is on your screen.

- **Review:** an object Claude changed shows a bar with Show changes, Accept
  and Revert. Accept marks the current text as reviewed, and the badges and
  diff then compare with it. Revert writes the reviewed text back to
  CODESYS. Claude's `get_changes` still compares with the session start.
- **Pause Claude** (card and workspace): Claude's actions that change the
  project or the simulation answer `paused_by_user` until you resume. Its
  reading actions still work.

Claude's own changes always go through its actions. The panel never calls
CODESYS to read: the actions keep a project cache current as they work. The
one exception is Revert, which you start.
