/**
 * The trust-runtime process: locate it, build the mirror, run it in
 * simulation mode on a loopback control port, stop it.
 *
 * Safety: before every start the mirror's configuration is checked to be
 * simulation-only (simulated I/O driver, simulation enabled, web UI,
 * discovery and mesh off, control endpoint on 127.0.0.1), and the runtime is
 * always started with --simulation, in which truST refuses physical drivers.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { TrustControl, TrustError } from "./control.js";

const exec = promisify(execFile);

export const TESTED_TRUST_VERSION = "0.34.0";

export function findTrustRuntime(explicit?: string): string | undefined {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  if (process.env.TRUST_RUNTIME) candidates.push(process.env.TRUST_RUNTIME);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, process.platform === "win32" ? "trust-runtime.exe" : "trust-runtime"));
  }
  return candidates.find((c) => existsSync(c));
}

/** trust-dev (test runner): next to trust-runtime, else TRUST_DEV, else PATH. */
export function findTrustDev(runtimeExe: string): string | undefined {
  const name = process.platform === "win32" ? "trust-dev.exe" : "trust-dev";
  const candidates = [join(dirname(runtimeExe), name)];
  if (process.env.TRUST_DEV) candidates.push(process.env.TRUST_DEV);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, name));
  return candidates.find((c) => existsSync(c));
}

/** trust-control-studio (Control Studio's engine: tuning): next to trust-runtime, else PATH. */
export function findControlStudio(runtimeExe: string): string | undefined {
  const name = process.platform === "win32" ? "trust-control-studio.exe" : "trust-control-studio";
  const candidates = [join(dirname(runtimeExe), name)];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, name));
  return candidates.find((c) => existsSync(c));
}

/** A Control Studio answer: `{result}` or `{failure}` (with --json). */
export interface StudioAnswer<T = unknown> {
  result?: T;
  failure?: { cause?: string; message: string; nextAction?: string };
  /** stderr, for diagnostics. */
  log?: string;
}

export interface TestCase {
  name: string;
  kind: string;
  status: string;
  message: string | null;
  /** Project-relative file, e.g. src/T_Tank.st. */
  file?: string;
  /** 1-based line truST reports (today the test's header line, TRUST-GAPS T2). */
  line?: number;
  durationMs?: number;
}

export interface TestRun {
  /** False when the tests could not be compiled or run at all. */
  ran: boolean;
  total: number;
  passed: number;
  failed: number;
  errors: number;
  durationMs: number;
  tests: TestCase[];
  diagnostics: Diagnostic[];
  output: string;
}

/** Parse `trust-dev test --output json`. */
export function parseTestJson(stdout: string, projectDir: string): TestRun | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  let doc: { summary?: Record<string, number>; tests?: Record<string, unknown>[] };
  try {
    doc = JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  if (!doc.summary || !Array.isArray(doc.tests)) return undefined;
  const root = projectDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const rel = (f: unknown) => {
    if (typeof f !== "string") return undefined;
    const p = f.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
    return p.toLowerCase().startsWith(root + "/") ? p.slice(root.length + 1) : p;
  };
  return {
    ran: true,
    total: doc.summary.total ?? doc.tests.length,
    passed: doc.summary.passed ?? 0,
    failed: doc.summary.failed ?? 0,
    errors: doc.summary.errors ?? 0,
    durationMs: doc.summary.duration_ms ?? 0,
    tests: doc.tests.map((t) => ({
      name: String(t.name),
      kind: String(t.kind ?? ""),
      status: String(t.status),
      message: typeof t.message === "string" ? t.message : null,
      file: rel(t.file),
      line: typeof t.line === "number" ? t.line : undefined,
      durationMs: typeof t.duration_ms === "number" ? t.duration_ms : undefined,
    })),
    diagnostics: [],
    output: "",
  };
}

export interface Diagnostic {
  file: string;
  /** Byte offsets in the file (from the text output). */
  start?: number;
  end?: number;
  /** 1-based line and column (from trust-lsp's JSON). */
  line?: number;
  column?: number;
  severity?: "error" | "warning" | "info";
  code?: string;
  message: string;
}

/** trust-lsp (language server; `check --format json` gives structured diagnostics): next to trust-runtime, else PATH. */
export function findTrustLsp(runtimeExe: string): string | undefined {
  const name = process.platform === "win32" ? "trust-lsp.exe" : "trust-lsp";
  const candidates = [join(dirname(runtimeExe), name)];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir) candidates.push(join(dir, name));
  return candidates.find((c) => existsSync(c));
}

