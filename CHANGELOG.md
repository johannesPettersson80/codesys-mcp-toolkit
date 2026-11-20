# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.12.1] - 2026-11-20

### Changed
- `get_devices` keeps big devices short: a device with more than 64 I/O
  channels lists its mapped channels and one line counting the rest, with
  their address ranges. The new `device` argument lists one device and those
  under it with every channel. On a Machine Expert PacDrive project with
  EtherNet/IP adapters (#7), one adapter had 2,363 channels, 17 of them
  mapped, and the whole output went from 3,438 lines (156 KB) to 439.
  `export_sources` still writes every channel.

## [2.12.0] - 2026-11-19

From a batch mixing unit Claude built from one prompt, start to finish, to
see where the toolkit falls short.

### Added
- `codesys_screenshot`: with `--show-window`, a picture of the CODESYS window
  as it is, so Claude can look at the native HMI running in the simulation (or
  an editor) itself. `show` opens an object first. In the batch mixer run
  Claude had no way to see the CODESYS window and asked for computer use to
  look at it.
- SFC steps take `entry` and `exit`: ST that runs once when the step becomes
  active or is left (CODESYS's step entry and exit actions). CODESYS has no
  IEC P1 and P0 qualifiers; `create_graphical` accepted them and the build
  failed with "'P1' is not a valid qualifier". An action with P1 or P0 now
  becomes the step's entry or exit action. `read_objects` reads them back.
- Status items take `off`: the text while off. A list of "XV-101 open",
  "P-201 running" read as if everything ran, with only a hollow dot for the
  ones that didn't; now it can say "XV-101 closed". In the browser and in
  CODESYS.

### Changed
- `codesys_sim_read`, `codesys_sim_write`, `codesys_sim_force` and
  `codesys_sim_unforce` also take their variables as `variables` (or `vars`).
  In both runs of the batch mixer Claude's first simulation step said
  `variables`, and the whole batch was refused. Any other unknown name is
  still refused.
- Tanks have no scale marks: the two short ticks at a quarter and three
  quarters had no labels and read as stray lines inside the vessel.
- `hmi_screenshot` with live values from the simulation shows no made-up
  trend history: a trend shows what was recorded, not a minute of invented
  movement around the present value. Example values still get one.
- `hmi_export_codesys` is about four times faster: the batch mixer's 4-page
  HMI (724 elements) took 689 s, now 176 s; building one 256-element page
  took 377 s, now 38 s (the alarms, alarm history and image pools take what
  they took). Every element went into the visualization in its own
  transaction, and CODESYS commits the whole visualization each time, so the
  build grew with the square of the page's size and a 4-page HMI ran past
  client time-outs. Now a page's elements are created in one transaction,
  with their bindings set by CODESYS's element creators. The result is the
  same: every property read back equal to the old build's, the rendered page
  pixel-identical, the build without errors.
- Tanks take `fault` and `warning` like other equipment: the condition badge
  at the vessel's corner, in the browser and in CODESYS. They were dropped
  silently.
- Machine states (the top bar and the state widget) take `invert`: a state
  that shows while its BOOL is FALSE, e.g. Manual from `xAuto`.
- `hmi_save_screen` notes value cards too small for their number: one row
  high, the number runs into the title; too narrow with a set value, Actual
  and Set overlap.
- `codesys_sim_write`, `codesys_sim_force` and `codesys_sim_test` take JSON
  booleans and numbers (`true`, `5`) as well as Structured Text (`'TRUE'`).
- `codesys_sim_write` and `codesys_sim_force` say what they wrote
  (`Wrote GVL.xStart := TRUE.`); they only answered with the application's
  state, which read like the write had been ignored.
- `codesys_sim_start` saves pending changes before it goes online (with
  autosave), and `save_project` during the simulation answers that the project
  is saved instead of refusing. After `hmi_export_codesys` the project still
  had unsaved changes, so saving it meant stopping the simulation and
  starting it again (about a minute). The simulation setting is still never
  saved into the project.
- `hmi_export_codesys` saves the project at the end (with autosave).
- `show_in_codesys` gives a visualization room: it maximizes the CODESYS
  window and folds away the Interface Editor above the page before it fits
  the zoom. The MixingUnit page showed at 37 % in a window of normal size,
  too small to read in a recording; now at 78 %.
- `codesys_sim_stop` closes the visualization editors in the CODESYS window
  before it goes offline (`show_in_codesys` opens one again). With a page
  still open online, the next build failed with "Sending service failed,
  status: 404" and the project had to be closed, opened and built again:
  starting the simulation again took about a minute, now the reopen and the
  second build (about 27 s) are gone.
- Pipes in a process diagram go round equipment they aren't connected to: a
  middle run at another level, a step aside past something on a straight
  line. A pipe that can't (the valves of the MixingUnit's first diagram sat
  against their tanks' bottoms) is named by `hmi_save_screen` ("runs through
  valve XV-102"); before, it was drawn through the valve without a word.
- A mixer is seated on the tank under it, motor on the top and agitator
  inside, whatever its `y`: placed by guess it covered the tank's reading.
- `hmi_save_screen` notes a setpoint too narrow for its - and + buttons (and
  the actual value beside them), and the tool text gives the sizes cards need
  at 1280x720, where a tank's side ports sit, and which end of a vertical
  valve is in and out. The MixingUnit page took four saves to lay out.
- `help` runs as a step of a batch; it made the whole batch fail.

### Fixed
- With `--show-window`, closing the CODESYS window works. CODESYS ignores a
  close while a script runs, and the toolkit's watcher is a script that runs
  until the server stops: the X button did nothing, and the window stayed
  until the server was stopped. The watcher now notes the close, stops, and
  closes the window once its script has returned. The next tool call starts
  CODESYS again.
- In CODESYS, the alarm card's active rows close up to the top: each alarm had
  a fixed row, so a pump dry run alone (the fourth alarm) sat at the bottom of
  an empty card. A row now moves up one row for every row above it that isn't
  showing, the acknowledge button with it.
- In CODESYS, a setpoint card's actual value leaves room for its unit: the
  unit ran under the set group's − button ("0.0 k").
- A trend's fill closes under its own line: with only the last few seconds
  recorded (a page just opened) it drew a wedge across the whole card.
- Deleting a program takes it out of the tasks that call it, and
  `configure_task` `remove_calls` works: CODESYS's scripting can't remove a
  call, so the task is made again with the same settings and its other calls.
  Deleting the new project's `PLC_PRG` left a call to it in MainTask, and the
  build failed until the task was deleted and made again by hand.
- `show_in_codesys` zooms a visualization so the whole page fits the editor,
  also while the simulation runs. At 100 % a 1280-pixel page is wider than
  the editor pane between the Devices and Toolbox panes, so the window showed
  its top-left corner and the Start and Stop buttons and the alarms were
  off-screen. Offline it sets the editor's zoom; online the page is drawn by a
  web view that keeps the zoom of the moment the simulation started, so its
  own zoom is set on top.
- After a visualization was opened in the CODESYS window while the
  simulation ran, every later build failed with "Error while processing the
  visualization: Sending service failed, status: 404" until the project was
  opened again; a clean build didn't help. `compile` and `codesys_sim_start`
  now save and reopen the project when that is the only error, and build
  again.
- A call still running after 50 s replies that it is still running, and
  `{"action": "result"}` waits for it and returns its result. Claude Desktop
  gives up on a call after 60 s, progress or not, so an HMI export, or a batch
  with long waits, ended in "Request timed out" and its result was lost while
  CODESYS carried on. While a call runs, others are not run: they wait for it
  up to 50 s, bring its result along, or say it is still busy.
- In CODESYS, a tank's liquid fills the vessel's rounded bottom: a full tank
  showed a white band under the liquid, and a low level floated above the
  bottom. CODESYS can't clip the liquid to the vessel as the browser does, so
  the liquid now has the vessel's shape and a strip in the tile's colour
  covers the empty part from the top; the surface stays flat.
- In CODESYS, a top-bar `info` value with neither `decimals` nor `unit` is
  shown as it is, as in the browser. Every value went through a REAL, so a
  STRING (a batch step's name) read 0.
- `create_project` creates the project's folder
  (`BatchMixer/BatchMixer.project`); it failed with ENOENT.
- `create_graphical` accepts comments before `PROGRAM` or `FUNCTION_BLOCK`,
  as CODESYS does.
- The instrument examples in the tool texts give the bubble's `x`, `y`
  besides `at`; without them the screen failed to save.
- The SFC transition's description says CODESYS checks it in the same cycle
  the step becomes active, before a value the step's entry action sets.
- `codesys_sim_test` with more than one `waitMs` step, or a `waitMs` step
  after `cycles`, failed with "Cannot start if application state is run" or
  "... single_cycle". `codesys_sim_control` `run` now leaves a running
  application alone and stops single cycling first. Stopping uses CODESYS's
  Stop command, as single cycles do: `online.stop()` now and then hung for a
  minute and ended the call with "The operation has timed out".

## [2.11.2] - 2026-11-16

Readability fixes on process diagrams and the symbol sheet.

### Fixed
- A tank's name inside the vessel is drawn in the text colour, not the muted
  grey, so it reads on the liquid (8.5:1 in the light theme, 4.3:1 in dark;
  the grey was 2.0:1 and 1.6:1). Other names stay muted. The same in the
  browser and in CODESYS.
- The heat treatment screenshots in the README: pump P-202 no longer overlaps
  separator C-202.
- The symbol sheet (`hmi_symbols`) prints the letters in an instrument
  bubble, "LS" and "PS", as a screen does; the bubbles were blank. The
  README's sheet shows only the built-in symbols.

## [2.11.1] - 2026-11-15

Tanks and switches on process diagrams, after a look at the 2.11.0 screens.

### Changed
- A tripped switch (an `instrument` with `on`) keeps a white bubble and gets
  the same condition badge as equipment at its corner: the red alarm with
  `tone: 'alarm'`, else the amber warning. It used to fill the bubble with
  the tone's colour. The same in the browser, in CODESYS and (hidden) on the
  P&ID sheet. `on` is documented as TRUE when tripped (`xPressureLow`, not
  `xPressureOk`).
- Saving a screen warns when a `level_switch` or `pressure_switch` symbol has
  `on`, which a bubble symbol doesn't show, and says how to draw it as an
  `instrument` instead.

### Fixed
- A `pressure_switch` symbol without a tag prints "PS" (ISA-5.1), not "PI",
  which means a pressure indicator.
- A tank's level number no longer has a halo, which showed as a white rim
  cutting into the liquid, and no scale mark runs through it (the marks are
  at a quarter and three quarters). The contrast theme's liquid is a deeper
  blue (`#1f78d1`) so its white number reads without the halo (4.5:1).

## [2.11.0] - 2026-11-15

A redesign of the HMI: a design system, symbols from the standards, a station
overview, a clear way to show equipment state, the same result in CODESYS,
and a P&ID sheet for the documentation.

### Added
- Design system for the browser HMI and the CODESYS export alike: Siemens iX
  colours in light, dark and contrast themes, line icons, flat cards, and the
  machine in the frame (`machine` on a screen): its state small in the top
  bar's corner with a line in its colour under the bar, Start, Stop, Reset and
  the Manual/Auto switch in a bar along the bottom, and the active faults,
  warnings and messages counted in the top bar.
- `line` widget: the process as station tiles on a product path (an
  overview), each with its pictogram, key value and state; a supply such as
  steam joins its station from above, and a tap opens the station's page.
- Equipment state as three separate signs, never a coloured or grey-filled
  symbol and never words: the run state before the name (▶ running,
  ■ stopped), the mode after it (`manual`: a hand) and the condition at the
  symbol's corner (`warning`: an amber triangle, `fault`: a red alarm circle,
  which wins). A closed valve is drawn filled, as on a P&ID. Pumps, fans,
  valves, symbols and stations take `fault`, `warning` and `manual`.
- `value`, `unit` and `decimals` on pumps, fans, valves and symbols: a value
  that belongs to the equipment (a control valve's opening) shown under its
  name, instead of a separate sensor.
- Labels and line names place themselves where they touch no pipe, equipment
  or other text and stay inside the card; a tank's name goes inside the
  vessel. `hmi_save_screen` names a label that has no free place.
- The process check also reports a reading drawn as a separate sensor when it
  belongs to a piece of equipment (its label starts with that equipment's
  tag), and a run state (`on`) on equipment without a drive (filter, heat
  exchanger, check valve).
- `hmi_pid`: a screen's process diagram as an engineering P&ID sheet (black
  on white, nothing live) on A3 with a frame, a legend of the symbols it uses
  and a title block, saved next to the project as PDF, SVG or PNG.
- Process check on `hmi_save_screen`: it reports equipment no pipe reaches,
  an inlet without an outlet, a heat exchanger with one circuit connected,
  tanks nothing flows into or out of, instruments and sensors away from any
  line or vessel or drawn inside a vessel, a motor whose shaft touches
  nothing, and pipes that end in mid-diagram. The screen still saves; Claude
  gets the list to fix.

### Changed
- Process symbols are drawn from ISO 10628-2 (pump, heat exchangers, valves,
  check and control valves, motor on the machine it drives, agitator,
  separator and others), instruments as ISA-5.1 bubbles outside the vessel
  joined to where they measure, readings beside them on the free side.
- Equipment keeps the surface colour in every state, pipes are one solid
  line that turns darker while flowing, and nothing moves (no turning
  impellers or moving dashes), as high-performance HMI practice asks.
- The CODESYS export draws the same as the browser: the station line, the
  state signs, labels at the browser's size, arrows at line ends, page titles
  on two lines in the rail, and a narrow alarms card with the time and state
  under the message.
- `hmi_symbols` and `hmi_save_symbol` show a symbol with its ports (valves
  also open and closed) instead of off, on and fault colours.

### Fixed
- The CODESYS setpoint card with an actual value left its value field a few
  pixels wide.

## [2.10.0] - 2026-11-14

### Added
- Alarm history: `create_alarm_history` generates ST that records every state
  change of every alarm, with CODESYS's own time of the change, in a RETAIN
  ring buffer (CODESYS's runtime alarm forgets its times once it is normal
  again); `alarm_history` lists the events. `hmi_export_codesys` adds it when
  the HMI has alarms, and an alarms tile with `history: N` shows the last
  events in the browser and in CODESYS. Checked in the SP21 simulation.
- The live feature tests (`test/live/features.live.test.ts`) also cover the
  alarm history, SFC branches, CFC, the watch list, data and line
  breakpoints, `compare_sources` and library pinning; they pass on SP21 and
  SP22.

### Fixed
- `pin_library` on a managed reference kept only its namespace: the new
  reference got the library's defaults, and Standard came back
  qualified-only, so every unqualified call (TON, CONCAT) failed to compile.
  It now keeps qualified-only, optional and the other reference settings.
- CODESYS in another language: the native HMI export set the button and
  switch inputs (Input configuration) by their English names, which a German
  CODESYS doesn't know, so its buttons did nothing. The watcher now finds a
  property through the property tree's language-independent ids, and CODESYS's
  own objects (Visualization Manager, TargetVisu, WebVisu, Alarm
  Configuration, alarm classes) by their type instead of their English name.
  Checked on SP21 with a German and a Chinese user interface (`--culture`):
  every property applied, the alarms work, 0 compile errors.

## [2.9.0] - 2026-11-14

### Added
- HMI themes: `theme: 'contrast'` (black and white, full-strength colours,
  no glow) besides dark and light, per page; `accent` sets a company colour
  for highlights, flow and the current page, with black or white text on it,
  whichever reads better. Both in the browser and in the native export.
- Native pipe flow: pipes with `flow` show dashes moving along them in the
  CODESYS visualization (driven by the clock in the generated program),
  checked in the SP21 simulation.
- Access rights per tile: `access: {min: 'Maintenance', below: 'see' | 'hide'}`
  sets CODESYS's element access rights for the user groups, including the None
  group (nobody logged in). Checked in the SP21 simulation: inoperative and
  hidden tiles with nobody logged in. The browser HMI marks such tiles.
- `find_library` searches the installed libraries by title, company or
  category, with every installed version and how the project references each.
  `pin_library` fixes a reference to one version (placeholders through
  CODESYS's redirection) or unpins it; `list_libraries` marks references that
  take the newest installed version. Checked on SP22, compile included.

### Fixed
- The native export reused the visualization user management instead of
  creating a new one on every export, which could drop users added by hand.

## [2.8.0] - 2026-11-14

### Added
- `breakpoint_on_change`: a data breakpoint that halts the simulation right
  after a variable is written, optionally only when a condition holds.
- `watch`: a watch list of expressions, read together, with what changed since
  the previous read, or sampled several times with min, max and changes.
- `debug_status` shows the call stack while halted (for example
  `PLC_PRG.fbCount <- PLC_PRG`).
- Checked in the SP22 simulation: the call stack, step into, over and out, a
  data breakpoint with and without a condition, and the watch list.
- SFC with branches: `create_graphical` takes `sfc.chart`, with alternative
  and parallel branches and jumps; `read_objects` describes a branched SFC as
  such a chart, so it can be edited and sent back. Checked in the SP22
  simulation (both paths of an alternative, a parallel branch).
- CFC: `create_graphical` takes `cfc` (the same description as `fbd`), and
  `read_objects` reads CFC bodies as that description. Checked in the SP22
  simulation with operators, a function and a TON.
- `compare_sources`: the open project compared with an `export_sources` folder
  or another `.project` file, with a line diff per changed object.

### Fixed
- `debug_continue` no longer fails when the simulation is already running.

## [2.7.0] - 2026-11-14

### Added
- Recipes: `create_recipes` generates ST for setpoint recipes (a struct, the
  recipes in a RETAIN array, a program that applies a recipe or stores the
  current values in one, through pointers so program variables work) and adds
  it to MainTask; an HMI `recipe` widget offers Apply and Save in the browser
  and in CODESYS. Checked in the SP21 simulation: apply, save, apply again.
  (CODESYS's own Recipe Manager can be created by script, but in the
  simulation its runtime never found the recipes.)
- `get_signature` lists the parameters of library methods (for example
  `RecipeManCommands.SetRecipeValues`).
- STRING values show without quotes on HMI screens.
- Languages: `hmi_translate` stores translations of the HMI's texts per
  language and lists what is still untranslated; the browser HMI gets language
  buttons in its header and switches live (checked on SP21); `hmi_screenshot`
  takes `language`. The export puts the alarm messages' translations into
  CODESYS's alarm text list. Native pages don't switch language yet.
- `codesys_status` reports which optional features this CODESYS offers
  (visualization, signatures, cross-references, debugging, trace, alarms, user
  groups, device repository, FloatingPointUtils) and what a missing one affects.
- A table of what was checked on CODESYS SP21, SP22 and Machine Expert
  (docs/reference.md), and live tests for the features beyond plain ST.

### Fixed
- `export_sources` rewrote graphical bodies on every export because of the
  time stamp in their XML header; it now leaves them out, so only real
  changes show in git.

## [2.6.0] - 2026-11-14

### Added
- `device_parameters` and `configure_device`: read and set a device's
  parameters (IP addresses, ports, unit IDs, enumerations such as DHCP) and map
  its I/O channels to variables, with automatic or fixed IEC addresses, through
  CODESYS's documented device scripting. Checked on SP22: a Modbus TCP server
  device's register and a single bit mapped, 0 build errors.

- Native gauges look like the browser HMI's arc gauge (pictures per 2.5 %
  of the range, in the band colours) instead of a bar.
- Native alarm rows follow CODESYS's alarm manager: the time the alarm came,
  its state, and an ACK button that acknowledges it in CODESYS; a cleared alarm
  stays until acknowledged. Checked live on SP21.
- `show_in_codesys`: with `--show-window`, open an object (a visualization, a
  POU, a device) in its editor in the CODESYS window.

### Fixed
- `get_io_list`, `get_devices` and `project_report` listed a mapped channel
  once for every device above it; each now appears once, under its own device.

## [2.5.0] - 2026-11-14

### Added
- Ladder, FBD and SFC POUs read back as `create_graphical`'s description:
  `read_objects` turns CODESYS's PLCopenXML into rungs (contacts in series
  and parallel, coils, set/reset), networks (functions, function blocks with
  their inputs and outputs, outputs written on the block) or steps (actions,
  conditions, the jump back). To change one, Claude edits the description and
  calls `create_graphical` with `replace: true`. What the description can't
  hold (function boxes in a rung, SFC branches) is named, with the XML.
  Checked against CODESYS SP22's own export: read, add a rung, replace,
  compile with 0 errors, read back.

## [2.4.0] - 2026-11-14

### Added
- Process-diagram symbols: a `symbol` item with a library of standard
  symbols (motor, conveyor, heat exchanger, mixer, filter, compressor,
  cylinder, level switch, pressure switch, check valve, control valve), each
  with off, on and fault colours, named ports for pipes and rotation in 90°
  steps. In CODESYS each state is its own picture in the image pool, chosen by
  the on and fault variables. Checked live on SP21.
- Your own symbols: `hmi_save_symbol` adds an SVG symbol to the project, drawn
  by Claude or imported from an SVG file (Inkscape, Illustrator), and returns
  a picture of it in every state with its ports marked. `hmi_symbols` shows
  the library, `hmi_delete_symbol` removes one. The SVG is checked against a
  short list of elements and attributes; scripts, styles, links and external
  images are refused.
- CODESYS alarms in the simulation: `alarm_list` (groups, alarms, classes,
  messages and conditions of the Alarm Configuration), `alarm_status` (each
  alarm's state from CODESYS's alarm manager: normal, pending, active, active
  acknowledged, cleared and waiting for confirmation or acknowledgement) and
  `alarm_acknowledge`. Lets Claude test alarms: raise the condition, check
  it's active, clear it, acknowledge, check it's normal. Checked live on SP21.
- The browser HMI's alarm rows follow CODESYS's alarm states once the HMI is
  exported: a cleared alarm stays in the list until it's acknowledged, with an
  ACK button that acknowledges it in CODESYS's alarm manager (simulation
  only); the header counts these too.
