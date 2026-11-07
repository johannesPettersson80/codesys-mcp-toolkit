/**
 * Persistent CODESYS bridge.
 *
 * Starts CODESYS once with `--runscript=watcher.py` and talks to the watcher
 * through a file queue in a session folder:
 *   requests/<id>.json  (written tmp + rename by us)
 *   results/<id>.json   (written tmp + rename by the watcher)
 *   heartbeat.json      (idle/busy + deadline, rewritten every second when idle)
 *   ready.json          (written once the watcher loop runs)
 *   watcher.log
 *
 * Requests carry an op name and JSON arguments only; no code is generated.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, readFileSync, statSync } from "node:fs";
import { readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface BridgeOptions {
  /** Executable: CODESYS.exe in production, python in tests. */
  command: string;
  /** Full argument list; when omitted, CODESYS arguments are built from profile/noUI. */
  args?: (scriptPath: string) => string[];
  profile?: string;
  /** Run CODESYS without UI (default true). */
  noUI?: boolean;
  /** Folder that holds watcher.py and its modules (copied into the session). */
  watcherSource: string;
  /** Base folder for session folders. */
  sessionRoot: string;
  /** Extra environment (tests point PYTHONPATH at a fake scriptengine). */
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  defaultTimeoutMs?: number;
  /** Extra time after a busy op's deadline before the watcher counts as hung. */
  hungGraceMs?: number;
  /** An idle heartbeat older than this means the watcher is hung. */
  staleHeartbeatMs?: number;
  log?: (msg: string) => void;
}

export type BridgeState = "stopped" | "starting" | "ready" | "dead";

export interface Heartbeat {
  pid: number;
  ts: number;
  state: "idle" | "busy" | "stopped" | "crashed";
  op?: string | null;
  id?: string | null;
  deadline?: number | null;
  count?: number;
}

export interface BridgeHealth {
  state: BridgeState;
  pid?: number;
  sessionDir?: string;
  startedAt?: string;
  readyAfterMs?: number;
  heartbeat?: Heartbeat & { ageMs: number };
  verdict: "healthy" | "busy" | "hung" | "dead" | "starting" | "stopped";
  calls: number;
  lastError?: string;
  restarts: number;
}

export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

