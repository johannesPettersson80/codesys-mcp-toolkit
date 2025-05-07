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

This toolkit requires specific configuration to connect with your CODESYS installation. This is typically done within your MCP Client application (e.g., Claude Desktop).

**You need two key pieces of information from your CODESYS installation:**
1.  **Full Path to `CODESYS.exe`**: This is the main executable for CODESYS.
    *   Example: `C:\Program Files\CODESYS 3.5.21.0\CODESYS\Common\CODESYS.exe`
    *   *How to find it*: Navigate to your CODESYS installation directory. It's usually in `Program Files` or `Program Files (x86)`. Look for `CODESYS.exe` within a `Common` subfolder.
2.  **CODESYS Profile Name**: This is the name of the CODESYS profile you want to use (e.g., "CODESYS V3.5 SP21", "CODESYS V3.5 SP19 Patch 2").
    *   *How to find it*: Open CODESYS. The profile name is often visible in the title bar or startup screen. You can also find it in the CODESYS options or when selecting a profile if multiple are installed.

### Recommended Configuration Method (Direct Command)

It is **strongly recommended** to configure your MCP client to run the installed command `codesys-mcp-tool` **directly**. This avoids potential environment variable issues that can occur with wrappers like `npx`.

**Example for Claude Desktop (`settings.json` -> `mcpServers`):**

```json
{
  "mcpServers": {
    // ... other servers ...
    "codesys_local": {
      "command": "codesys-mcp-tool", // Use the direct command name
      "args": [
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe", // 👈 YOUR CODESYS.exe path
        "--codesys-profile", "CODESYS V3.5 SP21" // 👈 YOUR CODESYS profile name
        // Optional: Add --workspace "/path/to/your/projects" if you use relative project paths
      ]
    }
    // ... other servers ...
  }
}
```

**Steps to configure:**
1.  **Locate `CODESYS.exe`**: Find the full path to `CODESYS.exe` on your system (e.g., `C:\Program Files\CODESYS 3.5.21.0\CODESYS\Common\CODESYS.exe`).
2.  **Identify Profile Name**: Determine the exact CODESYS profile name you intend to use (e.g., `CODESYS V3.5 SP21`).
3.  **Update MCP Client Settings**:
    *   Open your MCP Client's settings file (e.g., `settings.json` for Claude Desktop).
    *   Add or update the `codesys_local` server entry under `mcpServers` as shown in the example above.
    *   Replace `"C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe"` with **your actual path** to `CODESYS.exe`.
    *   Replace `"CODESYS V3.5 SP21"` with **your actual CODESYS profile name**.
4.  **Ensure `codesys-mcp-tool` is in PATH**: The `codesys-mcp-tool` command must be accessible in the system PATH where your MCP Client application runs. Global installation via `npm install -g @codesys/mcp-toolkit` usually handles this. If not, see the troubleshooting section.
5.  **Restart MCP Client**: Restart your MCP Client application (e.g., Claude Desktop) for the changes to take effect.

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

## 💡 Example of an custom instruction with an AI Assistant

This section provides a guide on how you might want to instruct an AI assistant (like Claude, ChatGPT, etc.) that has access to this MCP toolkit to interact with your CODESYS projects. The goal is to achieve efficient and correct project manipulation, OOP structure creation, and code generation.

### CODESYS Object Paths

When referring to objects in CODESYS:
- For top-level Application object, use one of these formats based on how your project is structured:
  * Just "Application" (the toolkit will attempt to auto-resolve if unique)
  * "projectName.Application" (dot notation for top-level items, e.g., `MyProject.Application`)
  * "projectName/Application" (slash notation, e.g., `MyProject/Application`)
- For child objects, use slash format: "Application/MyFolder/MyPOU" (e.g., `MyProject.Application/Logic/PumpControllerFB`)
It's crucial to provide the correct and full path to objects for reliable operations.

### Operation Workflow Example: Creating an OOP Structure

When creating an OOP structure (e.g., "create a pump controller Function Block with properties and methods"), you could guide the AI as follows:

1.  **Open Project**: Use `open_project` or `create_project` with the correct project file path.
    *   Example: `open_project --projectFilePath "C:/Path/To/Your/Project/MyMachine.project"`

