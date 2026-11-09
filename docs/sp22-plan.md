# Plan: CODESYS V3.5 SP21 and SP22 side by side

**Goal.** One toolkit that works with both SP21 and SP22 (and later service
packs).
- **The setup picks the version:** `--codesys-path` and `--codesys-profile`.
- **The toolkit adapts at runtime:** it uses SP22's additions only where they
  exist and keeps SP21's way otherwise.
- **Both are tested.** Today v2 is tested on SP21 only. The README says
  "SP16 and later should work".

## What we know about SP22

| | Fact | Source |
|---|---|---|
| Release | V3.5 SP22, 24 March 2026, long-term support; Patch 1 is 3.5.22.10 | CODESYS news, release notes |
| Scripting | IronPython 2.7 as before; CODESYS Scripting add-on 4.2.0.0 | Release notes |
| New scripting | "New specific methods for POU generation, access to compiler version and project defines via script". The exact names are not documented online | SP22 announcement |
| Windowless mode (`--noUI`) | A timer now raises `Application.Idle` every 10 ms (CDS-94258); new `--noExit` (CDS-94708) | Release notes |
| Opening projects | New dialogs while a project opens: a "trust project" dialog (CDS-95557), and project inspection with a fixed dialog order and add-on prompts (CDS-94738, CDS-95328) | Release notes |
| Compiler | New compiler version 3.5.22 (CDS-92730). Many fixes apply only with "compiler version >= 3.5.22.0" | Release notes |
| SP21 projects | Fixes for SP21 projects, e.g. CDS-94861 (a wrong checksum makes SP21-loaded projects offer an online change) and CDS-95496 (CAN). Both are online topics; v2 never goes online | Release notes |

## What in the toolkit depends on the version

| Where | Today | Risk on SP22 |
|---|---|---|
| `watcher/watcher.py` `setup_prompts` | Tries `script_prompt_handling = LogPrompts`, falls back to SP21's `prompt_handling` | **High:** the new dialogs at project open must not block `--noUI` |
| `watcher/mcp_ops.py` `GUID_KIND` | Object type GUIDs "verified against SP21" | Medium: a changed GUID shows as an unknown kind |
| `op_project_open` | `VersionUpdateFlags.NoUpdates \| SilentMode` | Low: keeps the project's versions. Confirm SP22 honours it |
| `op_object_create` | `create_pou`, `create_method`, `create_property`, `create_interface(name, "")`, ... | Low; SP22's new methods may do it better |
| `op_build` | `app.build()` plus the message categories | Low; new message texts |
| `src/codesys/install.ts` | Without `--codesys-path`, picks the newest install | **Changes behaviour:** installing SP22 makes it the default for setups without a path. Claude Desktop's config names SP21, so it stays on SP21 |
| `install.ts` profile order | Sorted as text, newest first | Bug: "SP9" sorts above "SP21". Fix with a numeric sort |
| `test/live/*` | Use the newest install and its newest profile | Can test only one version per run |

## Steps

### 1. Compare the scripting API of SP21 and SP22 (first thing after install)
- Add a probe operation to the watcher. It lists the public members of `se`,
  `se.system`, `se.projects`, a project, an application, a POU, a method, a
  text document, and the `VersionUpdateFlags`, `PouType` and prompt enums.
- Run it in SP21 and SP22, and save the difference as
  `docs/codesys-api-sp21-sp22.md`. This finds the real names of the new POU
  methods and of the compiler-version and project-defines accessors.
- Check `GUID_KIND` against the kinds SP22 reports for each object type.

*Done when:* the API difference is written down, and every object type in the
test projects maps to the same kind on both versions.

**Progress (SP21 side done, 9 November).**
- **The probe:** the watcher operation `api.probe` and
  `scripts/codesys-api-probe.mjs <CODESYS.exe> "<profile>" <project> <out.json>`.
  It opens a copy of a project and never saves.
- **The comparison:** `scripts/codesys-api-diff.mjs <old.json> <new.json> [out.md]`.
- The raw probe files stay in `spike/codesys-api/` and are ignored by git: they
  hold the user and machine names.

What the SP21 probe found:
- **The full API is available.** `system.dump_scripting_api(path)` writes it as
  structured JSON: every entry point, type, member and parameter, about 23 MB.
  The diff compares those dumps. Plain `dir()` lists nothing on CODESYS's
  project and object wrappers, so the probe falls back to .NET reflection for
  their base members.
- **Version line:** "CODESYS V3.5 SP21, ScriptEngine.plugin 4.1.0.0"; 266
  scripting types.
