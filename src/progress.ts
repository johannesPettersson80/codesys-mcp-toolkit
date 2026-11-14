/**
 * MCP progress for long actions. A client that sends a progressToken gets
 * notifications/progress: a heartbeat while any action runs, and steps that
 * long actions report (an HMI export reports each page). Clients that reset
 * their timeout on progress then don't give up on a minute-long export.
 *
 * Code deep in an action calls reportProgress(); AsyncLocalStorage carries the
 * request's sink there, so nothing has to pass it along.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ProgressSink = (message: string) => void;

const store = new AsyncLocalStorage<ProgressSink>();

/** Tell the client what a long action is doing now (nothing happens without a progress token). */
export function reportProgress(message: string): void {
  store.getStore()?.(message);
}

export interface ProgressRequest {
  progressToken?: string | number;
  notify: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>;
}

export const HEARTBEAT_MS = 10_000;

/** Runs fn with progress reporting for this request; a heartbeat every HEARTBEAT_MS while it runs. */
export async function withProgress<T>(req: ProgressRequest | undefined, label: string, fn: () => Promise<T>, heartbeatMs = HEARTBEAT_MS): Promise<T> {
  const token = req?.progressToken;
  if (token === undefined || !req) return fn();
  let n = 0;
  const started = Date.now();
  const sink: ProgressSink = (message) => {
    req.notify({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } }).catch(() => undefined);
  };
  const timer = setInterval(() => sink(`${label}: still working (${Math.round((Date.now() - started) / 1000)} s)`), heartbeatMs);
  timer.unref?.();
  try {
    return await store.run(sink, fn);
  } finally {
    clearInterval(timer);
  }
}