2.  **Create Function Block**: Use `create_pou` with:
    *   `projectFilePath`: Full path to the .project file
    *   `name`: The name for the FB (e.g., "PumpController")
    *   `type`: "FunctionBlock"
    *   `language`: "ST" (Structured Text)
    *   `parentPath`: The parent path (e.g., "Application" or "MyMachine.Application"). Ensure this path is correct.
    *   Example: `create_pou --projectFilePath "C:/Path/To/Your/Project/MyMachine.project" --name "PumpController" --type "FunctionBlock" --language "ST" --parentPath "MyMachine.Application"`

3.  **Create Properties**: Use `create_property` for each required property, with:
    *   `projectFilePath`: Full path to the .project file
    *   `parentPouPath`: Path to the parent FB (e.g., "MyMachine.Application/PumpController")
    *   `name`: The property name (e.g., "SpeedSetpoint")
    *   `dataType`: The property's data type (e.g., "REAL")
    *   Example: `create_property --projectFilePath "C:/Path/To/Your/Project/MyMachine.project" --parentPouPath "MyMachine.Application/PumpController" --name "SpeedSetpoint" --dataType "REAL"`

4.  **Create Methods**: Use `create_method` for each required method, with:
    *   `projectFilePath`: Full path to the .project file
    *   `parentPouPath`: Path to the parent FB (e.g., "MyMachine.Application/PumpController")
    *   `name`: The method name (e.g., "Start")
    *   `returnType`: Return data type (or "VOID" if none)
    *   Example: `create_method --projectFilePath "C:/Path/To/Your/Project/MyMachine.project" --parentPouPath "MyMachine.Application/PumpController" --name "Start" --returnType "VOID"`

5.  **Set FB Declaration Code**: Use `set_pou_code` to define the FB's variables:
    *   `projectFilePath`: Full path to the .project file
    *   `pouPath`: Path to the FB (e.g., "MyMachine.Application/PumpController")
    *   `declarationCode`: The VAR...END_VAR declarations
    *   `implementationCode`: Either empty or containing only top-level FB logic (NEVER method implementations)
    *   Example: `set_pou_code --projectFilePath "C:/Path/To/Your/Project/MyMachine.project" --pouPath "MyMachine.Application/PumpController" --declarationCode "VAR_INPUT\n  Enable : BOOL;\nEND_VAR\nVAR_OUTPUT\n  Status : INT;\nEND_VAR\nVAR\n  _internalCounter : INT;\nEND_VAR" --implementationCode "IF Enable THEN\n  Status := 1;\nELSE\n  Status := 0;\nEND_IF;"`

6.  **Implement Methods**: For each method, use a separate `set_pou_code` call:
    *   `projectFilePath`: Full path to the .project file
    *   `pouPath`: Full path to the method (e.g., "MyMachine.Application/PumpController/Start")
    *   `implementationCode`: The method implementation code
    *   `declarationCode`: Usually empty for methods
    *   Example: `set_pou_code --projectFilePath "C:/Path/To/Your/Project/MyMachine.project" --pouPath "MyMachine.Application/PumpController/Start" --implementationCode "GVL.PumpMotor := TRUE;"`

7.  **Implement Property Accessors**: For each property accessor (Get/Set), use separate `set_pou_code` calls:
    *   `projectFilePath`: Full path to the .project file
    *   `pouPath`: Path to the accessor (e.g., "MyMachine.Application/PumpController/SpeedSetpoint/Get" or ".../Set")
    *   `implementationCode`: The accessor implementation code
    *   `declarationCode`: Usually empty for accessors
    *   Example: `set_pou_code --projectFilePath "C:/Path/To/Your/Project/MyMachine.project" --pouPath "MyMachine.Application/PumpController/SpeedSetpoint/Get" --implementationCode "Get := _speedSetpoint;"`

8.  **Save Project**: Use `save_project` after all structural and code implementations are complete.
    *   Example: `save_project --projectFilePath "C:/Path/To/Your/Project/MyMachine.project"`

9.  **Compile Project**: Use `compile_project` if verification is needed.
    *   Example: `compile_project --projectFilePath "C:/Path/To/Your/Project/MyMachine.project"`

### Naming and Style Conventions (CODESYS Modern)

When instructing the AI, you can also specify these common CODESYS naming conventions:
*   POUs (PROGRAM, FUNCTION_BLOCK, FUNCTION): PascalCase (e.g., MotorControl)
*   INTERFACE: I_PascalCase (e.g., I_AxisCommands)
*   Variables: camelCase (e.g., motorSpeed)
*   Private variables: Prefix with `_` (e.g., `_speedSetpoint`)
*   Constants: UPPER_SNAKE_CASE (e.g., MAX_RPM)
*   Properties & Methods: PascalCase (e.g., MotorEnable, ActualSpeed)