- `project_report`: a Markdown handover report next to the project (summary,
  tasks, I/O list, device-tree mappings, CODESYS alarms, HMI pages,
  libraries, devices, program structure) ending with a commissioning
  checklist built from the project: each task, I/O point, mapped channel,
  alarm, HMI page and persistent variable list to verify on the machine.
- `export_sources`: the project as plain text for git and review, one `.st`
  file per object in folders like the project tree, ladder/FBD/SFC bodies as
  PLCopenXML, `project.txt` (tasks, libraries, devices, alarms) and the HMI
  screens. Exporting again only rewrites changed files and removes files of
  deleted objects (only files an earlier export wrote).
- MCP progress: long actions send progress notifications (the steps of an HMI
  export, the steps of a batch, and a heartbeat every 10 s), so clients that
  reset their timeout on progress don't give up on a long export.
- `hmi_export_codesys` checks for the FloatingPointUtils library first and
  says how to install it, instead of building for minutes and failing at the
  compile.

## [2.3.0] - 2026-11-14

Several of the new actions use CODESYS's own services inside the IDE, beyond
what its scripting API documents: `get_signature`, `find_references`,
`rename_symbol`, `trace_setup`, `trace_record`, the debug actions,
`hmi_export_codesys` and `--show-window`. They are experimental and checked on
the versions noted below.

