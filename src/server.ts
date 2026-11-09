import { McpServer } from "@modelcontextprotocol/server";
import { currentCodesysSim } from "./codesys/simulation.js";
import { registerTools, revertObject, versionLine, type AppContext } from "./tools.js";
import { registerPanel } from "./panel.js";

export const VERSION = "2.0.0-alpha.0";

const INSTRUCTIONS = `CODESYS V3.5 automation through a persistent CODESYS session.
Right after opening or creating a project, call open_sim_panel: it shows the user a live CODESYS-style workspace in the chat (the project tree and the code as you write it, changes, compile results, tests and the simulation), so they can watch you work. In chats that can't show it, it opens in the user's browser instead.
Workflow: open_project (or create_project) -> get_project_tree -> read_objects -> write_object / create_object -> compile.
Object paths are relative to the active application: 'PLC_PRG', 'FB_Pump/Start' (method), 'FB_Pump/Speed/Get' (property accessor).
Only Structured Text is supported; objects with graphical bodies are marked [non-ST] and are read-only.
The first call after start can take 1-3 minutes while CODESYS starts; codesys_status shows progress without waiting.
To check that logic works, use CODESYS's own simulation (no controller, nothing extra to install, the real compiler and libraries): codesys_sim_start -> codesys_sim_control (run) or codesys_sim_cycle (exact cycles) -> codesys_sim_read / write / force / unforce -> codesys_sim_stop. The project is locked until codesys_sim_stop.
Fix code with write_object after codesys_sim_stop, then codesys_sim_start again to load it.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "codesys-mcp-toolkit", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  registerPanel(server, {
    cache: ctx.cache,
    changes: ctx.changes,
    project: () => ctx.project?.path,
    versions: () => versionLine(ctx.codesys?.label, ctx.bridge.health().scripting, ctx.project?.compiler_version),
    codesysSim: () => currentCodesysSim(ctx),
    driver: ctx.driver,
    revert: (path, to) => revertObject(ctx, path, to),
    viewer: () => ctx.viewer,
  });
  return server;
}

export type { AppContext };
