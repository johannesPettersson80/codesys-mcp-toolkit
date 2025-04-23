# CODESYS MCP Toolkit Examples

This directory contains examples of how to use the CODESYS MCP toolkit effectively.

## Example Configuration Files

### Basic MCP Configuration

`claude_desktop_config.json` - Example configuration for Claude Desktop:

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

## Example Prompts

Here are some example prompts you can use with Claude Desktop:

### Create a Motor Controller Function Block

```
Using the CODESYS Local server, please create a MotorController function block with the following:

1. Properties:
   - SpeedSetpoint (INT)
   - ActualSpeed (INT)
   - IsRunning (BOOL)

2. Methods:
   - Start() - Sets IsRunning to TRUE
   - Stop() - Sets IsRunning to FALSE
   - SetSpeed(speed: INT) - Sets SpeedSetpoint to the given value

Create this in a new project at C:/MyProjects/MotorControl.project
```

### Open and Analyze an Existing Project

```
Using the CODESYS Local server, please open the project at C:/MyProjects/ExistingProject.project and show me its structure. Then, show me the code for the main POU.
```

### Compile a Project

```
Using the CODESYS Local server, please open the project at C:/MyProjects/MyProject.project and compile it. Let me know if there are any errors.
```

## Programmatic Usage Examples

If you're integrating directly with the server code, here are some examples:

### CLI Usage

Run the server directly:

```bash
codesys-mcp-toolkit --codesys-path "C:\Program Files\CODESYS 3.5.21.0\CODESYS\Common\CODESYS.exe" --codesys-profile "CODESYS V3.5 SP21"
```

## Use Cases

* Automated PLC project creation
* Standardized Function Block library management
* Continuous integration for CODESYS projects
* Documentation generation from CODESYS projects
