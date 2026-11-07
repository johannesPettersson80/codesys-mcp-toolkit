# truST gaps found while simulating CODESYS code

truST v0.33.0, Windows x64, `vendor_profile = "codesys"`, CODESYS V3.5 SP21
as the reference. Found during the Phase 0 spike on 2026-11-07.

Every "CODESYS" claim below was checked by building the same code in CODESYS
SP21 with the code actually called from a task, which gave 0 errors and
0 warnings. Unreferenced POUs aren't compiled by CODESYS, so they prove
nothing.

Repros live in [`repros/`](repros/). Run them with:

```bash
python -I run_repro.py <path>/trust-runtime.exe              # all cases
python -I run_repro.py <path>/trust-runtime.exe var_inst      # one case
```

`run_repro.py` copies a case into a fresh temp project built from
[`trust-template/`](trust-template/) and runs `trust-runtime check`.

## A. Language: blocks real CODESYS projects

Sorted by how often the construct appears in real CODESYS code.

| # | Gap | Repro | truST today | CODESYS |
|---|-----|-------|-------------|---------|
| A1 | **Dotted enum literal `E_Mode.MANUAL`** | `enum_local_only`, `enum_noattr`, `enum_qualified_gvl` (passing controls: `enum_iec_hash`, `enum_bare`) | `the name E_Mode is not compiled yet (specification 44 NX-09)`. Fails with or without `{attribute 'qualified_only'}`. `E_Mode#MANUAL` and bare `MANUAL` work. | The standard CODESYS form. `qualified_only` enums *require* it. |
| A2 | **Method with a return type and no assignment to it** | `method_no_return` | `error[E206]: missing return value` | Accepted: no error, no warning, and the result is the type's default. Every new method that CODESYS scaffolds starts like this. Empty property `GET` bodies already pass in truST, so the two are inconsistent. |
| A3 | **Untyped real literal passed to a REAL parameter**: `REAL_TO_INT(2.5)` | `untyped_real_literal` | `error[E205]: expected 'REAL' for parameter 'IN'` | Accepted. `REAL_TO_INT(REAL#2.5)` works in truST and gives 3, the correct CODESYS rule. |
| A4 | **`FB_init` not called implicitly** | `fb_init_implicit` (passes `check`; this is a runtime difference) | `FB_init` is an ordinary method that never runs. The marker it sets reads 0. | Called automatically when an instance is initialised. Runs before the first cycle, with `bInitRetains` and `bInCopyCode`. `FB_reinit` and `FB_exit` are related and also missing. |
| A5 | **`VAR_INST` in methods** | `var_inst` | Parse error `expected ';'` at `nCalls : INT;` | Instance-scoped method variables that keep their value between calls. |
| A6 | **`__ISVALIDREF(ref)`** | `isvalidref` | Parse error `expected expression` | Built-in operator. Commonly used with `REFERENCE TO`. |
| A7 | **Implicit base `EXTENDS __System.IQueryInterface`** | `iqueryinterface` | Parse error `expected METHOD or PROPERTY in interface`. The message points at `EXTENDS`, not at an unknown type. | CODESYS `create_interface()` adds this base by default, so every scripted interface carries it. **Option:** accept it and ignore it under the codesys profile, or treat it as a known built-in. (The v2 mirror strips it for now.) |

Not tested yet; likely next on the list: `__QUERYINTERFACE`, `__TRY`/`__CATCH`,
`FB_reinit`, `FB_exit`, `SUPER^`/`THIS^` with the `^`, `{attribute ...}`
pragmas beyond `qualified_only`, and CODESYS libraries (Util, CAA).

## B. Runtime control / tooling: blocks driving truST from another tool

