/**
 * Client for the truST runtime control endpoint: newline-delimited JSON over
 * TCP, `{id, type, auth, params}` in, `{id, ok, result | error}` out, one
 * request at a time per connection.
 *
 * Safety: the client only ever connects to a loopback address. The simulation
 * talks to the trust-runtime process the toolkit started, never to a
 * controller (the hard rule of the simulation design).
 */
import net from "node:net";

export class TrustError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function assertLoopback(host: string): void {
  if (!LOOPBACK.has(host)) throw new TrustError("not_loopback", `The simulation only connects to a local trust-runtime (127.0.0.1); refused ${host}.`);
}

export interface ControlOptions {
  host: string;
  port: number;
  token: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export class TrustControl {
  private sock?: net.Socket;
  private buf = "";
  private nextId = 1;
  private waiting?: { id: number; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
  private queue: Promise<unknown> = Promise.resolve();
  private connecting?: Promise<net.Socket>;

  constructor(private readonly o: ControlOptions) {
    assertLoopback(o.host);
  }

  get port(): number {
    return this.o.port;
  }

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: this.o.host, port: this.o.port });
      s.setNoDelay(true);
      s.once("connect", () => {
        this.sock = s;
        this.buf = "";
        resolve(s);
      });
      s.once("error", (e) => reject(new TrustError("connect_failed", `trust-runtime control endpoint ${this.o.host}:${this.o.port}: ${e.message}`)));
      s.on("data", (d) => this.onData(d));
      s.on("close", () => {
        if (this.sock === s) this.sock = undefined;
        if (this.waiting) {
          clearTimeout(this.waiting.timer);
          this.waiting.reject(new TrustError("connection_closed", "trust-runtime closed the control connection"));
          this.waiting = undefined;
        }
      });
    }).finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private onData(d: Buffer) {
    this.buf += d.toString("utf8");
    let k: number;
    while ((k = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, k);
      this.buf = this.buf.slice(k + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const w = this.waiting;
      if (w && msg.id === w.id) {
        clearTimeout(w.timer);
        this.waiting = undefined;
        w.resolve(msg);
      }
    }
  }

  /** Send one request; resolves with `result`, rejects with TrustError. */
  request<T = Record<string, unknown>>(type: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const run = async (): Promise<T> => {
      const s = await this.connect();
      const id = this.nextId++;
      const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = undefined;
          s.destroy();
          reject(new TrustError("timeout", `trust-runtime did not answer ${type} within ${timeoutMs ?? this.o.timeoutMs ?? 10000} ms`));
        }, timeoutMs ?? this.o.timeoutMs ?? 10000);
        this.waiting = { id, resolve, reject, timer };
        const req: Record<string, unknown> = { id, type, auth: this.o.token };
        if (params !== undefined) req.params = params;
        s.write(JSON.stringify(req) + "\n");
      });
      if (msg.ok !== true) {
        throw new TrustError(String(msg.error_code ?? "error"), String(msg.error ?? `${type} failed`));
      }
      return (msg.result ?? {}) as T;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.sock?.destroy();
    this.sock = undefined;
  }
}