### Added
- HMI screens: Claude designs live operator screens for the program
  (`hmi_save_screen`): a process diagram with tanks, pumps, fans, valves and
  animated pipes, plus gauges, values with sparklines, bars, status lights,
  buttons, switches, setpoints, trends and alarms, bound to PLC variables, in a
  dark or light theme. `hmi_screenshot` returns the screen as an image so the
  model can check and polish its layout. `open_hmi` opens it in the browser
  (127.0.0.1 with a token), live while the simulation runs; buttons, switches
  and setpoints write to the simulation only. Screens are stored next to the
  project as `<project>.hmi.json`.
- `hmi_export_codesys`: the same screen as a native CODESYS visualization,
  with cards, gradients, SVG pump, fan and valve symbols in an embedded image
  pool, live values, bars, tank levels, colour states, buttons, switches,
  setpoints and alarm rows; a generated program scales values for bars and
  levels. Built through CODESYS's visualization scripting and its element
  creators. Returns a picture of the visualization. Checked on SP21.
- HMI projects with several pages: a shared header with links to every page and
  the count of active alarms across all pages; page templates (`hmi_template`:
  overview, unit, alarms, trends, settings); faceplate popups on pumps, fans
  and valves; panel sizes 1280x720, 1920x1080, 1024x768 and 800x480; warnings
  for overlapping symbols. Trend history survives page changes.
