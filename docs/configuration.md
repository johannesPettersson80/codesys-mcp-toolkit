# Configuration Guide

This guide explains how to configure the CODESYS MCP Toolkit with MCP clients.

## Claude Desktop Configuration

Claude Desktop is a popular MCP client that can use the CODESYS MCP Toolkit.

### Finding the Configuration File

The configuration file is located at:
- Windows: `C:\Users\<YourUsername>\AppData\Roaming\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Adding the CODESYS MCP Server Entry

Edit the configuration file and add the CODESYS MCP server to the `mcpServers` object:

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

### Configuration Parameters

- `command`: Use `npx` to execute the package
- `args`: Array of arguments
  - `-y`: Automatically accept npm install prompts
  - `@codesys/mcp-toolkit`: The package name
  - `--codesys-path`: Path to your CODESYS.exe
  - `--codesys-profile`: Your CODESYS profile name

### Customizing for Your Environment

You must customize:
1. `--codesys-path`: Set to the actual path of your CODESYS executable
2. `--codesys-profile`: Set to the exact name of your CODESYS profile

**Important Notes:**
- Use double backslashes (`\\`) in Windows paths in JSON
- The profile name must match exactly what appears in CODESYS

### Applying Changes

After modifying the configuration:
1. Save the file
2. Restart Claude Desktop completely
3. Claude should now have access to the CODESYS MCP server

## Command-Line Options

When using the toolkit directly, the following options are available:

```
Usage: codesys-mcp-toolkit [options]

Options:
  -V, --version                     output the version number
  -e, --codesys-path <path>         Path to CODESYS executable
  -p, --codesys-profile <profile>   CODESYS profile name
  -h, --help                        display help for command
```

## Verifying Configuration

To verify your configuration:

1. In Claude Desktop, ask:
   ```
   Can you please check the status of the CODESYS Local server?
   ```

2. Claude should use the `project-status` resource and return information about the CODESYS server connection.

## Multiple CODESYS Installations

If you have multiple CODESYS installations, you can create multiple server entries with different names:

```json
{
  "mcpServers": {
    "codesys_3_5_21": {
      "command": "npx",
      "args": [
        "-y",
        "@codesys/mcp-toolkit",
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.21.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP21"
      ]
    },
    "codesys_3_5_19": {
      "command": "npx",
      "args": [
        "-y",
        "@codesys/mcp-toolkit",
        "--codesys-path", "C:\\Program Files\\CODESYS 3.5.19.0\\CODESYS\\Common\\CODESYS.exe",
        "--codesys-profile", "CODESYS V3.5 SP19"
      ]
    }
  }
}
```

## Next Steps

- Try some [basic examples](examples.md)
- Learn about the [available tools and resources](api.md)
- Check the [troubleshooting guide](troubleshooting.md) if you encounter issues
