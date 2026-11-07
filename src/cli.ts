#!/usr/bin/env node
/**
 * codesys-mcp-tool: stdio MCP server for CODESYS V3.5.
 *
 * Options (v1 names kept where they existed):
 *   --codesys-path <exe>      CODESYS.exe (default: newest install under Program Files)
 *   --codesys-profile <name>  profile, e.g. "CODESYS V3.5 SP21" (default: the install's newest)
 *   --workspace <dir>         base folder for relative project paths (default: cwd)
 *   --project <file>          open this project once CODESYS is up
 *   --session-dir <dir>       where session folders go (default: %TEMP%\codesys-mcp-toolkit)
 *   --no-autostart            start CODESYS on the first tool call instead of at launch
 *   --no-autosave             don't save after each change (use save_project)
 */
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CodesysBridge, pruneSessions } from "./bridge/bridge.js";
import { resolveCodesys } from "./codesys/install.js";
import { createServer, VERSION } from "./server.js";
import type { AppContext } from "./tools.js";

const log = (m: string) => process.stderr.write(`[codesys-mcp] ${m}\n`);

async function main() {
  const { values } = parseArgs({
    options: {
      "codesys-path": { type: "string" },
      "codesys-profile": { type: "string" },
      workspace: { type: "string" },
      project: { type: "string" },
      "session-dir": { type: "string" },
      "no-autostart": { type: "boolean" },
      "no-autosave": { type: "boolean" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (values.help) {
    process.stdout.write(
      "codesys-mcp-tool [--codesys-path <CODESYS.exe>] [--codesys-profile <name>] [--workspace <dir>] [--project <file>] [--session-dir <dir>] [--no-autostart] [--no-autosave]\n",
    );
    return;
  }

  const codesys = resolveCodesys(values["codesys-path"], values["codesys-profile"]);
  const watcherSource = join(dirname(fileURLToPath(import.meta.url)), "..", "watcher");
  const sessionRoot = values["session-dir"] ?? join(tmpdir(), "codesys-mcp-toolkit");
  await pruneSessions(sessionRoot);

  const bridge = new CodesysBridge({
    command: codesys.exe,
    profile: codesys.profile,
    watcherSource,
    sessionRoot,
    log,
  });
  const ctx: AppContext = {
    bridge,
    autosave: !values["no-autosave"],
    workspace: resolve(values.workspace ?? process.cwd()),
    templatesDir: codesys.install.templatesDir,
    codesys: { exe: codesys.exe, profile: codesys.profile, label: codesys.install.label },
    startWaitMs: 90_000,
  };
  log(`v${VERSION}: ${codesys.install.label}, profile "${codesys.profile}", sessions in ${sessionRoot}`);

  const handle = serveStdio(() => createServer(ctx));

  if (!values["no-autostart"]) {
    bridge
      .start()
      .then(async () => {
        if (values.project) {
          const r = await bridge.call<{ path: string; application?: string }>("project.open", { path: resolve(ctx.workspace, values.project) }, { timeoutMs: 300_000 });
          ctx.project = { path: r.path, application: r.application };
          log(`opened ${r.path}`);
        }
      })
      .catch((e: Error) => log(`CODESYS start failed: ${e.message}`));
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop().catch(() => undefined);
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e: Error) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
