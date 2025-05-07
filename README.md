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

Follow these steps for interacting with CODESYS projects using the `codesys_local` MCP tools. My primary goal is efficient and correct project manipulation, OOP structure creation, and code generation via these tools.

**1. Prioritize MCP Tool Usage:**

*   Always use the available `codesys_local` tools (`compile_project`, `create_method`, `create_pou`, `create_project`, `create_property`, `open_project`, `save_project`, `set_pou_code`) for corresponding actions.
*   **Crucially:** Use `set_pou_code` for setting all textual code (POU declarations/implementations, Method implementations, Property Get/Set accessor implementations). Identify the target object precisely using its full `pouPath`.

**2. CODESYS Object Paths:**

*   Use **forward slashes (`/`)** for all object paths within the project (e.g., `Application/MyFolder/MyPOU`).
*   Be precise with `projectFilePath`, `parentPouPath`, and `pouPath` arguments.

**3. OOP Structure Creation Workflow (Strict Sequence - CRITICAL):**

When asked to create an OOP structure (e.g., "create a pump controller Function Block with properties and methods"):

*   **Step 1: Create FB:** Use `create_pou` for the Function Block.
*   **Step 2: Create Properties:** Use `create_property` for **each** required property under the FB.
*   **Step 3: Create Methods:** Use `create_method` for **each** required method under the FB. **This step is MANDATORY before implementing method code.**
*   **Step 4: Declare FB Variables:** Use `set_pou_code` targeting **only the FB's path** (e.g., `Application/PumpController`) via `pouPath`. Provide **only** the necessary `VAR...END_VAR` declarations in `declarationCode`. **CRITICAL: The `implementationCode` for the FB itself MUST be empty or contain only top-level FB logic, NEVER `METHOD...END_METHOD` blocks.**
*   **Step 5: Implement Methods:** For **each** method created in Step 3, use a **separate `set_pou_code` call**:
    *   Target the **Method's specific full path** (e.g., `Application/PumpController/Start`) via `pouPath`.
    *   Provide the method's logic **only** in the `implementationCode` argument. `declarationCode` is usually empty/omitted for methods.
*   **Step 6: Implement Property Accessors:** For **each** property created in Step 2, use **separate `set_pou_code` calls** for its `Get` and `Set` accessors:
    *   Target the **Accessor's specific full path** (e.g., `Application/PumpController/SpeedSetpoint/Get` or `.../Set`) via `pouPath`.
    *   Provide the accessor logic **only** in the `implementationCode`. `declarationCode` is usually empty for accessors.
*   **Step 7: Save Project:** Use `save_project` **only after** all structural and code implementations are complete.

**4. Naming and Style Conventions (CODESYS Modern):**

*   **POUs (PROGRAM, FUNCTION\_BLOCK, FUNCTION):** `PascalCase` (e.g., `MotorControl`)
*   **INTERFACE:** `I_PascalCase` (e.g., `I_AxisCommands`)
*   **DUTs (STRUCT, UNION, ENUM, ALIAS):** `PascalCase` (e.g., `MachineState`, `E_OperationMode`)
*   **Variables (VAR, VAR\_GLOBAL):** `camelCase` (e.g., `motorSpeed`). Prefix private backing variables with `_` (e.g., `_speedSetpoint`).
*   **Constants (CONSTANT):** `UPPER_SNAKE_CASE` (e.g., `MAX_RPM`)
*   **Properties & Methods:** `PascalCase` (e.g., `MotorEnable`, `ActualSpeed`, `SpeedSetpoint`)
*   **Descriptive Property Names:** Use suffixes like `Setpoint`, `Actual`, `Status`, `Is`, `Has` (e.g., `SpeedSetpoint`, `TemperatureActual`, `IsReady`, `HasError`).

**4.5 OOP Design Principles for Generated ST Code (CRITICAL):**

When generating Structured Text (ST) code for Function Block (FB) methods and property accessors, adhere strictly to these OOP principles:

