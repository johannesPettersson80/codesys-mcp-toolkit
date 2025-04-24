
# @codesys/mcp-toolkit

![npm](https://img.shields.io/npm/v/@codesys/mcp-toolkit)
![License](https://img.shields.io/github/license/johannesPettersson80/codesys-mcp-toolkit)
![Node Version](https://img.shields.io/node/v/@codesys/mcp-toolkit)

A Model Context Protocol (MCP) server for CODESYS V3 programming environments. This toolkit enables seamless interaction between MCP clients (like Claude Desktop) and CODESYS, allowing automation of project management, POU creation, code editing, and compilation tasks via the CODESYS Scripting Engine.

## 🌟 Features

- **Project Management**
  - Open existing CODESYS projects (`open_project`)
  - Create new projects from standard templates (`create_project`)
  - Save project changes (`save_project`)

- **POU Management**
  - Create Programs, Function Blocks, and Functions (`create_pou`)
  - Set declaration and implementation code (`set_pou_code`)
  - Create properties for Function Blocks (`create_property`)
  - Create methods for Function Blocks (`create_method`)
  - Compile projects (`compile_project`)

- **MCP Resources**
  - `codesys://project/status`: Check scripting status and currently open project state.
  - `codesys://project/{+project_path}/structure`: Retrieve the object structure of a specified project.
  - `codesys://project/{+project_path}/pou/{+pou_path}/code`: Read the declaration and implementation code for a specified POU, Method, or Property accessor.

## 📋 Prerequisites

- **CODESYS V3**: A working CODESYS V3 installation (tested with 3.5 SP21) with the **Scripting Engine** component enabled during installation.
- **Node.js**: Version 18.0.0 or later is recommended.
- **MCP Client**: An MCP-enabled application (e.g., Claude Desktop).

*(Note: CODESYS uses Python 2.7 internally for its scripting engine, but this toolkit handles the interaction; you do not need to manage Python separately.)*

## 🚀 Installation

The recommended way to install is globally using npm:

```bash
npm install -g @codesys/mcp-toolkit
```

This installs the package globally, making the `codesys-mcp-tool` command available in your system's terminal PATH.

*(Advanced users can also install from source for development - see CONTRIBUTING.md if available).*

## 🔧 Configuration (IMPORTANT!)

This toolkit needs to know where your CODESYS installation is and which profile to use. Configuration is typically done within your MCP Client application (like Claude Desktop).

### Recommended Configuration Method (Direct Command)

Due to potential environment variable issues (especially with `PATH`) when launching Node.js tools via wrappers like `npx` within certain host applications (e.g., Claude Desktop), it is **strongly recommended** to configure your MCP client to run the installed command `codesys-mcp-tool` **directly**.

**Example for Claude Desktop (`settings.json` -> `mcpServers`):**

```json
{
  "mcpServers": {
    // ... other servers ...
    "codesys_local": {
      "command": "codesys-mcp-tool", // <<< Use the direct command name
      "args": [
        // Pass arguments directly to the tool using flags
        "--codesys-path", "C:\\Program Files\\Path\\To\\Your\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "Your CODESYS Profile Name"
        // Optional: Add --workspace "/path/to/your/projects" if needed
      ]
    }
    // ... other servers ...
  }
}
```

**Key Steps:**
1.  Replace `"C:\\Program Files\\Path\\To\\Your\\CODESYS\\Common\\CODESYS.exe"` with the **full, correct path** to your specific `CODESYS.exe` file.
2.  Replace `"Your CODESYS Profile Name"` with the **exact name** of the CODESYS profile you want to use (visible in the CODESYS UI).
3.  Ensure the `codesys-mcp-tool` command is accessible in the system PATH where the MCP Client application runs. Global installation via `npm install -g` usually handles this.
4.  Restart your MCP Client application (e.g., Claude Desktop) to apply the settings changes.

### Alternative Configuration (Using `npx` - Not Recommended)

Launching with `npx` has been observed to cause immediate errors (`'C:\Program' is not recognized...`) in some environments, likely due to how `npx` handles the execution environment. **Use the Direct Command method above if possible.** If you must use `npx`:

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
      ]
    }
  }
}
```
*(Note: The `--` separator after the package name might sometimes help `npx` but is not guaranteed to fix the environment issue.)*

## 🛠️ Command-Line Arguments

When running `codesys-mcp-tool` directly or configuring it, you can use these arguments:

*   `-p, --codesys-path <path>`: Full path to `CODESYS.exe`. (Required, overrides `CODESYS_PATH` env var, has a default but relying on it is not recommended).
*   `-f, --codesys-profile <profile>`: Name of the CODESYS profile. (Required, overrides `CODESYS_PROFILE` env var, has a default but relying on it is not recommended).
*   `-w, --workspace <dir>`: Workspace directory for resolving relative project paths passed to tools. Defaults to the directory where the command was launched (which might be unpredictable when run by another application). Setting this explicitly might be needed if using relative paths.
*   `-h, --help`: Show help message.
*   `--version`: Show package version.

## 🔍 Troubleshooting

*   **`'C:\Program' is not recognized...` error immediately after connection:**
    *   **Cause:** This typically happens when the tool is launched via `npx` within an environment like Claude Desktop. The execution environment (`PATH` variable) provided to the process likely causes an internal CODESYS command (like running Python) to fail.
    *   **Solution:** Configure your MCP Client to run the command **directly** (`"command": "codesys-mcp-tool"`) instead of using `"command": "npx"`. See the **Recommended Configuration Method** section above.

*   **Tool Fails / Errors in Output:**
    *   Check the logs from your MCP Client application (e.g., Claude Desktop logs). Look for `INTEROP:` messages or Python `DEBUG:` / `ERROR:` messages printed to stderr from the CODESYS script execution.
    *   Ensure the `--codesys-path` and `--codesys-profile` arguments passed to the command are correct and point to a valid CODESYS installation with scripting enabled.
    *   Verify the project paths and object paths you are passing to tools are correct (use forward slashes `/`).
    *   Make sure no other CODESYS instances are running in conflicting ways (e.g., holding a lock on the profile).

*   **`command not found: codesys-mcp-tool`:**
    *   Ensure the package was installed globally (`npm install -g @codesys/mcp-toolkit`).
    *   Ensure the npm global bin directory is in your system's `PATH` environment variable. Find it with `npm config get prefix` and add the `bin` subdirectory (or the main directory itself on Windows) to your PATH.

*   **Check Logs:**
    *   Claude Desktop logs: `C:\Users\<YourUsername>\AppData\Roaming\Claude\logs\` (Windows)

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the issues page. (Optionally add a CONTRIBUTING.md file with more details).

## 📝 License
This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgements
*(Keep as is)*
- The CODESYS GmbH team for the powerful CODESYS platform and its scripting engine.
- The Model Context Protocol project for defining the interaction standard.
- All contributors and users who help improve this toolkit.