- HMI pipes connect to named ports on tanks, pumps, fans, valves and junctions
  and are routed with right angles, so they meet the symbols exactly in the
  browser and in CODESYS.
- `get_signature`: the interface of any POU or type from CODESYS's compiler,
  including FBs in compiled libraries (TON, CTU, MC_...), with doc comments.
- `find_references`: where a variable, POU or type is declared, read, written
  or called, with line and column. Both checked on SP21 and SP22.
- `trace_setup` and `trace_record`: CODESYS Trace in the simulation, returned
  as a summary (BOOL edges and extremes with their times), a table and a
  chart image. Checked on SP22 without a window.
- `create_graphical`: ladder, FBD and SFC programs and function blocks from a
  structured description, generated as PLCopenXML. Checked on SP22: a ladder
  latch, an AND into a TON and a three-step SFC compile and behave correctly
  in the simulation.
- Debugging in the simulation: `breakpoint_set` (by line), `debug_status`,
  `debug_step` (over, into, out), `debug_continue`, `breakpoint_clear`.
  Checked on SP22 without a window.
- `rename_symbol`: rename a variable or POU everywhere it is used, from
  CODESYS's cross-references (works without a window; CODESYS's own
  refactoring needs one). Checked on SP22: 0 build errors after.
- `codesys_sim_test`: test cases in the simulation (write or force, cycles or
  real time, expected values with comparisons and tolerances), reported as a
  pass/fail table. Checked on SP22.