interface WatcherResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; detail?: string };
  ms?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CodesysBridge {
  private opts: Required<Omit<BridgeOptions, "args" | "profile" | "env" | "log">> &
    Pick<BridgeOptions, "args" | "profile" | "env" | "log">;
  private child?: ChildProcess;
  private state: BridgeState = "stopped";
  private startPromise?: Promise<void>;
  private sessionDir?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private calls = 0;
  private restarts = 0;
  private startedAt?: number;
  private readyAt?: number;
  private lastError?: string;
  private exitInfo?: string;

  constructor(options: BridgeOptions) {
    this.opts = {
      noUI: true,
      startupTimeoutMs: 300_000,
      defaultTimeoutMs: 60_000,
      hungGraceMs: 15_000,
      staleHeartbeatMs: 15_000,
      ...options,
    } as typeof this.opts;
  }

  get currentState(): BridgeState {
    return this.state;
  }

  /** Start CODESYS + watcher (idempotent). Resolves when the watcher is ready. */
  start(): Promise<void> {
    if (this.state === "ready") return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /** Wait at most `ms` for the bridge to be ready; false if still starting. */
  async waitReady(ms: number): Promise<boolean> {
    if (this.state === "ready") return true;
    const p = this.start();
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    try {
      return await Promise.race([p.then(() => true as const), t]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async doStart(): Promise<void> {
    if (this.state === "dead") this.restarts++;
    this.state = "starting";
    this.exitInfo = undefined;
    this.startedAt = Date.now();
    this.readyAt = undefined;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
    const dir = join(this.opts.sessionRoot, id);
    const scripts = join(dir, "scripts");
    mkdirSync(join(dir, "requests"), { recursive: true });
    mkdirSync(join(dir, "results"), { recursive: true });
    mkdirSync(scripts, { recursive: true });
    for (const f of readdirSync(this.opts.watcherSource)) {
      if (f.endsWith(".py")) copyFileSync(join(this.opts.watcherSource, f), join(scripts, f));
    }
    this.sessionDir = dir;
    const script = join(scripts, "watcher.py");
    const args = this.opts.args
      ? this.opts.args(script)
      : [
          ...(this.opts.profile ? [`--profile="${this.opts.profile}"`] : []),
          ...(this.opts.noUI ? ["--noUI"] : []),
          `--runscript="${script}"`,
        ];
    this.log(`starting ${this.opts.command} ${args.join(" ")}`);
    const child = spawn(this.opts.command, args, {
      env: {
        ...process.env,
        ...this.opts.env,
        CODESYS_MCP_DIR: dir,
        CODESYS_MCP_SCRIPTS: scripts,
        CODESYS_MCP_PARENT_PID: String(process.pid),
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
      // CODESYS wants --option="value with spaces"; pass our own quoting through.
      windowsVerbatimArguments: !this.opts.args,
    });
    this.child = child;
    child.on("exit", (code, signal) => {
      this.exitInfo = `exit code ${code ?? "?"}${signal ? ` signal ${signal}` : ""}`;
      this.log(`CODESYS process ${child.pid} ended: ${this.exitInfo}`);
      if (this.child === child) {
        this.state = "dead";
        this.child = undefined;
      }
    });
    child.on("error", (err) => {
      this.exitInfo = err.message;
      this.lastError = `spawn failed: ${err.message}`;
      if (this.child === child) {
        this.state = "dead";
        this.child = undefined;
      }
    });

    const readyFile = join(dir, "ready.json");
    const deadline = Date.now() + this.opts.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(readyFile)) {
        this.state = "ready";
        this.readyAt = Date.now();
        this.log(`watcher ready after ${this.readyAt - this.startedAt}ms (pid ${child.pid})`);
        return;
      }
      if ((this.state as BridgeState) === "dead") {
        const msg = `CODESYS exited during startup (${this.exitInfo}). ${this.logTail()}`;
        this.lastError = msg;
        throw new BridgeError("startup_failed", msg);
      }
      await sleep(100);
    }
    await this.kill("startup timeout");
    const msg = `CODESYS did not start the watcher within ${Math.round(this.opts.startupTimeoutMs / 1000)}s. ${this.logTail()}`;
    this.lastError = msg;
    throw new BridgeError("startup_timeout", msg);
  }

  /** Run one watcher op. Calls are serialised; the watcher is single-threaded. */
  call<T = unknown>(op: string, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    const run = async () => {
      await this.start();
      return this.exchange<T>(op, args, opts.timeoutMs ?? this.opts.defaultTimeoutMs);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async exchange<T>(op: string, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const dir = this.sessionDir!;
    const id = `${String(++this.seq).padStart(8, "0")}-${randomBytes(2).toString("hex")}`;
    const reqPath = join(dir, "requests", `${id}.json`);
    const resPath = join(dir, "results", `${id}.json`);
    await writeFile(`${reqPath}.tmp`, JSON.stringify({ id, op, args, deadline_ms: timeoutMs }), "utf8");
    await rename(`${reqPath}.tmp`, reqPath);
    this.calls++;
    const started = Date.now();
    let lastCheck = 0;
    for (;;) {
      if (existsSync(resPath)) {
        const raw = await readFile(resPath, "utf8");
        await unlink(resPath).catch(() => undefined);
        const res = JSON.parse(raw.replace(/^﻿/, "")) as WatcherResult;
        if (res.ok) return res.result as T;
        const e = res.error ?? { code: "unknown", message: "watcher returned no error details" };
        throw new BridgeError(e.code, e.message, e.detail);
      }
      const now = Date.now();
      if (this.state === "dead") {
        const msg = `CODESYS stopped while running '${op}' (${this.exitInfo ?? "unknown reason"}). ${this.logTail()}`;
        this.lastError = msg;
        throw new BridgeError("watcher_died", msg);
      }
      if (now - lastCheck > 1000) {
        lastCheck = now;
        const v = this.verdict();
        if (v === "hung") {
          await this.kill(`hung during '${op}'`);
          const msg = `CODESYS stopped responding during '${op}' and was restarted on the next call. Unsaved changes are lost.`;
          this.lastError = msg;
          throw new BridgeError("hung", msg);
        }
      }
      if (now - started > timeoutMs + this.opts.hungGraceMs) {
        await this.kill(`timeout in '${op}'`);
        const msg = `'${op}' took longer than ${Math.round(timeoutMs / 1000)}s; CODESYS was stopped and will restart on the next call.`;
        this.lastError = msg;
        throw new BridgeError("timeout", msg);
      }
      await sleep(now - started < 1000 ? 10 : 40);
    }
  }

  readHeartbeat(): (Heartbeat & { ageMs: number }) | undefined {
    if (!this.sessionDir) return undefined;
    try {
      const hb = JSON.parse(readFileSync(join(this.sessionDir, "heartbeat.json"), "utf8").replace(/^﻿/, "")) as Heartbeat;
      return { ...hb, ageMs: Math.max(0, Date.now() - hb.ts * 1000) };
    } catch {
      return undefined;
    }
  }

  private verdict(): BridgeHealth["verdict"] {
    if (this.state === "stopped") return "stopped";
    if (this.state === "dead") return "dead";
    if (this.state === "starting") return "starting";
    const hb = this.readHeartbeat();
    if (!hb) return "healthy";
    if (hb.state === "crashed" || hb.state === "stopped") return "dead";
    if (hb.state === "busy") {
      if (hb.deadline && Date.now() > hb.deadline * 1000 + this.opts.hungGraceMs) return "hung";
      return "busy";
    }
    return hb.ageMs > this.opts.staleHeartbeatMs ? "hung" : "healthy";
  }

  /** Snapshot that never waits on the watcher. */
  health(): BridgeHealth {
    return {
      state: this.state,
      pid: this.child?.pid,
      sessionDir: this.sessionDir,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : undefined,
      readyAfterMs: this.readyAt && this.startedAt ? this.readyAt - this.startedAt : undefined,
      heartbeat: this.readHeartbeat(),
      verdict: this.verdict(),
      calls: this.calls,
      lastError: this.lastError,
      restarts: this.restarts,
    };
  }

  /** Ask the watcher to exit, then make sure the process is gone. */
  async stop(): Promise<void> {
    if (this.state === "ready" && this.child) {
      try {
        await this.exchange("shutdown", {}, 5_000);
      } catch {
        /* fall through to kill */
      }
      const until = Date.now() + 10_000;
      while (this.child && Date.now() < until) await sleep(100);
    }
    await this.kill("stop");
    this.state = "stopped";
  }

  private async kill(reason: string): Promise<void> {
    const child = this.child;
    if (!child?.pid) {
      if (this.state !== "stopped") this.state = "dead";
      return;
    }
    this.log(`killing CODESYS ${child.pid}: ${reason}`);
    if (process.platform === "win32") {
      await new Promise<void>((r) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => r()));
    } else {
      child.kill("SIGKILL");
    }
    const until = Date.now() + 5_000;
    while (this.child === child && Date.now() < until) await sleep(50);
    this.child = undefined;
    this.state = "dead";
  }

  /** Last lines of watcher.log, for error messages. */
  logTail(lines = 5): string {
    if (!this.sessionDir) return "";
    try {
      const txt = readFileSync(join(this.sessionDir, "watcher.log"), "utf8").trim().split(/\r?\n/);
      return `watcher.log: ${txt.slice(-lines).join(" | ")}`;
    } catch {
      return "(no watcher.log yet)";
    }
  }

  private log(msg: string) {
    this.opts.log?.(`[bridge] ${msg}`);
  }
}

/** Remove session folders older than `maxAgeMs` (our own folders only). */
export async function pruneSessions(root: string, maxAgeMs = 2 * 24 * 3600_000): Promise<void> {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    try {
      if (statSync(p).isDirectory() && Date.now() - statSync(p).mtimeMs > maxAgeMs && existsSync(join(p, "scripts", "watcher.py"))) {
        await rm(p, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
