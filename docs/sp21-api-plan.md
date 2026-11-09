# Plan: use the whole SP21 scripting API (before SP22)

**Goal.** Make the toolkit complete and professional on CODESYS V3.5 SP21
before starting on SP22 ([sp22-plan.md](sp22-plan.md)). Use every offline
feature of the scripting API that helps writing, checking, simulating or
reviewing PLC code.

**Basis.** CODESYS's own description of its scripting API, from
`system.dump_scripting_api` on SP21 (ScriptEngine 4.1.0.0, about 250 scripting
types). The probe tools are described in sp22-plan.md, step 1.

**Rule that stays.** Nothing online: no login, download, online change,
writing or forcing values on a controller, gateways or boot applications. The
safety test (`test/watcher-safety.test.ts`) keeps enforcing this.

## Batches

Each batch ends with unit tests (fake scriptengine), a live test on SP21
(`CODESYS_LIVE=1`), README and CHANGELOG.

### 1. Compile everything, and deeper (`compile`)
- **`check_all: true`** runs `project.check_all_pool_objects()`, so POUs that no
  task calls are checked too. This closes the README's "compile caveat":
  Claude's new, not-yet-called FB gets its errors.
- **`deep: true`** runs `application.generate_code()` after the build. Code
  generation catches errors a plain build doesn't.
- **`clean: true`** first runs `application.clean()`, for a build from scratch.
- The messages keep object, line and code, as now.

### 2. Tasks (`configure_task`, `list_tasks`)
- Create a task: `task_config.create_task(name)`. If the application has no
  task configuration, `create_task_configuration()`.
- Set its kind (cyclic, freewheeling, event, status), interval and unit,
  priority, event, core binding and watchdog (enabled, time, sensitivity).
- Add, insert or remove program calls: `task.pous.add/insert/remove`. A
  program nothing calls never runs or compiles. CODESYS's own MCP server has
  this tool too.
- `list_tasks` also shows the watchdog, event and core binding.
- Annotation: destructive (it can remove calls and change timing).

