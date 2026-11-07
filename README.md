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