| # | Gap | Detail |
|---|-----|--------|
| B1 | **No way to set a conditional breakpoint from outside the DAP adapter** | `breakpoints.set` only takes a *compiled* expression (`expr_version` + base64 bytecode). The compiler lives inside `trust-debug` (`crates/trust-debug/src/adapter/...`), and `ctl breakpoints-set` has no `--condition`. **Ask:** a control or CLI method that compiles ST expression text, e.g. `debug.compile_expression {text, scope}` → `{expr_version, expr}`, or let `breakpoints.set` and `eval` take `text` and compile it host-side on trust-runtime. |
| B2 | **`trust-debug` isn't in the Windows runtime or LSP zips** | It ships only inside the 327 MB VSIX. A standalone `trust-debug.exe` in `trust-runtime-win32-x64.zip` would let other tools use DAP. |
| B3 | **`eval` can't read properties** | `ctl eval TankInst.fbPI.Kp` → `unknown identifier`. The backing field `_rKp` works. A property read should call `GET`. |
| B4 | **`eval` values are Rust `Debug` strings** | e.g. `"LReal(0.738…)"`, `"UDInt(1)"`, `"String(\"OK\")"`, `"Enum(EnumValue { type_name: \"E_TankMode\", variant_name: \"AUTO\", numeric_value: 1 })"`. **Ask:** typed JSON like the agent API uses, `{"type":"LREAL","value":0.738}`, plus `{"type":"E_TankMode","value":"AUTO","numeric":1}` for enums. |
| B5 | **Breakpoint lines: 1-based in, 0-based out** | `ctl breakpoints-set src/PRG_Tank.st 29` returns `resolved: [{line: 28}]`, and `breakpoints-list` says `line: 28`. Pick one convention for the CLI, or label the field `line0`. |
| B6 | **`ctl` has no stack, location or variables commands** | The protocol has `debug.stops`, `debug.stack`, `debug.scopes` and `debug.variables`, but the CLI only shows `state=paused`. Paused at *where* isn't visible from the CLI. (v2 will speak the protocol directly, so this is low priority.) |
| B7 | **`build` silently downloads the ~181 MB toolchain** | With no toolchain installed, `trust-runtime build` installed it into `%LOCALAPPDATA%\trust\toolchains\0.33.0` without a prompt or flag. That's a surprise on metered or offline machines. **Ask:** fail with a clear message, or require `--install-toolchain` / `toolchain install` first. |
| B8 | **Windows build writes `build/install.x86_64-unknown-linux-gnu.bin`** | The host is Windows x64. Either the name is wrong or the target triple is. |
| B9 | **Startup overrun at `--time-scale 10`** | One `TRUST-RT-OVERRUN-001` (`missed: 17`) right after start, then none. Probably catch-up during startup, but it shows up as a warning in every run. |
| B10 | **Plant wiring is by `%I/%Q` address only** | CODESYS code usually maps I/O symbolically. Being able to wire `simulation.toml` plants to variable paths (`GVL_IO.lrLT101_Level`) would remove the need for generated `AT` mappings. (Nice-to-have: v2 can generate the mapping.) |

### Found in Phase 2 (driving truST from the v2 simulation tools)

The v2 toolkit works around each of these. The workaround is named so it can be removed once truST changes.

