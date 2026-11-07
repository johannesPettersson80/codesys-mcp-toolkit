import { McpServer } from "@modelcontextprotocol/server";
import { registerTools, type AppContext } from "./tools.js";

export const VERSION = "2.0.0-alpha.0";

const INSTRUCTIONS = `CODESYS V3.5 automation through a persistent CODESYS session (offline only: no login, download or online access).
Workflow: open_project (or create_project) -> get_project_tree -> read_objects -> write_object / create_object -> compile.
Object paths are relative to the active application: 'PLC_PRG', 'FB_Pump/Start' (method), 'FB_Pump/Speed/Get' (property accessor).
Only Structured Text is supported; objects with graphical bodies are marked [non-ST] and are read-only.
The first call after start can take 1-3 minutes while CODESYS starts; codesys_status shows progress without waiting.`;

export function createServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "codesys-mcp-toolkit", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, ctx);
  return server;
}

export type { AppContext };
