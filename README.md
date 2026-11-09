# @codesys/mcp-toolkit

An MCP server that lets Claude (or any MCP client) read, write and compile
**Structured Text** in **CODESYS V3.5** projects.

Version 2 is a rewrite. CODESYS now stays open for the whole session instead
of cold-starting for every call. Tools work on the open project, compile
errors come back with object and line, and non-ASCII text survives the round
trip.

> **No real controller.** The toolkit doesn't log in or download to a
> controller. It goes online only to CODESYS's own simulation, which runs
> inside CODESYS, and every online call first checks that simulation mode is on.

## Requirements

- Windows with **CODESYS V3.5** and its **Scripting** add-on (tested with SP21
  and SP22 on Scripting 4.2, and SP21 on 4.1; SP16 and later should work)
- **Node.js 20** or later

Schneider EcoStruxure Machine Expert isn't supported yet. If you have it, the
[testing notes](docs/machine-expert-testing.md) help find out what works.

## Install

```bash
npm install -g @codesys/mcp-toolkit@next
```

Add the server to Claude Desktop (`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codesys": {
      "command": "codesys-mcp-tool",
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP21",
        "--workspace", "C:\\PLC\\Projects"
      ]
    }
  }
}
```

Both `--codesys-path` and `--codesys-profile` are optional. Without them the
server uses the newest CODESYS install under Program Files and its newest
profile.

| Option | Meaning |
| --- | --- |
| `--codesys-path <exe>` | `CODESYS.exe` to run |
| `--codesys-profile <name>` | Profile, e.g. `"CODESYS V3.5 SP21"` (file name in `CODESYS\Profiles`, without `.profile.xml`). A name that isn't installed is refused at start, with the installed ones listed |
| `--codesys-additional-folder <dir>` | CODESYS's add-on folder, passed as `--additionalfolder`. SP22 installs add-ons such as Scripting there; the toolkit finds `CODESYS\AdditionalFolders\Default` by itself |
| `--workspace <dir>` | Base folder for relative project paths (default: the working directory). Created if missing |
| `--project <file>` | Open this project as soon as CODESYS is up |
| `--session-dir <dir>` | Where session folders go (default: `%TEMP%\codesys-mcp-toolkit`) |
| `--no-autostart` | Start CODESYS on the first tool call instead of at launch |
| `--no-autosave` | Don't save after every change; use `save_project` |
| `--viewer-port <port>` | Port of the browser workspace on 127.0.0.1 (default 5180, or the next free one) |
| `--no-viewer` | Don't serve the browser workspace |
| `--no-shared` | Run CODESYS in this process instead of the shared session |

Claude Desktop may start the server more than once, for example one process
for the chat and one for the panel. All processes started with the same
options share one session: the first one starts a background owner that runs
CODESYS and the browser workspace, and the others connect to it over
127.0.0.1 with a token. So the panel always shows the project the chat is
working on, and only one CODESYS runs. The owner stops two minutes after the
last client disconnects. Its log is `daemon-<id>.log` in
`%LOCALAPPDATA%\codesys-mcp-toolkit`.

CODESYS starts in the background when the server launches. A cold start takes
1 to 3 minutes; later starts take about 10 seconds. `codesys_status` reports
progress without waiting.

### Several CODESYS versions

To keep SP21 and SP22 side by side, add one server entry per version, each
with its own `--codesys-path` and `--codesys-profile`. They get separate shared
sessions automatically. Without `--codesys-path` the server uses the newest
install, and its log says which one it picked and why.

`codesys_status` and the panel show the CODESYS install, the Scripting add-on
and the project's compiler version. The toolkit never updates a project's
compiler or library versions, and `open_project` says when they differ from
the running CODESYS. Each version keeps its own devices and libraries, so a
project from an older CODESYS may report missing libraries until you update it
in the CODESYS window. A project that needs a newer compiler opens, but can't
compile until you open it in that version.

## Tools

| Tool | What it does |
| --- | --- |
| `codesys_status` | Connection state, CODESYS version, last project. Never waits on CODESYS. |
| `open_project` | Open a `.project`, or a `.projectarchive` (extracted next to it, never over an existing project). Opened without version upgrades. Reports the compiler version and defines. Refuses to drop unsaved changes unless `discardChanges`. |
| `create_project` | New project from CODESYS's `Standard.project` (default), `empty`, or your own template file. |
| `save_project` / `close_project` | Save (optionally also as a `.projectarchive` snapshot), or close the project. |
| `get_project_tree` | Objects with their kinds. Graphical objects (SFC, CFC, LD, FBD) are marked `[non-ST]`, objects excluded from the build `[excluded from build]`. |
| `read_objects` | Declaration and implementation of up to 50 objects. Graphical bodies come as PLCopenXML (read-only). |
| `write_object` | Replace a declaration and/or implementation. The header must match the object (see below). |
| `create_object` | `program`, `function_block`, `function`, `method`, `property`, `action`, `interface`, `dut`, `gvl`, `folder`, optionally with code. |
| `delete_object` / `rename_object` | Delete or rename an object. |
| `search_code` | Text or regex search over all ST. |
| `compile` | Build the application and return errors and warnings with object, line and code. Also checks POUs no task calls (default); `deep` generates code too, `clean` builds from scratch. |
| `list_libraries` / `add_library` / `remove_library` | Library references. Add by title (`Util`, the newest installed unless you pass `version`) or full name (`Util, 3.5.17.0 (System)`). |
| `list_tasks` | Tasks with kind, interval, priority, event, watchdog and the programs they call. |
| `configure_task` | Create or change a task (kind, interval, priority, event, core, watchdog) and add the programs it calls. |
| `get_outline` | The project at a glance without reading every object: tasks and what they run, each POU's interface (inputs, outputs, methods, properties), interfaces, enums, structs, GVLs, tests. Pass `path` for one object in full or one folder. |
| `get_io_list` | Variables mapped to I/O (`AT %I…`, `%Q…`, `%M…` and the `%I*` / `%Q*` placeholders), with type, owner and comment, and the channels mapped to variables in the device tree. |
| `get_devices` | The device tree: identification, enabled state, and each device's I/O channels with the variable mapped to each (from CODESYS's I/O mapping export). |
| `get_library_api` | What a library offers. A referenced source library (`.library`) gives the real interface of its FBs, functions and types. A compiled library, or one the project doesn't reference yet, gives its objects and descriptions from CODESYS's library browser, without parameters. |
| `checkpoint` / `get_changes` / `revert_object` | Snapshots of the project's ST, and of graphical bodies as PLCopenXML (one is taken automatically when a project is opened: `session-start`), what changed since one (with a line diff per object), and putting an object back, including its methods and properties. A deleted SFC, CFC, LD or FBD object is re-imported from its XML. |

