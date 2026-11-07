/**
 * One shared CODESYS session per configuration.
 *
 * Claude Desktop can start the server several times (one process per chat
 * surface). Each process used to launch its own CODESYS, so the panel card
 * could talk to a process that never opened the project. Now the first
 * process starts a background owner (the same CLI with --daemon) that runs
 * CODESYS, truST and the browser viewer; every stdio process just pipes its
 * MCP traffic to the owner over a local socket. The owner stops itself when
 * no client has been connected for a while.
 *
 * The owner listens on 127.0.0.1 only and requires a random token, which is
 * in a file under the user's profile.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  key: string;
  started: string;
}

export function sessionKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

export function daemonPaths(dir: string, key: string): { info: string; lock: string; log: string } {
  return { info: join(dir, `daemon-${key}.json`), lock: join(dir, `daemon-${key}.lock`), log: join(dir, `daemon-${key}.log`) };
}

function readInfo(file: string): DaemonInfo | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run the owner's listener. Each client that sends the token on its first line
 * is handed to onConnection with the rest of its stream. onIdle runs once no
 * client has been connected for idleMs.
 */
export async function serveDaemon(o: {
  dir: string;
  key: string;
  idleMs: number;
  onConnection: (socket: net.Socket) => Promise<void>;
  onIdle: () => void;
  log: (m: string) => void;
}): Promise<{ info: DaemonInfo; close: () => void }> {
  const token = randomUUID();
  const paths = daemonPaths(o.dir, o.key);
  let clients = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    clearTimeout(idle);
    if (clients === 0) idle = setTimeout(o.onIdle, o.idleMs);
  };

  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (buf.length > 256) socket.destroy();
        return;
      }
      socket.off("data", onData);
      socket.pause();
      if (buf.subarray(0, nl).toString("utf8").trim() !== token) {
        socket.destroy();
        return;
      }
      const rest = buf.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      clients++;
      clearTimeout(idle);
      socket.on("close", () => {
        clients--;
        armIdle();
      });
      o.onConnection(socket)
        .then(() => socket.resume())
        .catch((e: Error) => {
          o.log(`client failed: ${e.message}`);
          socket.destroy();
        });
    };
    socket.on("data", onData);
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const info: DaemonInfo = { pid: process.pid, port: (server.address() as net.AddressInfo).port, token, key: o.key, started: new Date().toISOString() };
  mkdirSync(o.dir, { recursive: true });
  try {
    // Exclusive: if two owners race, the second one gives up.
    writeFileSync(paths.info, JSON.stringify(info), { flag: "wx", mode: 0o600 });
  } catch {
    server.close();
    throw new Error(`another process owns this session (${paths.info})`);
  }
  armIdle();
  return {
    info,
    close: () => {
      server.close();
      // Only remove the file if it is still ours.
      if (readInfo(paths.info)?.token === token) rmSync(paths.info, { force: true });
    },
  };
}

function tryConnect(info: DaemonInfo): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const s = net.connect(info.port, "127.0.0.1");
    s.once("connect", () => {
      s.write(`${info.token}\n`);
      resolve(s);
    });
    s.once("error", () => resolve(undefined));
  });
}

/**
 * Connect to the owner of this session, starting it if there is none.
 * Several processes may start at the same moment; a lock file makes exactly
 * one of them spawn the owner, and the rest wait for it.
 */
export async function connectDaemon(o: { dir: string; key: string; spawnDaemon: (logFile: string) => void; waitMs?: number }): Promise<{ socket: net.Socket; info: DaemonInfo; spawned: boolean; log: string }> {
  const paths = daemonPaths(o.dir, o.key);
  mkdirSync(o.dir, { recursive: true });
  const deadline = Date.now() + (o.waitMs ?? 20_000);
  let spawned = false;
  while (Date.now() < deadline) {
    const info = readInfo(paths.info);
    if (info) {
      const socket = await tryConnect(info);
      if (socket) {
        if (spawned) rmSync(paths.lock, { force: true });
        return { socket, info, spawned, log: paths.log };
      }
      if (!alive(info.pid)) rmSync(paths.info, { force: true });
    } else if (!spawned) {
      try {
        closeSync(openSync(paths.lock, "wx"));
        spawned = true;
        o.spawnDaemon(paths.log);
      } catch {
        // Someone else is starting it; a lock older than 30 s is left over from a crash.
        try {
          if (Date.now() - statSync(paths.lock).mtimeMs > 30_000) rmSync(paths.lock, { force: true });
        } catch {
          /* gone already */
        }
      }
    }
    await sleep(150);
  }
  if (spawned) rmSync(paths.lock, { force: true });
  throw new Error(`no shared session came up within ${Math.round((o.waitMs ?? 20_000) / 1000)} s (see ${paths.log})`);
}
