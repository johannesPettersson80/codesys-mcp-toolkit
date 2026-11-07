# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0-alpha.0] - unreleased

Rewrite. See README "Migrating from v1".

### Changed
- CODESYS runs once per session with a watcher script (file-queue IPC,
  JSON op requests, heartbeat, hang/crash detection and restart) instead of
  a cold `--runscript` per call.
- ESM TypeScript on MCP SDK v2 (`@modelcontextprotocol/server`), Node 20+.
- Tools act on the open project; new tool set (`read_objects`,
  `write_object`, `create_object`, `get_project_tree`, `search_code`,
  `compile`, `list_libraries`, `add_library`, `list_tasks`, `codesys_status`, ...).
- Structured Text only; graphical objects are listed as `[non-ST]`.
- Offline only: no online/login/download APIs (enforced by tests).

### Fixed
- `compile` returns errors and warnings with object, line and code (#10).
- Non-ASCII text round-trips (UTF-8 end to end) (#9).
- Reads work in Claude Desktop because they are tools, not resources (#6).
- Declarations that drop or change the object header are rejected (#5).
- Functions get their return type (#8).
- Object kinds come from type GUIDs, so localised CODESYS works.
- Interfaces are created without the implicit `__System.IQueryInterface` base.

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