/** Parse `trust-lsp check --format json`; undefined when it isn't that JSON. */
export function parseLspJson(stdout: string): Diagnostic[] | undefined {
  const start = stdout.indexOf("{");
  if (start < 0) return undefined;
  let doc: { diagnostics?: Record<string, unknown>[] };
  try {
    doc = JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(doc.diagnostics)) return undefined;
  return doc.diagnostics.map((d) => {
    const severity = d.severity === "error" || d.severity === "warning" || d.severity === "info" ? d.severity : undefined;
    const code = typeof d.code === "string" ? d.code : undefined;
    return {
      file: String(d.path ?? "").replace(/\\/g, "/"),
      line: typeof d.line === "number" ? d.line : undefined,
      column: typeof d.column === "number" ? d.column : undefined,
      severity,
      code,
      // the same form as the build's text output: "error[E101]: undefined identifier 'x'"
      message: `${severity ?? "error"}${code ? `[${code}]` : ""}: ${String(d.message ?? "")}`,
    };
  });
}

/** Parse "src/X.st: message at 113..119" lines from truST check/build output. */
export function parseDiagnostics(text: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*-\s*/, "").replace(/^(?:error|warning):\s*/i, "").replace(/^program compile failed:\s*/, "");
    const m = /^((?:src[\\/])?[^:\s][^:]*\.st):\s*(.*?)(?:\s+\(?at\s+(\d+)\.\.(\d+)\)?)?\s*$/.exec(line);
    if (m) out.push({ file: m[1]!.replace(/\\/g, "/"), message: m[2]!, start: m[3] ? Number(m[3]) : undefined, end: m[4] ? Number(m[4]) : undefined });
  }
  return out;
}

/** Throws unless the project folder is configured for simulation only. */
export async function assertSimulationOnly(dir: string): Promise<void> {
  const fail = (m: string): never => {
    throw new TrustError("not_simulation", `Refusing to start: ${m}. The simulation never drives real I/O.`);
  };
  const io = parseToml(await readFile(join(dir, "io.toml"), "utf8")) as { io?: { driver?: string; drivers?: unknown } };
  if (io.io?.driver !== "simulated" || io.io.drivers !== undefined) fail("io.toml must use only the simulated driver");
  const sim = parseToml(await readFile(join(dir, "simulation.toml"), "utf8")) as { simulation?: { enabled?: boolean } };
  if (sim.simulation?.enabled !== true) fail("simulation.toml must enable simulation");
  const rt = parseToml(await readFile(join(dir, "runtime.toml"), "utf8")) as {
    runtime?: { control?: { endpoint?: string }; web?: { enabled?: boolean }; discovery?: { enabled?: boolean }; mesh?: { enabled?: boolean } };
  };
  const ep = rt.runtime?.control?.endpoint ?? "";
  if (!/^tcp:\/\/127\.0\.0\.1:\d+$/.test(ep)) fail(`the control endpoint must be tcp://127.0.0.1 (found '${ep}')`);
  if (rt.runtime?.web?.enabled !== false) fail("the web UI must be disabled");
  if (rt.runtime?.discovery?.enabled !== false) fail("discovery must be disabled");
  if (rt.runtime?.mesh?.enabled !== false) fail("mesh must be disabled");
}

