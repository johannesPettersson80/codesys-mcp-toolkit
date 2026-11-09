# CODESYS scripting: SP21, SP22, Scripting 4.1 and 4.2

Measured 9 November 2026 with `scripts/codesys-api-probe.mjs` on SP21
(3.5.21.0) and SP22 Patch 4 (3.5.22.40).

## The add-on version decides the API, not the service pack

| | Scripting 4.1.0.0 | Scripting 4.2.0.0 |
|---|---|---|
| SP21 | 266 types | identical to SP22 with 4.2 |
| SP22 | identical to SP21 with 4.1 | identical to SP21 with 4.2 |

- **SP22's "new scripting" comes from the add-on.** The release notes'
  scripting items (POU generation, compiler version, project defines) are in
  Scripting 4.2.0.0, and that add-on installs into SP21 as well.
- **SP22 keeps add-ons elsewhere.** They live in an additional folder
  (`CODESYS\AdditionalFolders\Default`), which CODESYS must be started with
  (`--additionalfolder`). The toolkit finds and passes it.

## New in Scripting 4.2 (over 4.1)

Found by .NET reflection of the scripting assemblies. 4.2 removed
`system.dump_scripting_api`, which 4.1 used to produce the full API.

| Interface | New members | Use for the toolkit |
|---|---|---|
| `IScriptIecLanguageObjectContainer4` | `create_program`, `create_function_block`, `create_function` | The "new POU generation methods". Could replace `create_pou(name, PouType)` |
| `IScriptProjectSettings2` (`project.project_settings`) | `compilerversion`, `set_compilerversion_to_newest`, `project_defines` (read and write) | Show the project's compiler version. Pass project defines to the simulation. Never update the compiler version without asking |
| `IScriptApplication4` | `is_uptodate`, `is_online_change_possible` | `is_uptodate` could tell when a build is current. The online one stays unused |
| `IScriptProject13`, `IScriptObject7` | `finish_load_project`, `find_ignore_transient_objects` | Waiting for a project to finish loading. Searching objects |
| `IScriptProjects6` | `open_archive` (new overload) | Opening `.projectarchive` files |
| `IScriptLibManObject3` | `download_missing_libraries` | Downloads from the internet: only on the user's explicit request |
| `IScriptPlaceholderReference`, `IScriptManagedLibraryReference` | placeholder resolution, managed library | Better `list_libraries` |
| `IScriptDriverInfo2`, `IScriptDeviceRequiredLib`, `IScriptDeviceInstance` | a device's required libraries and FB instances | Device tree (batch 4 of the SP21 plan) |
| `ISystem6` | `script_prompt_handling`, `process_script_prompts`, `log_prompt_details` | The watcher already uses `script_prompt_handling` when it exists |
| `IScriptValueDataElement`, `IScriptEnumerationDataElement` | `read_online_value`, `write_online_value` | Online: not used |
| `IScriptLiveDeviceUserManagement` and others | live device users and groups | Online: not used |

## Not there: debugging PLC code

Neither version has breakpoints, stepping or the call stack for PLC code.
- **Script debugging only:** the names with "debug" in them
  (`IScriptExecutor4.AttachToDebugger`, `DebuggingMode`) are for debugging the
  Python scripts themselves.
- **No change:** the online API is the same as in 4.1 (log in, start, stop,
  read, write and force values, download).

## Still broken in 4.2

- **Removing a task's program call:** `pous.remove(name)` returns without
  removing anything, and `pous.remove(index)` fails ("not found in the
  specified Collection"). Same on SP21 and SP22. Adding calls works.

## A note on the reflection list
Reflection reads only assemblies whose name contains "Script". Recipes, the
image pool and the Application Composer keep their scripting interfaces in
other assemblies. So they appear "removed" in a raw comparison with the 4.1
dump, but they are not.