- **Object types:** the probe walks the whole project, so 3 GUIDs show as
  unknown: Plc Logic, Project Settings and `__VisualizationStyle`. They lie
  outside the application the toolkit works in, so this is expected.
- **Defines already exist in SP21.** Application-level compiler defines are
  readable through `build_properties.compiler_defines` (`IScriptBuildProperties`),
  so step 5 can start on SP21. SP22's "project defines" are probably the
  project-level ones.
- **Compiler version:** SP21 has no accessor for it. That one is new in SP22.

**SP22 install (3.5.22.40, profile "CODESYS V3.5 SP22 Patch 4", 9 November).**
The first start failed: "The command line option 'runscript' has been set.
However, there is no script engine implementation available."
- The install has 125 plug-in folders against SP21's 245, and no
  ScriptEngine plug-in. The "CODESYS Scripting" add-on is installed
  separately.
- The bridge now keeps the end of CODESYS's console output and says this
  plainly (`startupHint` in `src/bridge/bridge.ts`). Before, the only message
  was "exited during startup (exit code 0)".

**The additional folder (9 November).** In SP22, add-ons go into
`CODESYS\AdditionalFolders\Default`. CODESYS's own shortcuts start it with
`--additionalfolder="…\AdditionalFolders\Default"`. Without that, CODESYS
can't find the Scripting add-on even once installed.
- The toolkit now finds that folder, reads profiles from it and passes it (see
  `findAdditionalFolder` in `src/codesys/install.ts`).
- `--codesys-additional-folder` overrides it.

**First SP22 results (Scripting 4.1.0.0 installed into SP22).**
- **API:** the probe shows the same API as SP21: 266 scripting types, no
  differences (`docs/codesys-api-sp21-sp22.md`). The add-on installed was
  4.1.0.0; SP22's release notes list Scripting 4.2.0.0. The new SP22 functions
  need 4.2.
- **No breakpoints:** neither version's scripting API has breakpoints,
  stepping or the call stack.
- **The live suite on SP22: 9 of 14 pass.** Everything except compiling works:
  creating from the template, writing, reading, search, outline, the I/O list,
  libraries and status.
- **The 5 compile tests failed** because of the stale `Standard.project`. This
  note first blamed an incomplete install, which was wrong; see Status below.
- **Opening an SP21 project in SP22 works** (`TankTune.project` in the probe).

### 2. Make the live tests run against a chosen install
- Already there: `test/live/live.test.ts` and `test/live/sim.live.test.ts` read
  `CODESYS_PATH` and `CODESYS_PROFILE`. Without them, they use the newest
  install.
- Run the live suite (`CODESYS_LIVE=1`) on SP21 and on SP22, with the truST
  live tests too.
- Retest removing a task's program call: SP21's `pous.remove` can't (see
  sp21-api-plan.md).
- Look especially at:
  - start-up in `--noUI` (the Idle timer change);
  - opening projects: the trust and inspection dialogs must be logged and
    suppressed, not left waiting;
  - opening an SP21 project in SP22, and an SP22 project in SP21.

*Done when:* the live suite passes on both versions, or each failure has its
own fix step below.

### 3. Handle the new dialogs at project open
- If step 2 shows a dialog that `LogPrompts` doesn't suppress, find its scripting
  switch (from the step 1 API list). Otherwise, answer it with a safe default:
  never "trust" or install anything silently. Report it to the user and refuse
  to continue.
- The watcher's hang detection must turn any remaining modal dialog into a
  clear error, not a 2-minute timeout.

### 4. Show which CODESYS and compiler a session uses
- `codesys_status`, `open_project` and the panel show:
  - the CODESYS install and profile (already known);
  - the Scripting add-on version;
  - the project's compiler version, when SP22's accessor exists.
- When the project was saved by a different version than the one running, say
  so on opening:
  - an SP21 project in SP22 keeps its compiler version (`NoUpdates`). Nothing
    changes unless the user updates it in CODESYS;
  - an SP22 project in SP21: report CODESYS's refusal plainly, with the
    version the project needs.
- The toolkit never updates a project's compiler or library versions on its
  own.

### 5. Use SP22's additions where they help (behind feature checks)
- **Project defines → the truST mirror.** This is the most useful addition.
  - Conditional compilation (`{IF defined (X)}`) depends on the project's
    defines, so the simulation can only match CODESYS if the mirror knows them.
  - Read them on SP22 and pass them to truST. Whether truST understands
    `{IF defined}` needs checking; if not, report it as a truST gap.
  - On SP21, say the defines are unknown when the code uses `{IF`.
