# @codesys/mcp-toolkit

An MCP server that lets Claude (or any MCP client) read, write and compile
**Structured Text** in **CODESYS V3.5** projects.

Version 2 is a rewrite. CODESYS now stays open for the whole session instead
of cold-starting for every call. Tools work on the open project, compile
errors come back with object and line, and non-ASCII text survives the round
trip.

> **Offline only.** The toolkit never logs in, downloads to, or writes values
> on a controller. The watcher that runs inside CODESYS contains no online
> APIs, and a test enforces this.

## Requirements

- Windows with **CODESYS V3.5** (tested with SP21; SP16 and later should work)
- **Node.js 20** or later

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
| `--codesys-profile <name>` | Profile, e.g. `"CODESYS V3.5 SP21"` (file name in `CODESYS\Profiles`, without `.profile.xml`) |
| `--workspace <dir>` | Base folder for relative project paths (default: the working directory) |
| `--project <file>` | Open this project as soon as CODESYS is up |
| `--session-dir <dir>` | Where session folders go (default: `%TEMP%\codesys-mcp-toolkit`) |
| `--no-autostart` | Start CODESYS on the first tool call instead of at launch |
| `--no-autosave` | Don't save after every change; use `save_project` |
| `--trust-runtime <exe>` | `trust-runtime.exe` for the simulation (default: `TRUST_RUNTIME`, then `PATH`) |
| `--mirror-dir <dir>` | Where simulation mirrors go (default: `%LOCALAPPDATA%\codesys-mcp-toolkit\mirrors`) |
| `--no-sim` | Don't offer the simulation tools |

CODESYS starts in the background when the server launches. A cold start takes
1 to 3 minutes; later starts take about 10 seconds. `codesys_status` reports
progress without waiting.

## Tools

| Tool | What it does |
| --- | --- |
| `codesys_status` | Connection state, CODESYS version, last project. Never waits on CODESYS. |
| `open_project` | Open a `.project`. Opened without version upgrades. Refuses to drop unsaved changes unless `discardChanges`. |
| `create_project` | New project from CODESYS's `Standard.project` (default), `empty`, or your own template file. |
| `save_project` / `close_project` | Save, or close the project. |
| `get_project_tree` | Objects with their kinds. Graphical objects (SFC, CFC, LD, FBD) are marked `[non-ST]`. |
| `read_objects` | Declaration and implementation of up to 50 objects. |
| `write_object` | Replace a declaration and/or implementation. The header must match the object (see below). |
| `create_object` | `program`, `function_block`, `function`, `method`, `property`, `action`, `interface`, `dut`, `gvl`, `folder`, optionally with code. |
| `delete_object` / `rename_object` | Delete or rename an object. |
| `search_code` | Text or regex search over all ST. |
| `compile` | Build the application and return errors and warnings with object, line and code. |
| `list_libraries` / `add_library` | Library references. Use the full name, e.g. `Util, * (System)`. |
| `list_tasks` | Tasks with interval, priority and the POUs they call. |

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

### Compile caveat

CODESYS only compiles POUs that a task reaches. A POU nothing calls is not
checked, even if it contains errors.

## Simulation (truST)

