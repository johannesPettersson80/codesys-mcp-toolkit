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
  /** CODESYS's additional folder (SP22 keeps its add-ons there, e.g. Scripting). */
  additionalFolder?: string;
  /**
   * Run CODESYS without UI (default true). false (--show-window) starts it with its window,
   * which keeps painting while the watcher waits (system.delay serves the message loop). The
   * bridge never closes that window itself (not on a hang, not on stop) unless it never got ready.
   */
  noUI?: boolean;
  /** Folder that holds watcher.py and its modules (copied into the session). */
  watcherSource: string;
  /** Base folder for session folders. */
  sessionRoot: string;
  /** Extra environment (tests point PYTHONPATH at a fake scriptengine). */
  env?: Record<string, string>;
  /**
   * Attach to a Machine Expert / CODESYS window the user already has open instead of
   * starting one: the folder is the session folder, and the user runs the generated
   * `start_attach.py` in that window (Tools > Scripting > Execute Script File).
   * Nothing is spawned or killed.
   */
  attachDir?: string;
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
  /** Version of the CODESYS Scripting add-on, once CODESYS has started. */
  scripting?: string;
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

/** What to do about a start-up failure CODESYS explains in its output. */
export function startupHint(output: string): string {
  if (/no script engine implementation/i.test(output))
    return "This CODESYS installation has no scripting engine: add the \"CODESYS Scripting\" add-on to it with the CODESYS Installer. SP22 and later keep add-ons in an additional folder (CODESYS\\AdditionalFolders\\Default), which the toolkit passes as --additionalfolder: check it, or pass --codesys-additional-folder.\n";
  if (/must specify a profile/i.test(output)) return "CODESYS didn't accept the profile: check --codesys-profile (a file name in CODESYS\\Profiles, without .profile.xml).\n";
  return "";
}

const FILE_IN_USE = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Run a file operation, retrying while Windows reports the file as in use (another
 * process such as the watcher, an antivirus scan or the indexer has it open). That
 * lasts milliseconds; after `totalMs` the last error is thrown. Other errors throw at once.
 */
async function retryFs<T>(fn: () => Promise<T>, totalMs = 3_000): Promise<T> {
  const until = Date.now() + totalMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return await fn();
    } catch (e) {
      if (!FILE_IN_USE.has((e as NodeJS.ErrnoException).code ?? "") || Date.now() + delay > until) throw e;
      await sleep(delay);
    }
  }
}

/** How long a result file may stay unreadable (written in place, see write_json_atomic) before the call fails. */
const BAD_RESULT_MS = 3_000;

export class CodesysBridge {
  private opts: Required<Omit<BridgeOptions, "args" | "profile" | "env" | "log" | "attachDir">> &
    Pick<BridgeOptions, "args" | "profile" | "env" | "log" | "attachDir">;
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
  private scripting?: string;
  private lastError?: string;
  private exitInfo?: string;
  /** The end of CODESYS's own console output (for start-up errors). */
  private output = "";

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

  /** CODESYS runs with its window, which the user may be working in (--show-window). */
  get visible(): boolean {
    return !this.opts.noUI && !this.opts.attachDir;
  }

