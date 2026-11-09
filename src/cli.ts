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
 *   --trust-runtime <exe>     trust-runtime for the simulation (default: TRUST_RUNTIME or PATH)
 *   --mirror-dir <dir>        where simulation mirrors go (default: %LOCALAPPDATA%\codesys-mcp-toolkit\mirrors)
 *   --no-sim                  don't offer the simulation tools
 *   --viewer-port <port>      port of the browser viewer on 127.0.0.1 (default 5180, next free one if taken)
 *   --no-viewer               don't serve the browser viewer
 *   --no-shared               run CODESYS in this process instead of the shared session
 *
 * By default every process started with the same options shares one session
 * (one CODESYS, one simulation, one viewer): see daemon.ts.
 */
import { spawn } from "node:child_process";
import { openSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CodesysBridge, pruneSessions } from "./bridge/bridge.js";
import { resolveCodesys } from "./codesys/install.js";
import { createServer, VERSION } from "./server.js";
import type { AppContext } from "./tools.js";
import { SimController } from "./sim/controller.js";
import { codesysSource } from "./sim/tools.js";
import { ChangeStore } from "./codesys/changes.js";
import { ProjectCache } from "./codesys/cache.js";
import { Driver } from "./driver.js";
import { startViewer } from "./viewer.js";
import { connectDaemon, serveDaemon, sessionKey } from "./daemon.js";

const log = (m: string) => process.stderr.write(`[codesys-mcp] ${m}\n`);

async function main() {
  const { values } = parseArgs({
    options: {
      "codesys-path": { type: "string" },
      "codesys-profile": { type: "string" },
      "codesys-additional-folder": { type: "string" },
      workspace: { type: "string" },
      project: { type: "string" },
      "session-dir": { type: "string" },
      "no-autostart": { type: "boolean" },
      "no-autosave": { type: "boolean" },
      "trust-runtime": { type: "string" },
      "mirror-dir": { type: "string" },
      "no-sim": { type: "boolean" },
      "viewer-port": { type: "string" },
      "no-viewer": { type: "boolean" },
      "no-shared": { type: "boolean" },
      // internal: run as the shared session's owner (see daemon.ts)
      daemon: { type: "string" },
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
      "codesys-mcp-tool [--codesys-path <CODESYS.exe>] [--codesys-profile <name>] [--codesys-additional-folder <dir>] [--workspace <dir>] [--project <file>] [--session-dir <dir>] [--no-autostart] [--no-autosave] [--trust-runtime <exe>] [--mirror-dir <dir>] [--no-sim] [--viewer-port <port>] [--no-viewer] [--no-shared]\n",
    );
    return;
  }

  const stateDir = process.env.CODESYS_MCP_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "codesys-mcp-toolkit");
  const cliFile = fileURLToPath(import.meta.url);
  // Processes with the same options (and the same build) share a session.
  const forward = process.argv.slice(2).filter((a) => a !== "--no-shared" && !a.startsWith("--daemon"));
  const key = sessionKey({
    args: forward,
    cwd: process.cwd(),
    version: VERSION,
    build: statSync(cliFile).mtimeMs,
    env: ["TRUST_RUNTIME", "TRUST_TOOLCHAIN", "TRUST_DEV"].map((k) => process.env[k] ?? ""),
  });

  if (values.daemon === undefined && !values["no-shared"]) {
    try {
      const c = await connectDaemon({
        dir: stateDir,
        key,
        spawnDaemon: (logFile) => {
          const out = openSync(logFile, "a");
          spawn(process.execPath, [cliFile, ...forward, `--daemon=${key}`], { detached: true, stdio: ["ignore", out, out], windowsHide: true, cwd: process.cwd(), env: process.env }).unref();
        },
      });
      log(`${c.spawned ? "started" : "joined"} the shared CODESYS session (pid ${c.info.pid}; log ${c.log})`);
      process.stdin.pipe(c.socket);
      c.socket.pipe(process.stdout);
      c.socket.on("close", () => process.exit(0));
      process.stdin.on("end", () => c.socket.end());
      return;
    } catch (e) {
      log(`shared session unavailable (${(e as Error).message}); running in this process`);
    }
  }

  const codesys = resolveCodesys(values["codesys-path"], values["codesys-profile"], values["codesys-additional-folder"]);
  const watcherSource = join(dirname(fileURLToPath(import.meta.url)), "..", "watcher");
  const sessionRoot = values["session-dir"] ?? join(tmpdir(), "codesys-mcp-toolkit");
  await pruneSessions(sessionRoot);

  const bridge = new CodesysBridge({
    command: codesys.exe,
    profile: codesys.profile,
    additionalFolder: codesys.install.additionalFolder,
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
  ctx.changes = new ChangeStore(join(process.env.LOCALAPPDATA ?? tmpdir(), "codesys-mcp-toolkit", "checkpoints"));
  ctx.cache = new ProjectCache();
  ctx.driver = new Driver();
  if (!values["no-sim"]) {
    const mirrorRoot = values["mirror-dir"] ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "codesys-mcp-toolkit", "mirrors");
    ctx.sim = new SimController(codesysSource(bridge, () => ctx.project?.path, ctx.startWaitMs, (nodes) => ctx.cache?.setAll(nodes)), { trustRuntime: values["trust-runtime"], mirrorRoot, log });
  }
  log(`v${VERSION}: ${codesys.install.label} (${codesys.reason}), profile "${codesys.profile}"${codesys.install.additionalFolder ? `, add-ons in ${codesys.install.additionalFolder}` : ""}, sessions in ${sessionRoot}`);

  // The viewer shows the panel, which comes with the simulation tools.
  if (ctx.sim && !values["no-viewer"]) {
    try {
      ctx.viewer = await startViewer(ctx, { port: values["viewer-port"] ? Number(values["viewer-port"]) : undefined, log });
    } catch (e) {
      log(`viewer not started: ${(e as Error).message}`);
    }
  }

  let stopping = false;
  let closeShared: (() => void) | undefined;
  let handle: { close(): Promise<void> } | undefined;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    closeShared?.();
    await ctx.sim?.stop().catch(() => undefined);
    await bridge.stop().catch(() => undefined);
    await handle?.close();
    process.exit(0);
  };

  if (values.daemon !== undefined) {
    // The shared session's owner: serve every client that connects, stop when idle.
    const idleMs = Number(process.env.CODESYS_MCP_IDLE_MS ?? 120_000);
    const owner = await serveDaemon({
      dir: stateDir,
      key: values.daemon || key,
      idleMs,
      log,
      onIdle: () => {
        log(`no clients for ${Math.round(idleMs / 1000)} s: stopping`);
        void shutdown();
      },
      onConnection: async (socket) => {
        const server = createServer(ctx);
        socket.on("close", () => void server.close().catch(() => undefined));
        await server.connect(new StdioServerTransport(socket, socket));
      },
    });
    closeShared = owner.close;
    log(`shared session ${owner.info.key} on 127.0.0.1:${owner.info.port} (pid ${process.pid})`);
  } else {
    handle = serveStdio(() => createServer(ctx));
    process.stdin.on("close", shutdown);
  }

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

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: Error) => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
