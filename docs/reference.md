# Reference

The full detail behind the [README](../README.md): every action, how paths and
checks work, the simulation's behaviour and the live panel.

- [Actions](#actions)
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
| `read_objects` | Declaration and implementation of up to 50 objects. Graphical bodies come as PLCopenXML (read-only). |
| `write_object` | Replace a declaration and/or implementation. The header must match the object (see [Declaration checks](#declaration-checks)). |
| `create_object` | `program`, `function_block`, `function`, `method`, `property`, `action`, `interface`, `dut`, `gvl`, `folder`, optionally with code. |
| `delete_object` / `rename_object` | Delete or rename an object. |
| `search_code` | Text or regex search over all ST. |
| `compile` | Build the application and return errors and warnings with object, line and code. Also checks POUs no task calls (default); `deep` generates code too, `clean` builds from scratch. |
| `list_libraries` / `add_library` / `remove_library` | Library references. Add by title (`Util`, the newest installed unless you pass `version`) or full name (`Util, 3.5.17.0 (System)`). |
| `get_library_api` | What a library offers. A referenced source library (`.library`) gives the real interface of its FBs, functions and types. A compiled library, or one the project doesn't reference yet, gives its objects and descriptions from CODESYS's library browser, without parameters. |
| `list_tasks` | Tasks with kind, interval, priority, event, watchdog and the programs they call. |
| `configure_task` | Create or change a task (kind, interval, priority, event, core, watchdog) and add the programs it calls. |
| `get_outline` | The project at a glance without reading every object: tasks and what they run, each POU's interface (inputs, outputs, methods, properties), interfaces, enums, structs, GVLs, tests. Pass `path` for one object in full or one folder. |
| `get_io_list` | Variables mapped to I/O (`AT %I…`, `%Q…`, `%M…` and the `%I*` / `%Q*` placeholders), with type, owner and comment, and the channels mapped to variables in the device tree. |
| `get_devices` | The device tree: identification, enabled state, and each device's I/O channels with the variable mapped to each (from CODESYS's I/O mapping export). |
| `checkpoint` / `get_changes` / `revert_object` | Snapshots of the project's ST, and of graphical bodies as PLCopenXML (one is taken automatically when a project is opened: `session-start`), what changed since one (with a line diff per object), and putting an object back, including its methods and properties. A deleted SFC, CFC, LD or FBD object is re-imported from its XML. |
| `open_workspace` | Open the live workspace in the browser. |

The simulation actions are listed under [CODESYS simulation](#codesys-simulation).

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
