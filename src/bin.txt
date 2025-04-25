#!/usr/bin/env node
/**
 * CODESYS MCP Server CLI
 * Command-line interface for starting the CODESYS MCP server
 * with configurable CODESYS executable paths and profile names.
 * 
 * This is the entry point for the MCP toolkit when invoked as a command-line tool.
 * It handles argument parsing and passes configuration to server.ts via function parameters.
 */

// Use Commander for initial parsing
import { program } from 'commander';
// Import the server setup function
import { startMcpServer } from './server.js'; // Adjust path if needed

console.error(">>> BIN.TS Starting <<<");

// Define version from package.json
// Use import assertion for JSON in ES modules if possible, otherwise require is okay for CommonJS
let version = 'unknown';
try {
    // Assuming CommonJS based on package.json type="commonjs"
    const packageJson = require('../package.json');
    version = packageJson.version;
} catch (e) {
    console.error("BIN.TS: Warning - Could not read package.json for version.", e);
}


program
  .name('codesys-mcp-tool') // Set the command name users will see
  .description('Model Context Protocol (MCP) server for CODESYS automation platform')
  .version(version)
  .option( // Use options consistently
    '-p, --codesys-path <path>',
    'Path to CODESYS executable (can contain spaces, use quotes if needed)',
    process.env.CODESYS_PATH || 'C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe' // Default AFTER reading env var
  )
  .option(
    '-f, --codesys-profile <profile>', // Changed alias to 'f' to avoid conflict if you add other '-p' options
    'CODESYS profile name (overrides CODESYS_PROFILE env var)',
    process.env.CODESYS_PROFILE || 'CODESYS V3.5 SP21' // Default AFTER reading env var
  )
  // Add workspace option if needed, defaults to cwd
   .option(
    '-w, --workspace <dir>',
    'Workspace directory for relative project paths',
    process.cwd() // Default to current working directory
  )
  .parse(process.argv); // Parse the arguments

const options = program.opts();

// --- Log the options Commander parsed ---
console.error(`========================================`);
console.error(`Starting CODESYS MCP Server v${version}`);
console.error(`BIN.TS Options: ${JSON.stringify(options)}`);
console.error(`  CODESYS Path Used: ${options.codesysPath}`);
console.error(`  CODESYS Profile Used: ${options.codesysProfile}`);
console.error(`  Workspace Used: ${options.workspace}`);
console.error(`  Node.js: ${process.version}`);
console.error(`========================================`);
// --- End Logging ---

// --- Prepare Config for Server ---
const serverConfig = {
    codesysPath: options.codesysPath.trim(),
    profileName: options.codesysProfile.trim(),
    workspaceDir: options.workspace.trim() // Pass workspace dir
};
// --- End Prepare Config ---

// --- Call the server setup function ---
console.error("BIN.TS: Calling startMcpServer...");
startMcpServer(serverConfig)
    .then(() => {
        console.error("BIN.TS: startMcpServer finished (likely connected and listening).");
        // Keep process alive (server handles shutdown)
    })
    .catch(error => {
        console.error("BIN.TS: FATAL error during server startup:", error);
        process.exit(1);
    });
console.error(">>> BIN.TS End of synchronous execution <<<");