- `find_device` and `add_device`: search CODESYS's device repository and add
  devices to the tree. Checked on SP22: Ethernet, a Modbus TCP Client and a
  Modbus TCP Server device compile with 0 errors.
- `create_object` creates persistent variable lists (`persistent_vars`).
- `hmi_export_codesys` builds every page: page buttons in each header
  (change shown visualization), the start page and client size of
  TargetVisu and WebVisu, turning pumps and fans (8 frames chosen by the
  clock), faceplates as CODESYS dialog visualizations, the pages' alarms in
  CODESYS alarm management (an alarm group with Error/Warning/Info classes
  and message texts), and visualization user groups with a Login button.
  Checked on SP21: three pages and two dialogs compile with 0 errors; the
  alarms show in CODESYS's alarm group editor with their messages after the
  project is reopened, and in the simulation CODESYS's alarm manager reports
  the raised fault as an active alarm.
- Input actions only go on shapes: CODESYS raises an assertion dialog when
  an image element gets one.
- The browser viewer closes open connections when it stops, so an open HMI
  tab no longer keeps the server from exiting. Screenshots retry once when
  the headless browser hangs at start.
- Actions can return images.
- `--show-window` opens every object the model creates or writes in its editor
  tab, so the CODESYS window shows the code as it is written, and, while the
  simulation runs, its live values. CODESYS's scripting API has no call for
  this, so it uses CODESYS's own frame (checked on SP21 and SP22); where that
  isn't available, nothing opens and the call works as before.