### Object paths

Paths are relative to the active application:

- `PLC_PRG` is a POU.
- `FB_Pump/Start` is a method.
- `FB_Pump/Speed/Get` is a property accessor.
- `Folder/FB_X` is an object inside a folder.

A leading `/` starts at the project root, e.g. `/Device/Plc Logic/Application/PLC_PRG`.

### Structured Text only

v2 reads and edits text objects only:

- POUs, methods, properties and accessors, actions
- interfaces
- DUTs and GVLs

Objects with graphical bodies appear in the tree, but you can't edit them as ST.

### Declaration checks

`write_object` and `create_object` reject a declaration that would change the
object's kind or name. For example, replacing a program's declaration without
its `PROGRAM X` line ([#5](https://github.com/johannesPettersson80/codesys-mcp-toolkit/issues/5)).
A GVL must start with `VAR_GLOBAL`; a property accessor holds only `VAR` blocks.

### What compile checks

A CODESYS build only compiles POUs that a task reaches. So `compile` marks
every other POU, GVL and DUT "link always" for that one build, then puts the
flags back. New code that nothing calls yet is checked too. If the project had
no unsaved changes before, it is saved again afterwards with the same content,
so nothing is left behind. Programs marked `{attribute 'test'}` are left out.
Pass `check_all: false` for CODESYS's plain build.

### Task calls

`configure_task` can add a program call to a task. CODESYS V3.5 SP21's
scripting can't remove one: `remove()` leaves the call in place. The tool
says so, and you remove it in CODESYS (Task Configuration > the task > select
the call > Remove Call).

## CODESYS simulation

`codesys_sim_start` compiles the project and loads it into CODESYS's own
simulation. It uses the real CODESYS compiler and libraries, needs no
controller and nothing installed beyond CODESYS.

| Tool | What it does |
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
  other tools that change the project are refused until `codesys_sim_stop`.
  The simulation setting on the device is never saved into your project.
- **It runs at real speed.** Timers follow the clock, even between single
  cycles: to let a `TON` elapse, wait and then run another cycle.
- **A force is applied between scans.** That suits inputs. If the program
  assigns a forced variable, code before the assignment sees the forced value;
  code after it, in the same scan, sees the program's own value.
- **A reset releases forced values**, as does `codesys_sim_stop`.
- **No breakpoints or stepping.** CODESYS's scripting offers none.

## Live panel

**In the chat.** Right after opening or creating a project, Claude opens the
panel inside the chat (clients with
[MCP Apps](https://modelcontextprotocol.io/extensions/apps)), so you watch
the project tree and the code as it is written.

**Views.** The panel switches view by what Claude is doing:

| View | Shows | Comes up when Claude… |
|---|---|---|
| Code | the object Claude is writing, live, with new lines marked; compile problems | writes, creates, renames, reverts or compiles |
| Review | the objects Claude changed since you last accepted, each with its added and removed line counts, Changes, Accept and Revert. In the chat, Changes shows the changed lines in place (red and green, two lines of context); in full screen it opens the object with the diff | has unreviewed changes and has been quiet for 20 s |

Click a view to stay on it; **Follow Claude** switches back to following. The
full-screen workspace has the same view tabs and lays itself out for each.

**In your browser, as a fallback.** In a chat that can't show MCP Apps,
`open_sim_panel` opens the same workspace in your default browser instead. It
is served on 127.0.0.1 only, with a random token in the link, and reaches
only the panel's own tools.

In the chat it is a compact card with the status (including a running CODESYS
simulation), the object Claude is working on, and how many objects changed
this session.

**Open workspace** switches to full screen, or expands in place where the
client has no full screen. The workspace is laid out like CODESYS:

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
- **Pause Claude** (card and workspace): Claude's tools that change the
  project or the simulation answer `paused_by_user` until you resume. Its
  reading tools still work.

Claude's own changes always go through its tools. The panel never calls
CODESYS to read: the tools keep a project cache current as they work. The
one exception is Revert, which you start. In clients without MCP Apps,
`open_sim_panel` returns a text snapshot.

## How it works

```
MCP client ──stdio── codesys-mcp-tool (Node)
                          │  requests/<id>.json  →   (JSON: op name + arguments)
                          │  ← results/<id>.json
                          │  ← heartbeat.json   (idle / busy + deadline)
                    CODESYS.exe --noUI --runscript=watcher.py
                          └─ watcher: preloaded op handlers (IronPython 2.7)
```

- **No generated code.** Requests are an operation name plus JSON arguments,
  handled by fixed functions in `watcher/mcp_ops.py`.
- **Hang detection.** The watcher reports `busy` with a deadline. If CODESYS
  blocks past it, the server kills it and starts a fresh one on the next call.
  Unsaved changes are lost, which is why changes are saved after every edit by
  default.
- **No orphans.** The watcher exits when the server process goes away.
- **Modal dialogs** are suppressed and logged, so they can't freeze CODESYS.
- **UTF-8** from end to end.
- **Localised names.** Object kinds come from CODESYS type GUIDs, not names,
  so a German task folder called `Taskkonfiguration` works.

Each session folder keeps `watcher.log` for troubleshooting.

## Troubleshooting

- **"CODESYS is still starting"**: the first start after boot can take
  minutes. Check `codesys_status`, then call the tool again.
- **`startup_failed` / `startup_timeout`**: check the profile name and that
  CODESYS starts by hand. The error includes the last lines of `watcher.log`.
- **Library errors after `create_project`** (e.g. `IoStandard`, [#4](https://github.com/johannesPettersson80/codesys-mcp-toolkit/issues/4)):
  the default template is brought up to the running CODESYS, so its libraries
  should resolve. A template you pass yourself is used as it is. If libraries
  are still missing, install them with the CODESYS Library Repository.
- **`hung` / `timeout`**: CODESYS was restarted. Re-open the project.
- **`dialog`**: CODESYS opened a dialog, named in the error, that a session
  without a window can't answer. CODESYS was stopped and restarts on the next
  call. Do the same step once in the CODESYS window, answer the dialog there,
  and try again.

## Development

```bash
npm install
npm test                                    # unit + bridge + tool tests (no CODESYS needed)
CODESYS_LIVE=1 npx vitest run test/live     # end-to-end against your CODESYS
npm run build                               # server + the single-file panel (dist/panel)
```

To work on the panel without Claude Desktop, run the dev host. It serves the
panel through the MCP Apps bridge, with the tank fixture as the CODESYS side:

```bash
npm run build:panel && node scripts/dev-host/run.mjs 5199
```

Then open http://localhost:5199. The numbered demo steps show Claude editing
and a compile with problems, and the Light/Dark switch changes the host theme
the way Claude Desktop would.

The normal tests run the **real watcher** under CPython 3 against a fake
`scriptengine` (`test/fake/`). This exercises the file queue, heartbeat,
hang/crash recovery, every op and every MCP tool without CODESYS. Watcher
code must stay valid IronPython 2.7: ASCII-only, no f-strings.

## Migrating from v1

- Tools no longer take `projectFilePath`. Call `open_project` once.
- `create_pou`, `create_method` and `create_property` are now `create_object`
  with a `kind`.
- `set_pou_code` is now `write_object`.
- `compile_project` is now `compile`, and it returns the errors.
- Read access is through tools (`read_objects`, `get_project_tree`) instead of
  resources, so it works in Claude Desktop
  ([#6](https://github.com/johannesPettersson80/codesys-mcp-toolkit/issues/6)).

## Acknowledgements

The persistent-watcher design borrows ideas from
[zbest1000/mcptoolkit-for-codesys](https://github.com/zbest1000/mcptoolkit-for-codesys)
(op-handler registry, heartbeat, prompt handling) and
[phobicdotno/Codesys-MCP-Master](https://github.com/phobicdotno/Codesys-MCP-Master)
(file-queue IPC, version-safe opening). Both are MIT-licensed.

## License

MIT
