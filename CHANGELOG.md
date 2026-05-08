# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `create_pou` tool now accepts an optional `returnType` parameter (e.g. `"BOOL"`, `"STRING"`, `"INT"`) used when creating Function POUs.

### Fixed
- `create_pou` with `type: "Function"` no longer fails with `ValueError: Specified argument was out of the range of valid values. Parameter name: return_type`. The IronPython template now passes `return_type` to the CODESYS scripting API only for Function POUs (the Program/FunctionBlock paths are unchanged). Calling `create_pou` with `type: "Function"` and no `returnType` now returns a clear handler-level error instead of a Python traceback.

## [1.1.16] - 2025-05-06

### Fixed
- Reverted to v1.1.3 code base which has working POU creation functionality
- Fixed path handling by using simpler approach from v1.1.3
- Restored original Application object finding logic that worked in v1.1.3

## [1.0.0] - 2025-04-23

### Added
- Initial release of the MCP server for CODESYS
- Command-line interface with configuration options
- Project management functionality:
  - Opening existing CODESYS projects
  - Creating new CODESYS projects
  - Saving projects
- POU (Program Organization Unit) management:
  - Creating POUs (Programs, Function Blocks, Functions)
  - Setting POU code (declaration and implementation)
  - Creating properties and methods for Function Blocks
- Project compilation support
- Resources for querying:
  - Project status
  - Project structure
  - POU code
- Documentation for installation and usage
