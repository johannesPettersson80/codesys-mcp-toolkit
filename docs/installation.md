# Installation Guide

This guide covers how to install the CODESYS MCP Toolkit on your system.

## Prerequisites

Before installing, ensure you have:

1. **Node.js**: Version 18 or later
   - Download from [nodejs.org](https://nodejs.org/)
   - Verify installation with `node --version`

2. **CODESYS V3**: A working CODESYS V3 installation 
   - Tested with version 3.5 SP21
   - Must have the **Scripting Engine** component enabled
   - Verify by opening CODESYS and checking if scripting commands are available

3. **MCP Client**: An MCP-enabled application (e.g., Claude Desktop)

## Installation Methods

### Method 1: Install from npm (Recommended)

The simplest way to install is directly from npm:

```bash
npm install -g @codesys/mcp-toolkit
```

This installs the package globally on your system, making the `codesys-mcp-toolkit` command available in your terminal.

Verify the installation by running:

```bash
codesys-mcp-toolkit --version
```

### Method 2: Install from Source

For development or to get the latest unreleased changes:

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

Verify the installation using the same command as above.

## Next Steps

After installation:

1. [Configure your MCP client](configuration.md) to use the CODESYS MCP Toolkit
2. Try some [basic examples](examples.md)
3. Learn about the [available tools and resources](api.md)

## Troubleshooting Installation Issues

### Common Issues

- **Permission errors**: You may need to run npm with administrative privileges
  ```bash
  sudo npm install -g @codesys/mcp-toolkit  # On Linux/macOS
  # or use PowerShell as Administrator on Windows
  ```

- **Path issues**: Ensure the npm global bin directory is in your PATH

- **Node.js version**: Verify you have Node.js 18 or later
  ```bash
  node --version
  ```

If you encounter other issues, please check the [troubleshooting guide](troubleshooting.md) or [open an issue](https://github.com/yourusername/codesys-mcp-toolkit/issues) on GitHub.