- **POU generation.** Use the new methods if they create an object with its
  declaration and implementation in one step, or keep the declaration
  formatting better. Fall back to the current calls on SP21.
- **Compiler version.** Show it (step 4). Use it to explain compile differences
  between versions.

### 6. Choosing the version
- ~~Fix the profile sort: numeric, with Patch numbers.~~ Done:
  `compareProfiles` in `src/codesys/install.ts`, tested in
  `test/install.test.ts`.
- Keep the newest install as the default when no path is given, but log which
  one was picked and why.
- *Later, optional:* pick the install that matches the project's saved version
  automatically, so SP21 projects open in SP21 and SP22 projects in SP22. It
  needs a reliable way to read a project's version without opening it. Find
  out in step 1.

### 7. Docs
- README requirements: "tested with SP21 and SP22".
- How to run two versions side by side: one setup per version, each with its
  own `--codesys-path`. They get separate shared sessions automatically,
  because the session key includes the arguments.
- How to tell which version a chat uses: `codesys_status`, the panel.
- CHANGELOG.

## Status (9 November)

Live, with Scripting 4.2 and truST 0.34: **SP21 24 of 24, SP22 24 of 24.**

**The SP22 compile failures were a toolkit bug, not the install.**
- SP22 keeps its own repositories in `C:\ProgramData\CODESYS_D9B3C5D6`, with
  Control Win 3.5.22.40, `IoStandard` 3.5.22.0 and the rest. The first checks
  looked only in `C:\ProgramData\CODESYS` and wrongly called the install
  incomplete. The Compatibility Package missing from SP22 doesn't matter here.
- SP22's shipped `Standard.project` names compiler 3.5.19.40, device 3.1.3.0
  and `IoStandard, 3.1.3.1`. It gives the same errors in SP21. SP21 passed only
  because its copy on this machine is dated four days after the install and
  already names 3.5.21.0.
- `create_project` with the standard template now uses `project.open_new`. It
  opens the new copy with `UpdateAll`, moves the device to the newest version
  in the repository, saves and reopens. The reopen matters: CODESYS keeps
  reporting the old template's load errors until then. A template the user
  names and a project the user opens are never updated.

**By step.**
- **1. Done.** All 17 object types in `TankTune` map to the same kind on both
  versions. The same 3 GUIDs, outside the application, are unknown on both.
- **2. Done.**
  - Start-up in `--noUI` takes about 9 s on SP22.
  - Opening across versions works both ways, with no refusal and no dialog.
    Compiling is another matter:
    - An SP21 project in SP22 has 5 errors until it is updated in CODESYS:
      its device and libraries aren't in SP22's repositories.
    - An SP22 project in SP21 can't compile: "The configured compilerversion
      '3.5.22.40' is not available in your installation".
  - The baseline run found a bug on any version: the watcher read request
    files without retrying, so a file held for a moment failed the call with
    `bad_request`. Fixed, with a test that fails on the old code.
- **3. Done.** No dialog appeared at project open. For any that does, the
  watcher now has a background thread:
  - It looks for modal forms and for a process main window, which a session
    without a UI otherwise doesn't have.
  - A dialog up for 10 s goes into `dialog.json`. The bridge then stops CODESYS
    and answers with error `dialog`, naming it. It never answers the dialog.
  - Verified on SP21 and SP22 with real WinForms dialogs and message boxes:
    about 14 s to the error, a clean restart on the next call, and a shorter
    dialog left alone. It didn't fire in either live suite.
- **4. Done.** `codesys_status`, `open_project` and the panel show the install,
  the Scripting version and the compiler version. `open_project` says when a
  project needs a newer compiler than the running CODESYS has.
- **5. Done.** Defines are in the mirror (`src/sim/conditionals.ts`). With
  Scripting 4.1, `project_defined` blocks are left for truST and reported.
  The new POU methods take the same inputs as `create_pou`, so they aren't used.
- **6. Done, except the optional automatic match.** The server log says which
  install was picked and why.
- **7. Done.**

## Out of scope
- **CODESYS's own Development System MCP Server.** It needs SP22.1, a
  Professional Developer Edition subscription and the visible IDE. Revisit if
  the subscription is there.
- **CODESYS 4 ("go!", 1.0.0.0, 24 September 2026).** Web-based, limited, and
  aimed at libraries for now.
- **Anything online.** v2 never logs in, downloads or goes online, on any
  version.

## Order and size
Step 1 and step 2 come first and tell us how big steps 3–5 are. If SP22 opens
and runs the suite unchanged, steps 3–5 are small additions. The likely work is
in the new open dialogs (step 3) and the defines in the mirror (step 5).
