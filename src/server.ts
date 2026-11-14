import { McpServer } from "@modelcontextprotocol/server";
import { EXTENSION_ID } from "@modelcontextprotocol/ext-apps/server";
import { currentCodesysSim } from "./codesys/simulation.js";
import { registerTools, revertObject, versionLine, type AppContext } from "./tools.js";
import { registerPanel } from "./panel.js";
import { HmiService } from "./hmi/service.js";

export const VERSION = "2.2.0";

const INSTRUCTIONS = `CODESYS V3.5 automation through a persistent CODESYS session.
Everything goes through the one tool named codesys, as {"action": "<name>", "args": {...}}. The names below are its actions; {"action": "help"} lists them all with their arguments.
Use batch whenever you know the next steps: it sends several actions in one call and is much faster than separate calls. For example, all the create_object and write_object calls of a step followed by compile, or codesys_sim_force, wait, codesys_sim_cycle and codesys_sim_read for one test.
Workflow: open_project (or create_project) -> get_project_tree -> read_objects -> write_object / create_object -> compile.
Object paths are relative to the active application: 'PLC_PRG', 'FB_Pump/Start' (method), 'FB_Pump/Speed/Get' (property accessor).
Write code as Structured Text; create ladder, FBD or SFC POUs with create_graphical. Existing graphical bodies are marked [non-ST] and can't be edited in place. Before calling a library FB, check its interface with get_signature instead of guessing; find_references shows where a name is used.
The first call after start can take 1-3 minutes while CODESYS starts; codesys_status shows progress without waiting.
To check that logic works, use CODESYS's own simulation (no controller, nothing extra to install, the real compiler and libraries): codesys_sim_start -> codesys_sim_control (run) or codesys_sim_cycle (exact cycles) -> codesys_sim_read / write / force / unforce -> codesys_sim_stop. The project is locked until codesys_sim_stop.
Fix code with write_object after codesys_sim_stop, then codesys_sim_start again to load it.
To check timing, set up a trace (trace_setup, before codesys_sim_start) and record it (trace_record) while the simulation runs.
Operator screens: hmi_template gives page layouts; hmi_save_screen stores a page, hmi_screenshot shows it to you, open_hmi opens it live for the user, hmi_export_codesys builds it as a native CODESYS visualization.
Right after opening or creating a project, call the separate tool open_sim_panel: it shows the user a live CODESYS-style workspace in the chat (the project tree and the code as you write it, changes, compile results and the simulation), so they can watch you work.`;

export function createServer(ctx: AppContext): McpServer {
  // A host treats an extension the server doesn't advertise as unsupported, and then runs
  // open_sim_panel as a plain text tool and never fetches the card's page.
  const server = new McpServer({ name: "codesys-mcp-toolkit", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { extensions: { [EXTENSION_ID]: {} } } });
  ctx.hmi ??= new HmiService(ctx);
  registerTools(server, ctx);
  registerPanel(server, {
    hmi: ctx.hmi,
    cache: ctx.cache,
    changes: ctx.changes,
    project: () => ctx.project?.path,
    versions: () => versionLine(ctx.codesys?.label, ctx.bridge.health().scripting, ctx.project?.compiler_version),
    codesysSim: () => currentCodesysSim(ctx),
    driver: ctx.driver,
    revert: (path, to) => revertObject(ctx, path, to),
    log: (m) => ctx.log?.(m),
  });
  return server;
}

export type { AppContext };
