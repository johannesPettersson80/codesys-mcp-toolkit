import { McpServer } from "@modelcontextprotocol/server";
import { registerTools, type AppContext } from "./tools.js";
import { registerSimTools } from "./sim/tools.js";
import { registerPanel } from "./sim/panel.js";

export const VERSION = "2.0.0-alpha.0";

const INSTRUCTIONS = `CODESYS V3.5 automation through a persistent CODESYS session (offline only: no login, download or online access).
Workflow: open_project (or create_project) -> get_project_tree -> read_objects -> write_object / create_object -> compile.
Object paths are relative to the active application: 'PLC_PRG', 'FB_Pump/Start' (method), 'FB_Pump/Speed/Get' (property accessor).
Only Structured Text is supported; objects with graphical bodies are marked [non-ST] and are read-only.
The first call after start can take 1-3 minutes while CODESYS starts; codesys_status shows progress without waiting.
Simulation (truST, simulated I/O only, never a controller): sync_mirror -> sim_start (paused at scan 0) -> run_scans / run_for / set_breakpoint + continue / step_* / read_vars / force_var -> run_experiment for repeatable step tests. open_sim_panel shows the user a live view. Fix code in CODESYS with write_object, then sim_start again to rebuild.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "codesys-mcp-toolkit", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  if (ctx.sim) {
    registerSimTools(server, ctx.sim);
    registerPanel(server, ctx.sim);
  }
  return server;
}

export type { AppContext };