### 3. Build properties and the mirror
- `read_objects` and the tree show each object's build properties:
  - excluded from build;
  - compiler defines (the application's);
  - link always;
  - external.
- The simulation mirror skips objects excluded from the build, as CODESYS does.
- The application's compiler defines go to the mirror. Whether truST honours
  `{IF defined (X)}` needs checking; if not, report it as a truST gap. Until
  then, warn when code uses `{IF` with defines.

### 4. Device tree and I/O mapping
- `get_io_list` adds the device tree's channel mappings, from
  `device.export_io_mappings_as_csv(path)` per device. Channels mapped to
  variables in the device tree aren't in the ST, so today the toolkit can't see
  them.
- A new read-only `get_devices` lists the device tree:
  - devices, identification and enabled state;
  - connectors;
  - the main parameters.
- The simulation mirror uses those mappings to wire plant signals to the
  mapped variables.

### 5. Graphical objects and complete review (PLCopenXML)
- `read_objects` returns the PLCopenXML of graphical bodies (SFC, CFC, LD, FBD)
  through `export_xml`, so Claude can read them. They stay read-only.
- Checkpoints store the XML of objects that aren't ST, so `get_changes` and
  `revert_object` cover them (`import_xml` to revert).
- Optional: `compare_to(project)` for CODESYS's own comparison against a
  checkpoint file (devices, task configuration).

### 6. Projects
- `open_project` accepts `.projectarchive` files (`open_archive`), opening a
  copy next to the archive.
- `save_project` can also write an archive (`save_archive`), e.g. before a big
  change.
- Project info: author, version, released, default namespace. Mainly for
  libraries.

### 7. Speed on big projects
- Use `get_signature_crc` to see which objects changed, instead of exporting
  all the text, when refreshing the project cache.

### 8. Libraries
- `remove_library`, placeholders (`add_placeholder`).
- Reference details: namespace, qualified-only, optional, dependencies.

### 9. Smaller things
- Compile messages: use `position`, `position_offset` and `length` where they
  give an exact column and length.
- Symbol configuration (read-only): which variables are published to OPC UA
  or an HMI.

## Progress

**Batches 1 and 2 done (9 November).** Live-tested on SP21: 14 of 14 pass.
- **`check_all_pool_objects()` is the wrong tool.** It checks CODESYS's separate
  POU pool, not the application. Worse, it clears the build's messages: a real
  type error showed as "0 errors".
- **What works instead:** set `build_properties.link_always` on every POU, GVL
  and DUT for one build, then restore. Unit tests and objects excluded from the
  build are skipped. A project without unsaved changes is saved again
  afterwards (same content).
- **`generate_code()` builds too.** So `deep` replaces the build rather than
  following it.
- **Removing a program call from a task is impossible through SP21's
  scripting.** The collection's items are strings: `pous.remove(name)` returns
  without removing anything, and `pous.remove(index)` fails with "Cannot remove
  the specified item because it was not found in the specified Collection" for
  index 0 and 1. The tool refuses with an explanation. Retest on SP22.
- **Task settings:** a task's `core_binding` is -2 when it isn't bound to a
  core.

### 10. Scripting 4.2 additions (behind feature checks)
The Scripting add-on 4.2.0.0 also installs into SP21; see
[codesys-api-sp21-sp22.md](codesys-api-sp21-sp22.md). Use when present, and
fall back to 4.1:
- `create_program`, `create_function_block` and `create_function` in
  `create_object`;
- `project_settings.compilerversion` in `codesys_status`, and
  `project_defines` for the simulation mirror (batch 3);
- `application.is_uptodate`, so `compile` can say a build is current;
- the device's required libraries and instances, for the device tree
  (batch 4).

**Batches 3, 4, 6 and 8 done; 5 and 10 partly (9 November).** Live on SP21
with Scripting 4.2: 17 of 17 pass.

- **3. Build properties:**
  - Excluded objects are marked and left out of the simulation.
  - The application's compiler defines are read (`build_properties.compiler_defines`).
  - truST can't take defines (TRUST-GAPS A8). So the mirror resolves
    `{IF defined (X)}` / `project_defined` / `{define}` itself, line for line
    (`src/sim/conditionals.ts`).
- **4. Devices:**
  - `get_devices` shows the device tree, and `get_io_list` the device-tree
    mappings, from `export_io_mappings_as_csv` ("CoDeSys Mapping Export V1.2",
    comma-separated, `//` header lines).
  - Not yet verified with real channels: scripted `add()` of I/O devices
    needs the right connector, and this repository has no simple I/O terminal.
    The parser is tested on CODESYS's header format.
- **5. PLCopenXML:**
  - `read_objects` returns graphical bodies (SFC tested live: an SFC created
    with `create_pou(..., ImplementationLanguages.sfc)`), compacted to the
    `<pou>` element without `addData`.
  - Not done: review and revert of graphical objects through `import_xml`.
- **6. Archives:**
  - `open_project` takes a `.projectarchive` (`open_archive(archive, project,
    overwrite=False, ..., NoUpdates|SilentMode)`).
  - `save_project` takes `archive` (`save_archive`).
- **8. Libraries:** `remove_library`, checked against the list afterwards.
- **10. Scripting 4.2:**
  - The compiler version (`project_settings.get_compilerversion()`, a method)
    and the project defines are read.
  - `create_program`, `create_function_block` and `create_function` take the
    same inputs as `create_pou`, so they aren't used.

**Still open:**
- batch 5's review and revert of graphical objects;
- batch 7 (`get_signature_crc` for faster cache refreshes);
- batch 9 (exact message columns, symbol configuration);
- device I/O with real channels.

## Order
Batches 1 and 2 first: they fix gaps a user hits on day one. Then 3 and 4,
which make the simulation match the real project. Then 5 to 9.
