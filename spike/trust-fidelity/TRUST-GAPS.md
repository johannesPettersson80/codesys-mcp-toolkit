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
