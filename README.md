# @codesys/mcp-toolkit

![npm](https://img.shields.io/npm/v/@codesys/mcp-toolkit)
![License](https://img.shields.io/github/license/yourusername/codesys-mcp-toolkit)

A Model Context Protocol (MCP) server for CODESYS V3 programming environments. This toolkit enables seamless interaction between MCP clients (like Claude Desktop) and CODESYS, allowing automation of project management, POU creation, code editing, and compilation tasks.

## 🌟 Features

- **Project Management**
  - Open existing CODESYS projects
  - Create new projects from templates
  - Save project changes

- **POU Management**
  - Create Programs, Function Blocks, and Functions
  - Set declaration and implementation code
  - Create properties and methods for Function Blocks
  - Compile projects

- **MCP Resources**
  - `codesys://project/status`: Check scripting status and project state
  - `codesys://project/{+project_path}/structure`: Retrieve project structure
  - `codesys://project/{+project_path}/pou/{+pou_path}/code`: Read POU code

- **MCP Tools**
  - `open_project`: Open specified CODESYS project
  - `create_project`: Create new CODESYS project
  - `save_project`: Save currently open project
  - `create_pou`: Create new Program, Function Block, or Function
  - `set_pou_code`: Update code for a specified POU
  - `create_property`: Create property in a Function Block
  - `create_method`: Create method in a Function Block
  - `compile_project`: Compile the open project

## 📋 Prerequisites

- **CODESYS V3**: A working CODESYS V3 installation (tested with 3.5 SP21) with **Scripting Engine** component enabled
- **Node.js**: Version 18 or later required
- **MCP Client**: An MCP-enabled application (e.g., Claude Desktop)

## 🚀 Installation

### Option 1: Install from npm (Recommended)

```bash
npm install -g @codesys/mcp-toolkit
```

This installs the package globally, making the `codesys-mcp-toolkit` command available in your terminal.

### Option 2: Install from Source

```bash
# Clone the repository
git clone https://github.com/yourusername/codesys-mcp-toolkit.git
cd codesys-mcp-toolkit

# Install dependencies
npm install

# Build the project
npm run build

# Install globally
npm install -g .
```

## 🔧 Configuration

### Claude Desktop Configuration

1. Locate your Claude Desktop configuration file:
   - Windows: `C:\Users\<YourUsername>\AppData\Roaming\Claude\claude_desktop_config.json`

2. Add the CODESYS MCP server entry:

```json
{
  "mcpServers": {
    "codesys_local": {
      "command": "npx",
      "args": [
        "-y",
        "@codesys/mcp-toolkit",
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP21"
      ]
    }
  }
}
```

3. Customize the paths to match your CODESYS installation:
   - `--codesys-path`: Path to your CODESYS.exe
   - `--codesys-profile`: Your CODESYS profile name

4. Restart Claude Desktop to apply the changes

## 🛠️ Usage Examples

### Creating a Function Block with Properties

```
Ask Claude: "Using the CODESYS Local server, please create a Motor Controller function block with Start and Stop methods, plus CurrentSpeed property."
```

Claude will execute these MCP tool calls:
1. `create_pou` to create the MotorController Function Block
2. `create_property` to add the CurrentSpeed property
3. `create_method` to add Start and Stop methods
4. `set_pou_code` to implement each method and property

### Opening and Compiling a Project

```
Ask Claude: "Can you open the project at C:/MyProjects/TestProject.project using CODESYS Local and compile it?"
```

Claude will:
1. Use `open_project` to open the specified file
2. Use `compile_project` to build the application

## 🔍 Troubleshooting

### Common Issues

- **Connection Failures**: Check Claude Desktop logs for error messages
- **Path Issues**: Ensure CODESYS executable path is correct
- **Profile Mismatch**: Verify profile name matches exactly
- **Permission Problems**: Ensure Claude has appropriate permissions
- **CODESYS Already Running**: Close other CODESYS instances

### Debug Logs

Check logs at:
- Windows: `C:\Users\<YourUsername>\AppData\Roaming\Claude\logs\`

## 🤖 Using with Claude.ai

To get the best experience using this toolkit with Claude.ai, you can add these custom instructions. This helps Claude understand how to properly use the CODESYS MCP tools.

### Recommended Custom Instructions

```
Primary Context: My primary workflow involves interacting with CODESYS projects using the available codesys_local MCP tools. Please prioritize using these tools correctly and efficiently for tasks related to CODESYS project manipulation, object-oriented programming (OOP) structure creation, and code generation.

CODESYS Tool Usage Guidelines:
Prioritize MCP Tool Invocation: Use the available codesys_local tools (compile_project, create_method, create_pou, create_project, create_property, open_project, save_project, set_pou_code) whenever an action directly maps to one. Focus on using the provided MCP abstraction layer.

OOP Structure Creation Workflow: When asked to create an OOP structure (e.g., "create a pump controller Function Block with properties and methods"):
Step 1: Create FB: Use create_pou.
Step 2: Create Properties: Use create_property.
Step 3: Create Methods: Use create_method.
Step 4: Implement Methods: Use set_pou_code targeting the method's path (e.g., Application/PumpController/Start) for its implementationCode.
Step 5: Declare Backing Variables: Use set_pou_code targeting the main FB's path (e.g., Application/PumpController) to set its declarationCode, including necessary VAR PRIVATE for property backing fields (e.g., _speedSetpoint, _isRunning).
Step 6: Implement Property Accessors:
  - Use the set_pou_code tool to set the code for the GET and SET accessors.
  - Target the Accessor Path: Provide the full path to the specific accessor in the pouPath parameter. For example:
    - To set the GET accessor for property SpeedSetpoint under Application/PumpController, use pouPath: "Application/PumpController/SpeedSetpoint/Get".
    - To set the SET accessor, use pouPath: "Application/PumpController/SpeedSetpoint/Set".
  - Provide Code: Use the implementationCode parameter of set_pou_code to provide the ST code for the respective accessor (e.g., SpeedSetpoint := _speedSetpoint; for the Get, _speedSetpoint := SpeedSetpoint; for the Set).
Step 7: Save Project: Use save_project after completing the structural changes and code modifications.

CODESYS Naming Conventions (Modern Style):
- POUs (PROGRAM, FUNCTION_BLOCK, FUNCTION): PascalCase (e.g., MotorControl)
- INTERFACE: PascalCase with I_ prefix (e.g., I_AxisCommands)
- DUTs (STRUCT, UNION, ENUM, ALIAS): PascalCase (e.g., MachineState, E_OperationMode)
- Variables (VAR, VAR_GLOBAL): camelCase (e.g., motorSpeed). Backing variables prefix _ (e.g., _speedSetpoint)
- Constants (CONSTANT): UPPER_SNAKE_CASE (e.g., MAX_RPM)
- Properties & Methods: PascalCase with descriptive names (e.g., MotorEnable, ActualSpeed, SpeedSetpoint)

Use Descriptive Property Naming:
- Use suffixes like "Setpoint", "Actual", "Target", "Status", etc. to indicate purpose
- For control values: SpeedSetpoint, TemperatureSetpoint, PressureSetpoint
- For measured values: SpeedActual, TemperatureActual, PressureActual
- For status indicators: IsRunning, IsEnabled, IsReady, HasError
- For configuration: MaxSpeed, MinPressure, AlarmThreshold
```

These instructions help Claude understand the correct workflow, naming conventions, and best practices when working with CODESYS through MCP tools.

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## 🙏 Acknowledgements

- The [CODESYS](https://www.codesys.com/) team for their scripting engine
- [Model Context Protocol](https://github.com/m-ld/model-context-protocol) project
- All contributors who have helped improve this toolkit
