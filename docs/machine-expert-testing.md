# Testing with Schneider EcoStruxure Machine Expert

Machine Expert is built on CODESYS V3.5. **V2.3 has been tested** (LogicBuilder.exe
V23.0.22.0, Scripting 4.1.0.0, on a PacDrive LMC project): start, `open_project`,
`get_project_tree`, `read_objects`, `compile`, `write_object`, `revert_object`,
`list_libraries`, `get_library_api`, `list_tasks`, `get_devices`, `get_io_list` and
simulation start/read/stop all work. Machine Expert has no profiles, so run it with
`--codesys-path` only; the toolkit then omits `--profile`. Other versions are untested.
The steps below find out what works on yours. Every result helps, including "it
failed at step 1" with the error text.

Use a copy of a project. `write_object` and the other changing actions save to it.

## 1. Get the toolkit

You need Node.js 20 or later.

```bash
git clone --branch v2 https://github.com/johannesPettersson80/codesys-mcp-toolkit.git
cd codesys-mcp-toolkit
npm install
npm run build
```

## 2. Find the program and the profile

- **Program:** usually `LogicBuilder.exe`, for example
  `C:\Program Files\Schneider Electric\EcoStruxure Machine Expert\V2.3\LogicBuilder.exe`.
  Please tell us the real path.
- **Profile:** V2.3 has none: omit `--codesys-profile` (or pass `""` to the probe).
  If your version has one, it is the name shown under Help > About or in the
  profile selection. Please also tell us whether there is a `Profiles` folder,
  where it is, and what the files in it are called.

## 3. Run the probe

This starts the program without a window, opens a copy of your project without
saving it, and records which scripting functions exist. It doesn't change your
project and doesn't go online.

```bash
node scripts/codesys-api-probe.mjs "<LogicBuilder.exe>" "" "<a .project file>" me-2.6.json
```

It writes `me-2.6.json` and related files next to it. **They contain user and
machine names, so check them before sharing.**

If it fails, the error includes what the program printed. That text is the most
useful thing to send, in particular whether the program accepts `--noUI`,
`--profile` and `--runscript`.

## 4. Try it from an MCP client

Add the server to your client (Cursor, Claude Desktop and so on):

```json
{
  "mcpServers": {
    "codesys_me": {
      "command": "node",
      "args": [
        "C:\\path\\to\\codesys-mcp-toolkit\\dist\\cli.js",
        "--codesys-path", "<LogicBuilder.exe>",
        "--workspace", "C:\\Projects\\MachineExpert"
      ]
    }
  }
}
```

Then try these in order, on a copy of a project, and note which work:

| Step | Action of the `codesys` tool | What it tells us |
| --- | --- | --- |
| 1 | `codesys_status` | It started, and which program and Scripting version it found |
| 2 | `open_project` | Projects open without a dialog |
| 3 | `get_project_tree`, `read_objects` | The project's objects are recognised |
| 4 | `compile` | Build results come back with objects and lines |
| 5 | `write_object`, then `compile` | Code can be changed |
| 6 | `list_libraries`, `get_library_api` | Libraries can be read |
| 7 | `codesys_sim_start`, `codesys_sim_read`, `codesys_sim_stop` | Simulation works on this controller |

`create_project` with its default template is expected to fail, because it looks
for CODESYS's `Standard.project`. Pass `template` as the path of a project to
copy instead.

## 5. The features beyond plain ST

The toolkit's newer features (HMI export, alarms, signatures, cross-references,
debugging, trace, device parameters, library pinning) use CODESYS's own .NET
services, and Machine Expert may ship a different set of them. `codesys_status`
checks which ones this program has: after a project is open, it lists them under
"Features", with what a missing one affects. Please send that list.

Then, on a copy of a project, try what the list says is there:

| Step | Action | What it tells us |
| --- | --- | --- |
| 8 | `get_signature` on a library FB you use | Library interfaces can be read |
| 9 | `find_references` on a variable | Cross-references work |
| 10 | `find_library` with part of a library name, then `pin_library` on a reference | The library repository is readable, and references can be pinned |
| 11 | `breakpoint_set`, `debug_status`, `debug_step`, `watch` (simulation running) | Debugging works on this controller |
| 12 | `device_parameters` on a device | Device parameters can be read |
| 13 | `hmi_save_screen`, then `hmi_export_codesys` | Native visualizations can be built (needs CODESYS Visualization) |
| 14 | `project_report`, `export_sources` | The handover report and the text export work |

## What to send back

- Machine Expert version, and the program path (and profile name, if any) you used.
- Which of the steps above worked.
- For anything that failed: the exact error text, and these logs:
  - `%LOCALAPPDATA%\codesys-mcp-toolkit\daemon-*.log`
  - `watcher.log` in the newest folder under `%TEMP%\codesys-mcp-toolkit`