| # | Gap | Detail |
|---|-----|--------|
| B11 | **`set` and `var.force` can't target a property** | `set {target: "global:PRG_Tank.fbPI.Kp", value: "70.0"}` answers `unsupported value '70.0'`. The *value* is blamed, but the problem is the property target. Same root as B3. **Ask:** a property write calls `SET`, and the error names the target. *Workaround:* write the backing variable (`fbPI._rKp`). |
| B12 | **Value grammar rejects the CODESYS enum form** | `set`/`var.force` take `E_TankMode#AUTO` but refuse `E_TankMode.AUTO` (`unsupported value`). Under the codesys profile, accept `E.X` too. *Workaround:* the toolkit rewrites `E.X` to `E#X`. |
| B13 | **Control `restart` doesn't reset the plant, and the plant runs during the restart** | `restart {mode:"cold"}` resets PLC memory (scan counter 0, `bInit` TRUE again) but the `gravity_tank` level carries over, although `plant.status` reports `restart_policy: reset_on_cold_and_warm_restart`. Worse, the plant keeps stepping while the restart runs with no scans: at time scale 50 the level drained about 20 s of simulated time with 0 scans. Lockstep is broken during a restart. **Ask:** a cold restart resets plants to `initial_state` and holds plant time until the first scan. *Workaround:* the toolkit restarts the whole process for a clean start (about 1.5 s). |
| B14 | **No way to start paused (stop on entry)** | `play` always starts scanning. A tool can only pause once the control endpoint answers, so 5 to 140 scans have already run (they vary per start), and two identical experiments differ slightly (about 0.3 % here). **Ask:** `play --paused`, or `[runtime.control] start_paused = true`, holding before the first scan with plant time at 0. *Workaround:* the toolkit sends `pause` as its first request and reports the scan it stopped at. |
| B15 | **Plant status and trace are unavailable while paused** | After any pause or breakpoint, `plant.status` and `plant.trace.read` answer `active plant runtime evidence is unavailable` until the program runs again. That is exactly when a debugger wants to show the plant. *Workaround:* read the plant-wired PLC variables with `eval`. |
| B16 | **Build and check diagnostics are text with byte offsets** | `check --json` puts every diagnostic of a file into one `message` string (`src/X.st: expected ';' at 113..119\n...`). `build` prefixes with `Error: `. **Ask:** structured diagnostics `{file, line, column, end_line, end_column, code, severity, message}` in `--json`, for build too. *Workaround:* the toolkit parses the text and converts byte offsets to lines. |
| B17 | **`var.force` on a variable mapped to `%I` doesn't reach the program** | With `lrLevel AT %IL0` fed by a plant, `var.force global:GVL_IO.lrLevel` answers `forced`, but the program keeps seeing the plant value (the input image overwrites it each scan), so an interlock never trips. `io.force %IL0` works. **Ask:** a variable force on an I/O-mapped variable forces the I/O point, or is refused with a hint. *Workaround:* the toolkit forces plant-wired variables with `io.force` on their address. |
| B18 | **Each resume costs at least ~15 ms of wall time on Windows** | `resume` → 10 scans → harness breakpoint took 15 ms at time scale 100 (1 ms of scan time). Control requests themselves take 0.15 ms. This looks like the default Windows timer resolution in the scheduler's sleep. It caps sampled experiments at about 65 samples per second. **Ask:** a high-resolution timer (`timeBeginPeriod(1)` or a waitable timer) in simulation mode. |
| B19 | **`eval` reads only variable paths, not expressions** | `eval "GVL_IO.lrLevel > 0.3"` → `unknown identifier`. Together with B1 this is why the toolkit evaluates breakpoint conditions itself (it reads each variable, then computes in TypeScript), which costs a round trip per hit. Fixing B1 removes the need. |

### Unit tests and the language server (found while planning Phase 5)

Checked on the tank mirror with `trust-dev test --output json` and `trust-lsp`
driven headless over stdio. Both are useful already; these gaps decide how
much the toolkit can lean on them.