### Troubleshooting Tool Usage (When interacting with AI)

*   If creating a POU fails with "Parent object not found", carefully re-check the `parentPath` you provided. Ensure it accurately reflects the existing structure in your CODESYS project (e.g., "projectName.Application" or "projectName/Application/SomeFolder").
*   If setting method or property accessor code fails, double-check the full `pouPath` to ensure it includes all parent objects and is spelled correctly (e.g., "MyProject.Application/MyFB/MyMethod").
*   Mistakes in object paths are a common source of errors. Providing accurate paths is key.

## 🛠️ Command-Line Arguments

When running `codesys-mcp-tool` directly or configuring it, you can use these arguments:

*   `-p, --codesys-path <path>`: Full path to `CODESYS.exe`. (Required if `CODESYS_PATH` env var is not set).
*   `-f, --codesys-profile <profile>`: Name of the CODESYS profile. (Required if `CODESYS_PROFILE` env var is not set).
*   `-w, --workspace <dir>`: Workspace directory for resolving relative project paths passed to tools. Defaults to the current working directory. It's advisable to set this if you use relative project paths in your tool commands.
*   `-h, --help`: Show help message.
*   `--version`: Show package version.

*(Note: Environment variables `CODESYS_PATH` and `CODESYS_PROFILE` can also be used, but command-line arguments will override them.)*

## 🔍 Troubleshooting (Setup & Connection)

*   **`'C:\Program' is not recognized...` error immediately after connection:**
    *   **Cause:** This typically happens when the tool is launched via `npx` within an environment like Claude Desktop. The execution environment (`PATH` variable) provided to the process likely causes an internal CODESYS command (like running Python) to fail.
    *   **Solution:** Configure your MCP Client to run the command **directly** (`"command": "codesys-mcp-tool"`) instead of using `"command": "npx"`. See the **Recommended Configuration Method** section above.

*   **Tool Fails / Errors in Output / No Response:**
    *   **Check CODESYS Path & Profile**: Double-check that the `--codesys-path` and `--codesys-profile` arguments (or environment variables) are absolutely correct and point to a valid CODESYS installation with the Scripting Engine component enabled.
    *   **View Logs**: Check the logs from your MCP Client application (e.g., Claude Desktop logs at `C:\Users\<YourUsername>\AppData\Roaming\Claude\logs\` on Windows). Look for `INTEROP:` messages or Python `DEBUG:` / `ERROR:` messages printed to stderr from the CODESYS script execution.
    *   **Verify Paths**: Ensure project paths and object paths you are passing to tools are correct (use forward slashes `/` for paths in commands). The `get_project_structure` tool (see Features) can be used independently to verify object paths if you are manually debugging.
    *   **No Other CODESYS Instances**: Make sure no other CODESYS instances are running that might conflict (e.g., holding a lock on the profile or project). Close all CODESYS instances before connecting the MCP tool.
    *   **Scripting Engine Enabled**: Confirm that the "Scripting Engine" was selected during CODESYS installation. If not, you may need to modify your CODESYS installation.

*   **`command not found: codesys-mcp-tool`:**
    *   **Global Installation**: Ensure the package was installed globally: `npm install -g @codesys/mcp-toolkit`.
    *   **PATH Environment Variable**: Ensure the npm global bin directory is in your system's `PATH` environment variable.
        *   Find your npm global bin directory: run `npm config get prefix`. On Windows, this is typically `C:\Users\<YourUsername>\AppData\Roaming\npm`. On macOS/Linux, it might be `/usr/local/bin` or similar. The `codesys-mcp-tool` executable will be in this directory (or a `bin` subdirectory).
        *   Add this directory to your system's `PATH` if it's not already there. You may need to restart your terminal or system for changes to take effect.

## 🤝 Contributing
Contributions, issues, and feature requests are welcome! Feel free to check the issues page. (Optionally add a CONTRIBUTING.md file with more details).

## 📝 License
This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgements
- The CODESYS GmbH team for the powerful CODESYS platform and its scripting engine.
- The Model Context Protocol project for defining the interaction standard.
- All contributors and users who help improve this toolkit.