### Changed
- The Chinese README states model support directly and lists the models
  tested with OpenCode, as suggested by Zhen Yang (Alfabete-spec), who
  reviews the Chinese documentation.

## [2.2.0] - 2026-11-14

### Added
- `--show-window`: start CODESYS with its window instead of headless, to watch
  the work in clients without the live panel (such as OpenCode). Prompts are
  answered as when headless, and the toolkit never closes the window: not on a
  hang, not when the server stops.
- README: setup for OpenCode and other MCP clients, and the models tested with
  OpenCode 1.19.5 on CODESYS SP22 (DeepSeek V4.1 Flash, Qwen 3.6 Plus, GLM 5.3,
  MiniMax M3: all passed). New screenshots: Claude building and testing a
  tank level controller next to the workspace (top of the README), an OpenCode
  session, the browser workspace and the CODESYS window.
- A Simplified Chinese README (`README.zh-CN.md`): setup for OpenCode and other
  clients that work in China, an npmmirror install line, and the tested models.

## [2.1.2] - 2026-11-13

### Fixed
- `get_devices` really shows Machine Expert modules by their module id. 2.1.1
  expected `get_module_identification()` to return an object, but in CODESYS
  and Machine Expert 2.3 it returns the module id as a string (empty for a
  device that isn't a module), so the module id was never read.

## [2.1.1] - 2026-11-13

### Fixed
- `get_devices` tells modules apart. A module is a device that exists only
  inside its owner, such as Machine Expert's local I/O and embedded functions.
  CODESYS reports the owner's type and id for it, so every device looked the
  same (#7). Modules now show their module id.

### Changed
- Releases are published from GitHub Actions through npm trusted publishing,
  so the npm package carries a provenance statement, and `server.json` goes to
  the MCP Registry in the same run.

## [2.1.0] - 2026-11-13

### Added
- `--attach <dir>` (experimental): work in a CODESYS / Machine Expert window you
  already have open. The server writes `start_attach.py`; run it in the window
  with Tools > Scripting > Execute Script File. A UI timer polls for requests, so
  the window stays usable. Nothing is started or killed. (#12, thanks @dFxed)
- EcoStruxure Machine Expert V2.3 works: `LogicBuilder.exe` has no profiles, so
  `--codesys-profile` is optional for products other than `CODESYS.exe` and
  `--profile` is left out when there is none. CODESYS behaviour is unchanged.
  (#7, #11, thanks @dFxed)

### Fixed
- `read_objects` says when the PLCopenXML export of a graphical object fails,
  instead of leaving its body out without a word. (#13, thanks @Alfabete-spec)
- `codesys_sim_start` refuses when the application is already logged in, which
  can happen in a window opened with `--attach`. It could otherwise have taken
  over a connection to a real controller.
- A result file that stays unreadable fails the call after a few seconds
  instead of being retried forever.

## [2.0.1] - 2026-11-10

### Added
- Listing in the official MCP Registry as
  `io.github.johannesPettersson80/codesys-mcp-toolkit`: `mcpName` in
  `package.json` and a `server.json`.

## [2.0.0] - 2026-11-09

Rewrite. See README "Migrating from v1".

### Changed
- CODESYS runs once per session with a watcher script (file-queue IPC,
  JSON op requests, heartbeat, hang/crash detection and restart) instead of
  a cold `--runscript` per call.
- ESM TypeScript on MCP SDK v2 (`@modelcontextprotocol/server`), Node 20+.
- One tool, `codesys`, so a client that asks for approval per tool asks once.
  Each operation is an action of it (`read_objects`, `write_object`,
  `create_object`, `get_project_tree`, `search_code`, `compile`,
  `list_libraries`, `add_library`, `list_tasks`, `codesys_status`, ...), and
  actions work on the open project. `help` lists them with their arguments,
  and `batch` runs several in one call.
- Structured Text only; graphical objects are listed as `[non-ST]`.
- No login or download to a controller. The online functions are used only
  for CODESYS's own simulation.
- Earlier development builds simulated in truST. That is gone; the options
  `--trust-runtime`, `--mirror-dir` and `--no-sim` are accepted and ignored,
  so existing client setups keep starting.

### Added
- CODESYS's own simulation, with nothing extra to install: `codesys_sim_start`,
  `codesys_sim_stop`, `codesys_sim_status`, `codesys_sim_control`,
  `codesys_sim_cycle`, `codesys_sim_read`, `codesys_sim_write`,
  `codesys_sim_force`, `codesys_sim_unforce`. Runs on the real compiler and
  libraries; the project is locked while it runs.
- `get_outline`, `get_io_list`: the project's structure and interfaces, and
  its I/O variables, from one export instead of reading every object.
- `get_library_api`: interfaces of referenced source libraries.
- `checkpoint`, `get_changes`, `revert_object`: change tracking against
  snapshots, with an automatic `session-start` snapshot on open.
- `open_sim_panel`: a live panel inside the chat (MCP App), which Claude opens
  after opening or creating a project. It is a separate tool with its own
  approval. Open workspace on the card expands it.
- `open_workspace`: the same workspace in the default browser, when the user
  asks for it, served on 127.0.0.1 with a token. Options `--viewer-port`,
  `--no-viewer`.
- Panel views that follow Claude's work: Code (live code with new lines
  marked) and Review (accept or revert each changed object, with its
  added/removed line counts; in the chat card the changes open in place).
- `compile` checks every POU, GVL and DUT, including those no task calls (it
  sets "link always" for the build and restores it); `deep` also generates
  code, `clean` builds from scratch.
- CODESYS V3.5 SP22: the toolkit passes the install's additional folder
  (`CODESYS\AdditionalFolders\Default`, where SP22 keeps add-ons such as
  Scripting) as `--additionalfolder`, and reads profiles from it.
  `--codesys-additional-folder` overrides it.
- `codesys_status` and the panel show the Scripting add-on version next to
  the CODESYS install and compiler version. The server log says why an install
  was picked.
- Build properties: objects excluded from the build are marked in the tree.
  The application's compiler defines and, with Scripting 4.2, the project
  defines and compiler version are reported.
- `get_devices`: the device tree and its I/O channels with their mapped
  variables; `get_io_list` includes the device-tree mappings.
- `read_objects` returns graphical bodies (SFC, CFC, LD, FBD) as PLCopenXML.
- `open_project` opens `.projectarchive` files; `save_project` can write one.
- `remove_library`. `add_library` also takes a bare title (`Util`), with an
  optional version.
- `get_library_api` lists compiled libraries and ones the project doesn't
  reference, with their descriptions, from CODESYS's library browser cache.
- A profile that isn't installed is refused at start, with the installed ones
  listed. The `--workspace` folder is created if missing.
- Profiles and templates are also found for programs laid out unlike
  `CODESYS.exe`. See `docs/machine-expert-testing.md` for testing with
  Schneider Machine Expert, which isn't supported yet.
- Checkpoints keep graphical bodies as PLCopenXML; `revert_object` re-imports
  a deleted graphical object instead of recreating it as empty ST.
- Compile messages give the real column (from CODESYS's offset; its own
  text says column 1) and the token length; the full-screen editor marks
  lines with errors and warnings.
- `configure_task`: create and configure tasks (kind, interval, priority,
  event, core, watchdog) and add program calls; `list_tasks` shows the event,
  core and watchdog. Removing a call is refused with an explanation: SP21's
  scripting can't do it.
- Shared session: server processes started with the same options share one
  background owner (one CODESYS), so the panel shows the project the chat
  works on. `--no-shared` runs in-process as before.
  - **In the chat:** a compact card with status, what Claude is working on
    and changes.
  - **Full screen:** a CODESYS-style workspace with the project tree and
    badges, editor tabs (diff against the session start), and problems and
    review tabs.
  - **Follow Claude** opens what Claude edits.
  - **Selections** are sent to Claude as model context.
  - **Panel-only tools** (`get_sim_state`, `get_workspace`, `get_object`) are
    hidden from clients without MCP Apps support. They read a project cache
    that the tools keep current, so the panel never calls CODESYS.
  - **Interaction:** accept or revert Claude's change per object (a `review`
    checkpoint the badges and diffs compare with), and **Pause Claude**, which
    holds Claude's changing tools with a `paused_by_user` answer. User actions
    are sent to Claude as model context. They use app-only `ui_*` tools.

### Fixed
- The server advertises the MCP Apps extension (`io.modelcontextprotocol/ui`)
  in its capabilities. A host may otherwise treat the card tool as plain text
  and show no card.
- `create_project` makes a project that compiles (#4). CODESYS's shipped
  `Standard.project` can be years old: SP22's names device 3.1.3.0 and
  `IoStandard, 3.1.3.1`. The new copy is brought up to the running CODESYS's
  device, compiler and libraries. Templates you pass and projects you open are
  never updated.
- `open_project` says when a project needs a newer compiler than the running
  CODESYS has, and so can't compile there.
- A start-up timeout or a crash during a call reports what the program printed.
- A dialog CODESYS waits on during a call ends the call in about 15 seconds
  with an error that names it. Before, the call ran into its timeout (up to 5
  minutes).
- A request file held for a moment by another process (antivirus, indexer) no
  longer fails the call with `bad_request`.
- `compile` returns errors and warnings with object, line and code (#10).
- Non-ASCII text round-trips (UTF-8 end to end) (#9).
- Reads work in Claude Desktop because they are tools, not resources (#6).
- Declarations that drop or change the object header are rejected (#5).
- Functions get their return type (#8).
- Object kinds come from type GUIDs, so localised CODESYS works.
- Interfaces are created without the implicit `__System.IQueryInterface` base.

## [1.1.16] - 2025-05-06

### Fixed
- Reverted to v1.1.3 code base which has working POU creation functionality
- Fixed path handling by using simpler approach from v1.1.3
- Restored original Application object finding logic that worked in v1.1.3

## [1.0.0] - 2025-04-23

### Added
- Initial release of the MCP server for CODESYS
- Command-line interface with configuration options
- Project management functionality:
  - Opening existing CODESYS projects
  - Creating new CODESYS projects
  - Saving projects
- POU (Program Organization Unit) management:
  - Creating POUs (Programs, Function Blocks, Functions)
  - Setting POU code (declaration and implementation)
  - Creating properties and methods for Function Blocks
- Project compilation support
- Resources for querying:
  - Project status
  - Project structure
  - POU code
- Documentation for installation and usage
