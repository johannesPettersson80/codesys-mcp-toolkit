# Configuration Guide

This guide explains how to configure the CODESYS MCP Toolkit for use with MCP clients, specifically focusing on Claude Desktop.

## Claude Desktop Configuration

Claude Desktop is a popular MCP client that can use the CODESYS MCP Toolkit.

### Finding the Configuration File

The configuration file is typically located at:
*   **Windows:** `C:\Users\<YourUsername>\AppData\Roaming\Claude\settings.json` (or `claude_desktop_config.json` in older versions)
*   **macOS:** `~/Library/Application Support/Claude/settings.json` (or `claude_desktop_config.json`)
*   **Linux:** `~/.config/Claude/settings.json` (or `claude_desktop_config.json`)

*(If you can't find `settings.json`, look for `claude_desktop_config.json`)*

### Recommended Configuration: Direct Command

Due to potential environment variable issues (especially with `PATH`) when launching Node.js tools via wrappers like `npx` within certain host applications (e.g., Claude Desktop), it is **strongly recommended** to configure Claude Desktop to run the installed command `codesys-mcp-tool` **directly**.

Edit the configuration file and add the CODESYS MCP server to the `mcpServers` object:

```json
{
  "mcpServers": {
    // ... other servers ...
    "codesys_local": {
      "command": "codesys-mcp-tool", // <<< Use the direct command name
      "args": [
        // Pass arguments directly to the tool using flags
        "--codesys-path", "C:\\Program Files\\Path\\To\\Your\\CODESYS\\Common\\CODESYS.exe", // Customize this path!
        "--codesys-profile", "Your CODESYS Profile Name" // Customize this profile name!
        // Optional: Add --workspace "/path/to/your/projects" if needed
      ]
    }
    // ... other servers ...
  }
}
```

### Why Direct Command is Recommended

Launching with `npx` (`"command": "npx"`) has been observed to cause errors (`'C:\Program' is not recognized...` or profile errors) when run from within applications like Claude Desktop. This is likely due to `npx` altering the execution environment (like the `PATH` variable) in a way that interferes with how CODESYS finds its own components or parses arguments when run non-interactively. Using the globally installed `codesys-mcp-tool` command directly avoids this interference.

### Customizing for Your Environment

You **must** customize:
1.  `--codesys-path`: Set this value to the **full and correct path** of your specific `CODESYS.exe` executable file.
2.  `--codesys-profile`: Set this value to the **exact name** of the CODESYS profile you want to use (this name is visible in the CODESYS UI or start menu).

**Important Notes:**
*   Use double backslashes (`\\`) for paths in the JSON file if you are on Windows.
*   The profile name must match *exactly*, including capitalization and spacing.
*   Ensure `codesys-mcp-tool` is accessible in the system PATH where Claude Desktop runs. Global installation via `npm install -g` usually handles this.

### Applying Changes

After modifying the configuration:
1.  Save the `settings.json` file.
2.  **Restart Claude Desktop completely** (ensure it's fully closed and reopened).
3.  Claude should now attempt to connect to the CODESYS MCP server using the direct command.

### Alternative (Not Recommended): Using `npx`

If you cannot use the direct command method for some reason, you can try `npx`, but be aware of the potential issues mentioned above.

```json
// Example using npx (POTENTIALLY PROBLEMATIC - USE WITH CAUTION):
{
  "mcpServers": {
    "codesys_local": {
      "command": "npx",
      "args": [
        "-y", // Tells npx to install temporarily if not found globally
        "@codesys/mcp-toolkit",
        // Arguments for the tool MUST come AFTER the package name
        "--codesys-path", "C:\\Program Files\\Path\\To\\Your\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "Your CODESYS Profile Name"
        // Optional: "--workspace", "/path/to/your/projects"
      ]
    }
  }
}
```
*If you encounter errors with `npx`, switch to the recommended Direct Command method.*

## Command-Line Options (for `codesys-mcp-tool`)

When running `codesys-mcp-tool` directly or configuring it in your MCP client, you can use these arguments:

*   `-p, --codesys-path <path>`: Full path to `CODESYS.exe`. (Required, overrides `CODESYS_PATH` env var, has a default but relying on it is not recommended).
*   `-f, --codesys-profile <profile>`: Name of the CODESYS profile. (Required, overrides `CODESYS_PROFILE` env var, has a default but relying on it is not recommended).
*   `-w, --workspace <dir>`: Workspace directory for resolving relative project paths passed to tools. Defaults to the directory where the command was launched (which might be unpredictable when run by another application). Setting this explicitly might be needed if using relative paths.
*   `-V, --version`: Output the version number.
*   `-h, --help`: Display help for command.

## Verifying Configuration

To verify your configuration within Claude Desktop:

1.  After restarting Claude with the correct configuration, wait for the server to connect (check logs if needed).
2.  Ask Claude:
    ```
    Can you please check the status of the CODESYS Local server?
    ```
    (Replace `CODESYS Local` if you used a different key in `mcpServers`).

3.  Claude should use the `codesys://project/status` resource. A successful response will show information like `Scripting OK: true`, `Project Open: ...`, etc. An error indicates a problem with the connection, CODESYS setup, or the script execution itself (check logs).

## Multiple CODESYS Installations

If you have multiple CODESYS installations, you can create multiple server entries in `mcpServers` with different keys (names) and point each to the specific installation:

```json
{
  "mcpServers": {
    "codesys_sp21": { // Unique key for this server
      "command": "codesys-mcp-tool", // Direct command
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP21"
      ]
    },
    "codesys_sp19": { // Unique key for this server
      "command": "codesys-mcp-tool", // Direct command
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.19.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP19"
      ]
    }
    // ... other servers ...
  }
}
```

## Next Steps

*   Try some [basic examples](examples.md)
*   Learn about the [available tools and resources](api.md)
*   Check the [troubleshooting guide](troubleshooting.md) if you encounter issues