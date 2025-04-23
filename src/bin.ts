#!/usr/bin/env node
/**
 * CODESYS MCP Server CLI
 * Command-line interface for starting the CODESYS MCP server
 * with configurable CODESYS executable paths and profile names.
 */

import { program } from 'commander';
import path from 'path';

// Define version from package.json
const packageJson = require('../package.json');
const version = packageJson.version;

program
  .name('codesys-mcp-toolkit')
  .description('Model Context Protocol (MCP) server for CODESYS automation platform')
  .version(version)
  .option(
    '-e, --codesys-path <path>', 
    'Path to CODESYS executable',
    'C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe'
  )
  .option(
    '-p, --codesys-profile <profile>', 
    'CODESYS profile name', 
    'CODESYS V3.5 SP21'
  )
  .parse(process.argv);

const options = program.opts();

// Log startup message for debugging
console.error(`Starting CODESYS MCP Server v${version}`);
console.error(`Using CODESYS path: ${options.codesysPath}`);
console.error(`Using CODESYS profile: ${options.codesysProfile}`);

// Pass command line arguments to the CODESYS executable path and profile
// The server.js file expects these as positional parameters
process.argv[2] = options.codesysPath;
process.argv[3] = options.codesysProfile;

// Import and start the server
import('./server.js');