*   **A. Encapsulation & Property Usage:**
    *   **Backing Fields:** All properties **MUST** have corresponding `VAR PRIVATE` backing fields (e.g., `_myVar : INT;` for a property `MyVar : INT`).
    *   **Internal Access via Accessors:** Within the FB's methods, when reading or writing a value that is exposed as a property, you **MUST** interact with it via its Property Get or Set accessor. **DO NOT** directly read from or write to the private backing field from other methods.
        *   *Example (Correct):* `MyVar := MyVar + 1;` (This calls the Get and then the Set accessor of `MyVar`).
        *   *Example (Incorrect):* `_myVar := _myVar + 1;` (This bypasses property logic).
    *   **Exception to Direct Access:** Direct access to a backing field from a method is only permissible if that method is the property's *own* Get or Set accessor, or in very rare, explicitly justified cases for complex internal logic that cannot be cleanly handled by the accessor itself.
*   **B. Getter/Setter Accessor Logic:**
    *   **Get Accessor:** The implementation of a Get accessor **MUST** be simple and typically only return the value of its corresponding private backing field.
        *   *Example:* `MyVar := _myVar;`
    *   **Set Accessor:** The implementation of a Set accessor receives the new value (e.g., `MyVar` implicitly available). It **MAY** contain validation logic or side effects related to setting the value. It **MUST** ultimately assign the (potentially validated) new value to its corresponding private backing field.
        *   *Example:* `IF MyVar >= GVL.MinValue THEN _myVar := MyVar; END_IF`
*   **C. Method Design:**
    *   **Single Responsibility:** Each method should perform one clear, distinct task or operation. Avoid overly long methods that handle multiple unrelated concerns.
    *   **Internal Method/Property Calls:** If a method's logic requires performing an action already encapsulated by another public/private method or property of the same FB, **MUST** call that existing method/property. Do not duplicate logic.
        *   *Example:* If a `ResetStateMachine` method needs to set a `_currentState` backing field which has a `CurrentState` property, the method should call `CurrentState := E_States.Idle;` not `_currentState := E_States.Idle;`.
*   **D. Code Structure within `set_pou_code`:**
    *   When `set_pou_code` targets a Function Block (e.g., `pouPath: 'Application/MyFB'`), the `implementationCode` **MUST NOT** contain `METHOD...END_METHOD` or `PROPERTY...END_PROPERTY` blocks. These are created structurally by `create_method` and `create_property`. The FB's `implementationCode` is for its main body logic (if any, often empty for pure OOP FBs).
    *   Declarations (`VAR...END_VAR`) for the FB are set via `declarationCode` when targeting the FB.
    *   Implementations for methods are set via `implementationCode` when `set_pou_code` targets the specific method path (e.g., `pouPath: 'Application/MyFB/MyMethod'`).
    *   Implementations for property accessors (Get/Set) are set via `implementationCode` when `set_pou_code` targets the specific accessor path (e.g., `pouPath: 'Application/MyFB/MyProperty/Get'`).
*   **E. Interface Design (FB Inputs vs. Methods/Properties):**
    *   For parameters that represent continuous data flow into the FB (e.g., an analog sensor value, a setpoint from a PID loop), `VAR_INPUT` is appropriate.
    *   For parameters that trigger discrete actions or commands (e.g., "start", "stop", "reset", "configure"), prefer public Methods.
    *   For configurable settings or state values of the FB that require validation or have side-effects when changed, prefer public Properties with Get/Set accessors.
    *   Avoid using many boolean `VAR_INPUT` flags to control different internal modes if distinct Methods offer a clearer behavioral interface.

**5. Communication Preferences:**

*   Clearly state which tool and arguments you are using for each step.
*   Follow the OOP workflow sequence accurately.
*   Explicitly mention the full `pouPath` being targeted when using `set_pou_code`, especially for property accessors (`.../PropertyName/Get`, `.../PropertyName/Set`).
*   If a tool call fails, report the failure and the error message provided by the server clearly.

---

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