| # | Gap | Detail |
|---|-----|--------|
| T1 | **Time doesn't advance inside a test** | A `TON` called 1000 times in a `TEST_PROGRAM` never sets `Q`: one test is one execution with frozen time. Most PLC logic is time-dependent (debounce, timeouts, ramps, PI loops). **Ask:** a way for a test to advance simulated time, e.g. `ADVANCE_TIME(T#100ms)` or a cycle-driven test (`TEST_CYCLES n`, `CYCLE_TIME`), with timers and plant models stepping in lockstep. |
| T2 | **A failure reports the test, not the assertion** | JSON gives `line` and `source` of the `TEST_PROGRAM` header, not of the failing `ASSERT_*` (the tutorial says it does). **Ask:** the failing assertion's line and text, plus the actual and expected values as typed JSON. |
| T3 | **Test file paths carry the `\\?\` prefix on Windows** | `"file": "\\\\?\\C:\\...\\tests.st"`. Prefer a project-relative path such as `src/tests.st`. |
| L1 | **References to qualified GVL members aren't found** | Inside `NAMESPACE GVL_IO`, `textDocument/references` for `lrLT101_Level` returns only the declaration, whether asked at the declaration or at a use such as `GVL_IO.lrLT101_Level` in another file. Locals and FB types work. Global variables are what a PLC cross-reference is mostly for. **Ask:** resolve qualified namespace (GVL) member access in references, rename and call hierarchy. |
| L2 | **Method references and incoming calls are empty** | `references` from `METHOD Reset` → `[]`; `callHierarchy/incomingCalls` on the method → `[]`. The calls exist: `fb.Reset()` in a test, and `itfReset.Reset()` through an interface. Incoming calls to the FB itself work. **Ask:** method (and property) references, including calls through an interface variable, which implementations of the interface method could receive. |
| L3 | **The outline leaves out variables** | `documentSymbol` for an FB gives the FB, its methods and its properties, but not its `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` or locals. An interface outline needs those with types. **Ask:** variables as child symbols, with section (input, output, in-out, local) and type in `detail`, and children nested under the FB (`hierarchicalDocumentSymbolSupport`). |

### Control Studio tuning on CODESYS programs (truST 0.34.0, found integrating tuning)

Tried `trust-control-studio` 0.34.0 on the tank mirror: a CODESYS-style PI
function block in Kp/Ti form (`FB_PI`, fields `_rKp`/`_rTi`, set through
properties at init), an enum mode (`GVL_Par.eMode`), one 10 ms task, a
`gravity_tank` plant. `setup --json` reads the project and offers the "Other
law" search structure, which fits a Kp/Ti PI without code changes. These
gaps keep the rest of the flow from working on typical CODESYS code. Source
references are to the 0.33.0 tree.

| # | Gap | Detail |
|---|-----|--------|
| S1 | **`setup` ignores `vendor_profile = "codesys"`** | `setup --project <mirror> --json` failed with `E208 method 'Reset' implementing interface 'I_Resettable' must be PUBLIC or INTERNAL`, while `trust-runtime build` of the same project (with `trust-lsp.toml` `vendor_profile = "codesys"`) succeeds. CODESYS methods without a modifier are PUBLIC. **Ask:** Studio compiles with the project's profile. *Workaround:* the toolkit's mirror now writes the implicit PUBLIC explicitly. |
| S2 | **The mode must be a BOOL** | `ModeChoice` takes only a BOOL without an I/O address (`setup/pid_loop.rs:54-61`, `setup/form.rs:316-320`). CODESYS loops usually switch mode with an enum (`eMode = MANUAL/AUTO/...`) or a mode word. **Ask:** an enum (or integer) mode binding: the symbol plus the values that mean Auto and Manual. |
| S3 | **A manual-output variable is mandatory** | Every loop needs a REAL/LREAL manual output that drives the MV in Manual, documented as a `%M` address (`state_feedback_loop.rs:284-299`, `control-studio.md:33-35`). Many CODESYS programs have no manual output. **Ask:** let Identify step the MV directly in simulation (write or force the MV's symbol), so a manual output is optional when the target is the simulator. |
| S4 | **A program that sets its gains at startup needs a startup flag** | `check_startup` refuses a draft whose coefficients the program writes (here at init through `Kp`/`Ti` properties) unless a BOOL `startupFlag` is named (`state_feedback_loop.rs:305-322`). CODESYS code commonly does `IF bInit THEN fb.Kp := ...; bInit := FALSE; END_IF`, where TRUE means "initialize". **Ask:** document the flag's polarity, and accept such an init flag (or skip the check for coefficients only written while the flag is set). |
| S5 | **Requirements can only be set through `serve`** | Tune refuses without requirements (`NO_REQUIREMENTS`, `workflow/tune_search.rs:197-205`), and no CLI verb sets them: only JSON-RPC `controlStudio/inputs`. **Ask:** `trust-control-studio inputs --loop ID --change '{...}'` (or `tune --requirement ...`) so scripts and agents can set them. |
| S6 | **The search budget is too small for slow loops** | The whole search gets 50,000 scans and 60 s of wall time by default (`search_loop.rs:57,61`), summed over all trials and cases. At a 10 ms task that is 500 s of simulated time in total, less than two step responses of a tank that settles in about 250 s. Raising it means editing the loop file, which changes its revision. **Ask:** scale the default with the identified time constants, or take `--max-cycles` / `--wall-budget` on `tune`. |
| S7 | **The search family list has no plain PI** | `family` must be one of 12 advanced labels (MPC, Smith, robust, ...); a PI written in Kp/Ti form has to borrow one (`search_loop.rs:30-43`). **Ask:** a "PI/PID (own form)" family, or Kp/Ti as an own-law form next to parallel Kp/Ki. |
| S8 | **Identify needs a free-running runtime** | Studio treats 5 s without a new scan as stale and waits 10 s for parameter confirmation (spec 35, around lines 931-932). A runtime that a debugger holds paused between steps fails. **Ask:** a simulation-target mode that drives scans itself (or accepts a stepped runtime), so a debugger session and tuning can share one runtime. |

## C. Differences the v2 mirror handles (no truST change needed)

| CODESYS | truST | Mirror does |
|---------|-------|-------------|
| GVL object `VAR_GLOBAL … END_VAR` accessed as `GVL_IO.x` | Needs `NAMESPACE GVL_IO … END_NAMESPACE` for qualified access | Wraps every GVL |
| `PROPERTY PUBLIC Kp : REAL` | `PUBLIC PROPERTY Kp : REAL` | Moves the modifier |
| Methods, properties, actions and accessors are separate objects | Nested in the FB text | Composes them, with a line map |
| Builds only POUs a task reaches | Checks every file | Optional: skip unreachable POUs, or report them separately |

## D. Verified working (CODESYS profile)

- FB with `IMPLEMENTS`, methods and an `ACTION`.
- Properties at runtime (repro `property_runtime`): `fb.Kp := 42.0` then `fb.Kp` reads 42.0, and the `SET` guard rejects `-1.0`.
- Call through an interface variable (`itfReset := fbPI; itfReset.Reset();`).
- `POINTER TO`, `ADR`, `^`, `REFERENCE TO` with `REF=`, `{attribute 'hide'}`, `VAR_GLOBAL … AT %IL0`, `LREAL`.
- TON and R_TRIG in simulated time, `LIMIT`, `CONCAT`, `UDINT_TO_STRING`, `LREAL_TO_REAL`, and `REAL_TO_INT(REAL#2.5) = 3` (the CODESYS rule).
- A non-ASCII `STRING` (`'Nivå åäö'`) round-trips from CODESYS through the mirror into runtime memory.
- `gravity_tank` plant in lockstep with the PI loop.
- **Breakpoint halts the scan and the plant freezes**: the level stayed at 0.97889… for 3 s of wall time while paused.
- `step-over`, `step-in`, `resume`, `io-force`, `io-unforce`, `shutdown --exit`.
- `runtime.web.enabled = false` and `discovery.enabled = false` are honoured.

Verified in Phase 2 through the control protocol (v2 speaks it directly):

- A program instance can have its POU's own name (`PROGRAM PRG_Tank WITH MainTask : PRG_Tank;`), so `PRG_Tank.nTrips` is the same path in CODESYS and truST.
- `breakpoints.set` with `options: [{hit_condition: {op: "=", count: n}}]` stops exactly on the n-th hit; v2 uses it for scan-exact `run_scans`.
- `config.set {"simulation.time_scale": 20}` changes the time scale live.
- `debug.stops`, `debug.state`, `debug.stack` (frames across `step_in` into a method), `debug.scopes` and `debug.variables` (typed locals) all work while paused.
- `set` / `var.force` / `var.unforce` with `global:<path>` targets, including FB instance members (`global:PRG_Tank.fbPI._rKp`) and non-ASCII strings.
- `io.force` on a plant-fed `%IL` address holds the value the program sees.
- One TCP connection carries many requests in sequence (about 0.15 ms each on loopback).