  /** The window or watcher belongs to the user, so it is never closed on a hang. */
  private get keepsWindow(): boolean {
    return this.visible || !!this.opts.attachDir;
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
    if (this.opts.attachDir) return this.doAttach(this.opts.attachDir);
    // A window that stopped answering (busy with the user, or a dialog) is still there:
    // wait for its watcher again rather than start a second CODESYS.
    if (this.visible && this.child && this.sessionDir) return this.rejoinWindow();
    const id =`${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
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
          ...(this.opts.additionalFolder ? [`--additionalfolder="${this.opts.additionalFolder}"`] : []),
        ];
    this.log(`starting ${this.opts.command} ${args.join(" ")}`);
    const child = spawn(this.opts.command, args, {
      env: {
        ...process.env,
        ...this.opts.env,
        CODESYS_MCP_DIR: dir,
        CODESYS_MCP_SCRIPTS: scripts,
        CODESYS_MCP_PARENT_PID: String(process.pid),
        ...(this.visible ? { CODESYS_MCP_UI: "1" } : {}),
      },
      // stdout/stderr are kept (the last 4 KB) so a failed start can say why. A window
      // (--show-window) is the user's and outlives the server: detached, with no pipes that
      // tie the two together; CODESYS shows its start-up errors in the window itself.
      stdio: this.visible ? "ignore" : ["ignore", "pipe", "pipe"],
      detached: this.visible,
      // windowsHide also hides a program's first window, so only without UI.
      windowsHide: !this.visible,
      // CODESYS wants --option="value with spaces"; pass our own quoting through.
      windowsVerbatimArguments: !this.opts.args,
    });
    this.child = child;
    if (this.visible) child.unref(); // the server may exit while the window stays open
    this.output = "";
    const keep = (d: Buffer) => {
      this.output = (this.output + d.toString()).slice(-4096);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
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
        try {
          this.scripting = (JSON.parse(readFileSync(readyFile, "utf8").replace(/^﻿/, "")) as { scripting?: string | null }).scripting ?? undefined;
        } catch {
          this.scripting = undefined; // only used for display
        }
        this.log(`watcher ready after ${this.readyAt - this.startedAt}ms (pid ${child.pid})${this.scripting ? `, Scripting ${this.scripting}` : ""}`);
        return;
      }
      if ((this.state as BridgeState) === "dead") {
        await sleep(200); // let the last output arrive
        const msg = `CODESYS exited during startup (${this.exitInfo}). ${startupHint(this.output)}${this.consoleTail()}${this.logTail()}`;
        this.lastError = msg;
        throw new BridgeError("startup_failed", msg);
      }
      await sleep(100);
    }
    await this.kill("startup timeout", true);
    const msg = `CODESYS did not start the watcher within ${Math.round(this.opts.startupTimeoutMs / 1000)}s. ${startupHint(this.output)}${this.consoleTail()}${this.logTail()}`;
    this.lastError = msg;
    throw new BridgeError("startup_timeout", msg);
  }

  /** Path of the script the user runs in their own window to start the watcher (attach mode). */
  get attachScript(): string | undefined {
    return this.opts.attachDir ? join(this.opts.attachDir, "scripts", "start_attach.py") : undefined;
  }

  /** Wait until the watcher in the window we started answers again (--show-window). */
  private async rejoinWindow(): Promise<void> {
    const deadline = Date.now() + this.opts.startupTimeoutMs;
    while (Date.now() < deadline && this.child) {
      const hb = this.readHeartbeat();
      // A busy op past its own deadline is the one that just failed: still stuck. (No grace
      // here, or a call that timed out a few ms before deadline + grace would count as working.)
      const working = hb?.state === "busy" && !(hb.deadline && Date.now() > hb.deadline * 1000);
      if (hb && hb.ageMs < this.opts.staleHeartbeatMs && (hb.state === "idle" || working)) {
        this.state = "ready";
        this.readyAt = Date.now();
        this.log(`the CODESYS window (pid ${this.child.pid}) answers again`);
        return;
      }
      if (hb && (hb.state === "stopped" || hb.state === "crashed")) break; // its watcher is gone for good
      await sleep(250);
    }
    if (!this.child) return this.doStart(); // the window was closed meanwhile: start a new one
    this.state = "dead";
    const msg = `The CODESYS window (pid ${this.child.pid}) doesn't answer: a dialog may be open there, or its watcher stopped. Nothing was closed. Answer or close the dialog, or close the window so the next call starts a new one.`;
    this.lastError = msg;
    throw new BridgeError("window_unresponsive", msg);
  }