export function runtimeToml(o: { port: number; token: string; cycleMs: number }): string {
  return `# Generated by codesys-mcp-toolkit for simulation. Do not edit.
[bundle]
version = 1

[resource]
name = "Res"
cycle_interval_ms = ${o.cycleMs}

[runtime.control]
endpoint = "tcp://127.0.0.1:${o.port}"
auth_token = "${o.token}"
mode = "debug"
debug_enabled = true

[runtime.web]
enabled = false

[runtime.discovery]
enabled = false

[runtime.mesh]
enabled = false

[runtime.log]
level = "warn"

[runtime.retain]
mode = "none"
save_interval_ms = 1000

[runtime.watchdog]
enabled = false
timeout_ms = 1000
action = "halt"

[runtime.fault]
policy = "halt"
`;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface BuildResult {
  ok: boolean;
  output: string;
  diagnostics: Diagnostic[];
  ms: number;
}

export interface StartOptions {
  timeScale: number;
  cycleMs: number;
  startTimeoutMs?: number;
  /** Make the first request a pause, to stop as early as possible (truST can't start paused). */
  pause?: boolean;
}

export class TrustRuntime {
  private child?: ChildProcess;
  control?: TrustControl;
  dir?: string;
  exitInfo?: string;
  onExit?: (info: string) => void;
  /** The running instance's control endpoint and token (Control Studio connects to it). */
  endpoint?: { port: number; token: string };

  constructor(
    readonly exe: string,
    private readonly log: (m: string) => void = () => undefined,
  ) {
    process.once("exit", () => this.child?.kill());
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async version(): Promise<string> {
    const r = await exec(this.exe, ["--version"], { windowsHide: true });
    return r.stdout.trim().replace(/^trust-runtime\s+/, "");
  }

  async toolchain(): Promise<{ installed: boolean; version?: string; folder?: string }> {
    try {
      const r = await exec(this.exe, ["toolchain", "status", "--json"], { windowsHide: true });
      const j = JSON.parse(r.stdout) as { installed?: boolean; trust?: string; folder?: string };
      return { installed: !!j.installed, version: j.trust, folder: j.folder };
    } catch {
      return { installed: false };
    }
  }

  /** Run the project's tests with trust-dev (a separate process; the simulation can keep running). */
  async test(dir: string, o: { filter?: string; timeoutS?: number } = {}): Promise<TestRun> {
    const dev = findTrustDev(this.exe);
    if (!dev) throw new TrustError("no_trust_dev", `trust-dev (the truST test runner) was not found next to ${this.exe} or on PATH.`);
    const args = ["test", "--project", dir, "--output", "json", "--timeout", String(o.timeoutS ?? 10)];
    if (o.filter) args.push("--filter", o.filter);
    let stdout = "";
    let stderr = "";
    try {
      const r = await exec(dev, args, { windowsHide: true, maxBuffer: 32 << 20, timeout: 900_000 });
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message;
    }
    const parsed = parseTestJson(stdout, dir);
    if (parsed) return { ...parsed, output: stderr.trim() };
    const output = `${stdout}\n${stderr}`.trim();
    return { ran: false, total: 0, passed: 0, failed: 0, errors: 0, durationMs: 0, tests: [], diagnostics: await this.diagnose(dir, output), output };
  }

  /**
   * Run a Control Studio verb (setup, identify, tune, validate, ...) against
   * the project and, when it runs, this instance's control endpoint. Studio
   * keeps its study and journals in the mirror, next to the project.
   */
  async studio<T = unknown>(dir: string, verb: string, args: string[] = [], o: { timeoutMs?: number } = {}): Promise<StudioAnswer<T>> {
    const exe = findControlStudio(this.exe);
    if (!exe) throw new TrustError("no_control_studio", `trust-control-studio (truST's tuning engine) was not found next to ${this.exe}. It ships in truST's VS Code extension package (truST 0.34 or later).`);
    const full = [verb, "--project", dir, "--journal-dir", join(dir, ".control-studio"), "--json"];
    if (this.running && this.endpoint) {
      const tokenFile = join(dir, ".control-token");
      await writeFile(tokenFile, this.endpoint.token, { encoding: "utf8", mode: 0o600 });
      full.push("--endpoint", `tcp://127.0.0.1:${this.endpoint.port}`, "--token-file", tokenFile);
    }
    full.push(...args);
    let stdout = "";
    let stderr = "";
    try {
      const r = await exec(exe, full, { windowsHide: true, maxBuffer: 64 << 20, timeout: o.timeoutMs ?? 900_000, env: process.env });
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? err.message;
    }
    const first = stdout.indexOf("{");
    try {
      return { ...(JSON.parse(stdout.slice(first)) as StudioAnswer<T>), log: stderr.trim() };
    } catch {
      return { failure: { message: (stderr || stdout || "no answer").trim().split("\n").slice(-12).join("\n") }, log: stderr.trim() };
    }
  }

  /**
   * Call one Control Studio JSON-RPC method through `trust-control-studio serve`
   * (LSP-style Content-Length framing). Used for what the 0.34 CLI has no verb
   * for, such as setting a loop's requirements (TRUST-GAPS S5).
   */
  async studioRpc<T = unknown>(method: string, params: unknown, o: { timeoutMs?: number } = {}): Promise<T> {
    const exe = findControlStudio(this.exe);
    if (!exe) throw new TrustError("no_control_studio", `trust-control-studio (truST's tuning engine) was not found next to ${this.exe}.`);
    const child = spawn(exe, ["serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
    return new Promise<T>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      let stderr = "";
      let settled = false;
      const done = (err?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        setTimeout(() => child.kill(), 2000).unref();
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(() => done(new TrustError("studio_timeout", `Control Studio did not answer ${method}.`)), o.timeoutMs ?? 60_000);
      child.on("error", (e) => done(e));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("exit", (code) => done(new TrustError("studio_exited", `Control Studio exited (code ${code}) before answering ${method}. ${stderr.trim().split("\n").slice(-5).join(" ")}`)));
      child.stdout.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const sep = buf.indexOf("\r\n\r\n");
          if (sep < 0) return;
          const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, sep).toString());
          const len = Number(m?.[1] ?? 0);
          if (buf.length < sep + 4 + len) return;
          const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString()) as { id?: number; result?: T; error?: { message: string } };
          buf = buf.subarray(sep + 4 + len);
          if (msg.id !== 1) continue;
          if (msg.error) return done(new TrustError("studio_refused", msg.error.message));
          return done(undefined, msg.result as T);
        }
      });
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  }

  /** Structured diagnostics from trust-lsp when it is installed (TRUST-GAPS B16); errors only. */
  async check(dir: string): Promise<Diagnostic[] | undefined> {
    const lsp = findTrustLsp(this.exe);
    if (!lsp) return undefined;
    let stdout = "";
    try {
      stdout = (await exec(lsp, ["check", "--project", dir, "--format", "json"], { windowsHide: true, maxBuffer: 16 << 20, timeout: 120_000 })).stdout;
    } catch (e) {
      stdout = (e as { stdout?: string }).stdout ?? ""; // exit 1 means errors were found
    }
    return parseLspJson(stdout)?.filter((d) => d.severity === "error");
  }

  /** The diagnostics of a failed compile: trust-lsp's JSON, else the text output parsed. */
  private async diagnose(dir: string, output: string): Promise<Diagnostic[]> {
    const lsp = await this.check(dir).catch(() => undefined);
    return lsp?.length ? lsp : parseDiagnostics(output);
  }

  async build(dir: string): Promise<BuildResult> {
    const t0 = Date.now();
    try {
      const r = await exec(this.exe, ["build", "--project", dir], { windowsHide: true, maxBuffer: 16 << 20, timeout: 600_000 });
      return { ok: true, output: (r.stdout + r.stderr).trim(), diagnostics: [], ms: Date.now() - t0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message;
      return { ok: false, output, diagnostics: await this.diagnose(dir, output), ms: Date.now() - t0 };
    }
  }

  async start(dir: string, o: StartOptions): Promise<void> {
    if (this.running) throw new TrustError("already_running", "The simulation is already running.");
    const port = await freePort();
    const token = randomBytes(18).toString("hex");
    await writeFile(join(dir, "runtime.toml"), runtimeToml({ port, token, cycleMs: o.cycleMs }), "utf8");
    await assertSimulationOnly(dir);
    const logPath = join(dir, "runtime.log");
    const fd = openSync(logPath, "w");
    this.exitInfo = undefined;
    this.dir = dir;
    const child = spawn(this.exe, ["play", "--project", dir, "--no-console", "--simulation", "--time-scale", String(o.timeScale)], {
      cwd: dir,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    closeSync(fd);
    this.child = child;
    child.on("exit", (code, signal) => {
      this.exitInfo = `trust-runtime exited (${signal ?? `code ${code}`})`;
      this.log(this.exitInfo);
      if (this.child === child) {
        this.control?.close();
        this.control = undefined;
        if (!this.stopping) this.onExit?.(this.exitInfo);
      }
    });
    this.endpoint = { port, token };
    const control = new TrustControl({ host: "127.0.0.1", port, token, timeoutMs: 10_000 });
    const deadline = Date.now() + (o.startTimeoutMs ?? 30_000);
    for (;;) {
      if (child.exitCode !== null) {
        throw new TrustError("start_failed", `trust-runtime exited during start.\n${await this.logTail(20)}`);
      }
      try {
        await control.request(o.pause ? "pause" : "status", undefined, 2000);
        break;
      } catch {
        control.close();
        if (Date.now() > deadline) {
          await this.kill();
          throw new TrustError("start_timeout", `trust-runtime did not open its control endpoint.\n${await this.logTail(20)}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    this.control = control;
  }

  async logTail(n: number): Promise<string> {
    if (!this.dir) return "";
    try {
      return (await readFile(join(this.dir, "runtime.log"), "utf8")).trim().split(/\r?\n/).slice(-n).join("\n");
    } catch {
      return "";
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      await this.stopInner();
    } finally {
      this.stopping = false;
    }
  }

  private stopping = false;

  private async stopInner(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = undefined;
      return;
    }
    try {
      await this.control?.request("shutdown", { exit: true }, 3000);
    } catch {
      /* fall through to kill */
    }
    const exited = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), 5000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    if (!exited) await this.kill();
    this.control?.close();
    this.control = undefined;
    this.child = undefined;
  }

  async kill(): Promise<void> {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null) return;
    if (process.platform === "win32") {
      await exec("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => undefined);
    } else {
      child.kill("SIGKILL");
    }
  }
}