The toolkit can run the project's Structured Text in the
[truST](https://github.com/johannesPettersson80/trust-platform) runtime against a
simulated plant. You or Claude can then step a setpoint, trip an interlock,
stop at a breakpoint, step through code and compare tuning runs.
CODESYS stays the source and the compile target.

> **Simulation only.** The simulation runs in a local `trust-runtime` process
> with the simulated I/O driver, on a control port on 127.0.0.1. The toolkit
> checks this configuration before every start, refuses anything else, and
> never connects to a controller. It reads the CODESYS project only through
> export and the task list.

### Setup

1. Install truST 0.33 (Windows zip from the
   [releases](https://github.com/johannesPettersson80/trust-platform/releases))
   and put `trust-runtime.exe` on `PATH`, or pass `--trust-runtime <path>`.
2. Install its compiler toolchain once (about 180 MB). The toolkit never
   downloads it for you:
   ```bash
   trust-runtime toolchain install
   ```
3. Describe the plant in `plant.toml` next to the project
   (`<Project>.plant.toml` or `plant.toml`), or let Claude pass it to
   `sync_mirror`:

```toml
[[plant]]
id = "T101"
model = "gravity_tank"                    # any truST plant model
inputs = ["GVL_IO.lrFV101_FlowCmd"]       # PLC -> plant, in channel order
outputs = ["GVL_IO.lrLT101_Level"]        # plant -> PLC
initial_state = [0.2]
[plant.parameters]
area_m2 = 1.0
outflow_coefficient_m2_sqrt_m_per_s = 0.03

[[feedback]]                              # simple device feedback, simulated in ST
signal = "GVL_IO.xXV101_Opened"
follows = "GVL_IO.xXV101_Open"
delay_ms = 2000                           # valve stroke time
```

Plant signals are wired by variable name. The mirror adds the `%I`/`%Q`
addresses truST needs. Plant variables must be in a GVL or a program, and be
BOOL, an integer type, REAL or LREAL.

### Tools

| Tool | What it does |
| --- | --- |
| `sync_mirror` | Export the project's ST into a truST project (the mirror) and save `plant.toml` if given. Reports what changed and what can't be simulated. |
| `sim_start` / `sim_stop` / `sim_status` | Build and start the simulation, paused at the start of a scan. |
| `run_scans` / `run_for` | Run an exact number of scans, or a span of simulated time at a given speed, then pause. |
| `set_breakpoint` / `clear_breakpoint` / `continue` | Breakpoints on CODESYS object lines, with an optional ST condition. `continue` returns the line, nearby source and locals. |
| `step_over` / `step_in` / `step_out` | Step through code, including into methods and FBs. |
| `read_vars` / `write_var` / `force_var` / `unforce_var` | Read, write or force variables (e.g. a sensor fault). |
| `set_plant_param` | Change a plant parameter for this session. The simulation restarts, because truST applies plant changes only on restart. |
| `run_experiment` / `experiment_log` | Repeatable runs from a fresh start: settings, a setpoint step, faults over time. Returns overshoot, rise and settling time, steady-state error and IAE, compared with the previous run of the same name. |

Paths are CODESYS paths: `PRG_Tank.nTrips`, `GVL_IO.rLevel`,
`PRG_Tank.fbPI.rY`, and `FB_PI/Reset` for breakpoints in a method.

### How the mirror works

`sync_mirror` writes one file per POU, with methods, properties and actions
nested into their FB. It also writes:

- a task configuration taken from the CODESYS tasks;
- `simulation.toml` from `plant.toml`;
- a small generated program, `MCP_SimHarness`, that counts scans and drives
  `[[feedback]]` signals;
- a line map, so breakpoints and build errors use CODESYS object names and
  line numbers.

The mirror lives in `%LOCALAPPDATA%\codesys-mcp-toolkit\mirrors\<project>`
(change it with `--mirror-dir`). It is a git repository with a commit per
sync. Objects with graphical bodies are reported and not simulated.

### Current limits

These come from truST 0.33; each is listed in
[`spike/trust-fidelity/TRUST-GAPS.md`](spike/trust-fidelity/TRUST-GAPS.md):

- **Repeatability.** truST can't start paused. Each fresh start runs a few
  scans before the toolkit can pause it, so identical experiments differ
  slightly (well under 1 % on the tank example).
- **Conditional breakpoints** are evaluated by the toolkit at each hit, so
  very frequent hits are slow.
- **Properties** can't be read or written in the simulation. Use the backing
  variable instead (`fbPI._rKp`).
- **Unsupported ST.** Some CODESYS-only constructs don't build yet, for
  example `VAR_INST`, implicit `FB_init` and `__ISVALIDREF`. `sim_start`
  reports them by CODESYS object and line. (`E_Mode.AUTO` enum literals work:
  the mirror rewrites them to the `E_Mode#AUTO` form truST needs.)
- **First scan.** A fresh start always completes one scan before handing
  over, so first-scan initialisation in your code has run. Settings written
  at the start of an experiment apply after it.

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
  the Standard template references libraries that must be installed in your
  CODESYS. Install them with the CODESYS Library Repository, or pass your own
  `template`.
- **`hung` / `timeout`**: CODESYS was restarted. Re-open the project.

## Development

```bash
npm install
npm test                                    # unit + bridge + tool tests (no CODESYS needed)
CODESYS_LIVE=1 npx vitest run test/live     # end-to-end against your CODESYS
npm run build
```

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