  /** Prepare the session folder and wait for a watcher the user started in an open window. */
  private async doAttach(dir: string): Promise<void> {
    try {
      return await this.attachTo(dir);
    } catch (e) {
      this.state = "dead"; // never stay "starting" after a failure: the next call tries again
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  private async attachTo(dir: string): Promise<void> {
    const scripts = join(dir, "scripts");
    for (const d of [join(dir, "requests"), join(dir, "results"), scripts]) mkdirSync(d, { recursive: true });
    // Leftovers from an earlier run must not be carried out later. Only old files go: another
    // server may share this folder, and its request ids are unique.
    for (const d of ["requests", "results"]) {
      for (const f of readdirSync(join(dir, d))) {
        const p = join(dir, d, f);
        if (Date.now() - statSync(p).mtimeMs > 60_000) await rm(p, { force: true }).catch(() => undefined);
      }
    }
    await rm(join(dir, "stop.flag"), { force: true }).catch(() => undefined);
    for (const f of readdirSync(this.opts.watcherSource)) {
      if (!f.endsWith(".py")) continue;
      const from = join(this.opts.watcherSource, f);
      const to = join(scripts, f);
      try {
        if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
        copyFileSync(from, to);
      } catch (e) {
        // The window that runs the watcher keeps its files locked: it goes on with the code it has.
        this.log(`attach: could not update ${f} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); the running watcher keeps its version`);
      }
    }
    const launcher = [
      "# Generated by codesys-mcp-toolkit: run in the open window with Tools > Scripting > Execute Script File.",
      "import os, sys",
      "for _m in [m for m in sys.modules if m.startswith('mcp_')]:",
      "    del sys.modules[_m]",
      `os.environ["CODESYS_MCP_DIR"] = r"${dir}"`,
      `os.environ["CODESYS_MCP_SCRIPTS"] = r"${scripts}"`,
      'os.environ["CODESYS_MCP_ATTACH"] = "1"',
      `_p = r"${join(scripts, "watcher.py")}"`,
      "_f = open(_p)",
      "_src = _f.read()",
      "_f.close()",
      'exec(compile(_src, _p, "exec"), {"__name__": "mcp_watcher"})',
      "",
    ].join("\n");
    await writeFile(this.attachScript!, launcher, "utf8");
    this.sessionDir = dir;
    this.log(`attach mode: run ${this.attachScript} in the open window (Tools > Scripting > Execute Script File)`);

    const deadline = Date.now() + this.opts.startupTimeoutMs;
    while (Date.now() < deadline) {
      const hb = this.readHeartbeat();
      if (existsSync(join(dir, "ready.json")) && hb && (hb.state === "idle" || hb.state === "busy") && hb.ageMs < this.opts.staleHeartbeatMs) {
        this.state = "ready";
        this.readyAt = Date.now();
        try {
          this.scripting = (JSON.parse(readFileSync(join(dir, "ready.json"), "utf8").replace(/^﻿/, "")) as { scripting?: string | null }).scripting ?? undefined;
        } catch {
          this.scripting = undefined;
        }
        this.log(`attached to the open window (pid ${hb.pid})${this.scripting ? `, Scripting ${this.scripting}` : ""}`);
        return;
      }
      await sleep(250);
    }
    this.state = "dead";
    const msg = `No watcher answered in ${dir} within ${Math.round(this.opts.startupTimeoutMs / 1000)}s. In the open Machine Expert / CODESYS window, run ${this.attachScript} with Tools > Scripting > Execute Script File, then try again.`;
    this.lastError = msg;
    throw new BridgeError("attach_timeout", msg);
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
    await retryFs(() => writeFile(`${reqPath}.tmp`, JSON.stringify({ id, op, args, deadline_ms: timeoutMs }), "utf8"));
    await retryFs(() => rename(`${reqPath}.tmp`, reqPath));
    this.calls++;
    const started = Date.now();
    let lastCheck = 0;
    let badSince: number | undefined;
    for (;;) {
      if (existsSync(resPath)) {
        const raw = await retryFs(() => readFile(resPath, "utf8"));
        let res: WatcherResult;
        try {
          res = JSON.parse(raw.replace(/^﻿/, "")) as WatcherResult;
        } catch {
          // The watcher may still be writing it in place: read it again, for a few seconds at most.
          badSince ??= Date.now();
          if (Date.now() - badSince > BAD_RESULT_MS) {
            await unlink(resPath).catch(() => undefined);
            const msg = `The result of '${op}' couldn't be read: ${JSON.stringify(raw.slice(0, 200))}`;
            this.lastError = msg;
            throw new BridgeError("bad_result", msg);
          }
          await sleep(20);
          continue;
        }
        await unlink(resPath).catch(() => undefined);
        if (res.ok) return res.result as T;
        const e = res.error ?? { code: "unknown", message: "watcher returned no error details" };
        throw new BridgeError(e.code, e.message, e.detail);
      }
      const now = Date.now();
      if (this.state === "dead") {
        const msg = `CODESYS stopped while running '${op}' (${this.exitInfo ?? "unknown reason"}). ${this.consoleTail()}${this.logTail()}`;
        this.lastError = msg;
        throw new BridgeError("watcher_died", msg);
      }
      if (now - lastCheck > 1000) {
        lastCheck = now;
        const dialog = this.pendingDialog();
        if (dialog) {
          await this.kill(`dialog "${dialog}" during '${op}'`);
          const msg = this.visible
            ? `CODESYS opened a dialog ("${dialog}") during '${op}' and is waiting for an answer. Nothing was closed: answer it in the CODESYS window, then check the result and retry if needed.`
            : `CODESYS opened a dialog ("${dialog}") during '${op}' and is waiting for an answer, which a session without a window can't give. CODESYS was stopped and will restart on the next call; unsaved changes are lost. Do the same step once in the CODESYS window and answer the dialog there, then try again.`;
          this.lastError = msg;
          throw new BridgeError("dialog", msg);
        }
        const v = this.verdict();
        if (v === "hung") {
          await this.kill(`hung during '${op}'`);
          const msg = this.opts.attachDir
            ? `The open window stopped responding during '${op}' (a dialog may be waiting, or the watcher script was stopped). Nothing was closed. Check the window, run ${this.attachScript} again if needed, then retry.`
            : this.visible
              ? `The CODESYS window stopped responding during '${op}' (a dialog may be waiting there). Nothing was closed. Check the window, then retry.`
              : `CODESYS stopped responding during '${op}' and was restarted on the next call. Unsaved changes are lost.`;
          if (this.keepsWindow) await unlink(reqPath).catch(() => undefined);
          this.lastError = msg;
          throw new BridgeError("hung", msg);
        }
      }
      if (now - started > timeoutMs + this.opts.hungGraceMs) {
        await this.kill(`timeout in '${op}'`);
        const msg = this.keepsWindow
          ? `'${op}' took longer than ${Math.round(timeoutMs / 1000)}s in the ${this.visible ? "CODESYS" : "open"} window. Nothing was closed; check the window, then retry.`
          : `'${op}' took longer than ${Math.round(timeoutMs / 1000)}s; CODESYS was stopped and will restart on the next call.`;
        if (this.keepsWindow) await unlink(reqPath).catch(() => undefined);
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

  /** The end of what the program printed, for error messages. */
  private consoleTail(): string {
    const said = this.output.trim();
    return said ? `CODESYS said: ${said.slice(-800)}\n` : "";
  }

  /** The title of a dialog the watcher found CODESYS waiting on (dialog.json). */
  private pendingDialog(): string | undefined {
    if (!this.sessionDir) return undefined;
    const file = join(this.sessionDir, "dialog.json");
    if (!existsSync(file)) return undefined;
    try {
      return (JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as { title?: string }).title ?? "untitled";
    } catch {
      return undefined; // held for a moment: the next check reads it
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
      scripting: this.scripting,
      heartbeat: this.readHeartbeat(),
      verdict: this.verdict(),
      calls: this.calls,
      lastError: this.lastError,
      restarts: this.restarts,
    };
  }

  /** Ask the watcher to exit, then make sure the process is gone. */
  async stop(): Promise<void> {
    if (this.opts.attachDir) {
      // The window belongs to the user: leave the watcher running for the next session.
      this.state = "stopped";
      return;
    }
    if (this.visible) {
      // The user may be working in the window: stop its watcher and leave the window open.
      const pid = this.child?.pid;
      if (this.state === "ready" && this.child) await this.exchange("shutdown", {}, 5_000).catch(() => undefined);
      if (pid) this.log(`stopped; the CODESYS window (pid ${pid}) stays open`);
      this.child = undefined;
      this.state = "stopped";
      return;
    }
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

  /** `force` closes even a visible window (one that never got ready). */
  private async kill(reason: string, force = false): Promise<void> {
    if (this.opts.attachDir) {
      // Never close the user's window; just forget the watcher until it answers again.
      this.log(`attach: ${reason}; the window is left open`);
      this.state = "dead";
      return;
    }
    if (this.visible && !force && this.child) {
      // The window may be busy with the user or a dialog: keep it, and wait for it on the next call.
      this.log(`${reason}; the CODESYS window (pid ${this.child.pid}) is left open`);
      this.state = "dead";
      return;
    }
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
