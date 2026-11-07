/**
 * The browser viewer: the live panel in an ordinary browser window, served by
 * this MCP server on 127.0.0.1. For chats that can't show MCP Apps inline
 * (and for a second screen). The page talks to an in-process MCP connection
 * that shares the server's context, so it sees exactly what Claude's tools do.
 *
 * Only the panel's own tools are reachable (open/get_ and ui_ ones), and every
 * request needs the random token that is in the URL.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "./server.js";
import { panelHtml } from "./sim/panel.js";
import type { AppContext } from "./tools.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function viewerHtml(): string | undefined {
  for (const p of [join(HERE, "panel", "viewer.html"), join(HERE, "..", "dist", "panel", "viewer.html"), join(HERE, "..", "..", "dist", "panel", "viewer.html")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return undefined;
}

/** Tools the viewer page may call: the panel's reads and the user's actions. */
export function viewerMayCall(name: string): boolean {
  return /^(get_[a-z_]+|ui_[a-z_]+)$/.test(name);
}

export interface Viewer {
  url: string;
  /** Open the viewer in the default browser (once per process unless forced). */
  open(force?: boolean): boolean;
  close(): Promise<void>;
}

export async function startViewer(ctx: AppContext, o: { port?: number; log?: (m: string) => void; openBrowser?: (url: string) => void } = {}): Promise<Viewer> {
  const token = randomUUID();
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "codesys-viewer", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } as never });
  await client.connect(b);

  const body = (req: http.IncomingMessage) =>
    new Promise<string>((res, rej) => {
      let s = "";
      req.on("data", (d) => {
        s += d;
        if (s.length > 1_000_000) rej(new Error("too large"));
      });
      req.on("end", () => res(s));
      req.on("error", rej);
    });

  const httpServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, type: string, text: string) => {
        res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
        res.end(text);
      };
      if (req.method === "GET" && u.pathname === "/") {
        if (u.searchParams.get("t") !== token) return send(403, "text/plain; charset=utf-8", "This link is out of date. Ask Claude to call open_sim_panel for a new one.");
        const html = viewerHtml();
        return html ? send(200, "text/html; charset=utf-8", html) : send(500, "text/plain", "The viewer is not built. Run npm run build.");
      }
      if (req.method === "GET" && u.pathname === "/panel.html") {
        if (u.searchParams.get("t") !== token) return send(403, "text/plain", "forbidden");
        return send(200, "text/html; charset=utf-8", panelHtml());
      }
      if (req.method === "POST" && u.pathname === "/call") {
        // A custom header forces a CORS preflight, which this server never grants,
        // so other web pages can't call in even if they guess the port.
        if (req.headers["x-viewer-token"] !== token) return send(403, "text/plain", "forbidden");
        const { name, arguments: args } = JSON.parse(await body(req)) as { name: string; arguments?: Record<string, unknown> };
        if (!viewerMayCall(String(name))) return send(403, "text/plain", `the viewer may not call ${name}`);
        const r = await client.callTool({ name, arguments: args ?? {} });
        return send(200, "application/json", JSON.stringify(r));
      }
      send(404, "text/plain", "not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end((e as Error).message);
    }
  });

  // Prefer a stable port so a bookmarked tab keeps working; fall back to the next free ones.
  const base = o.port ?? 5180;
  const port = await new Promise<number>((resolve, reject) => {
    const tryPort = (p: number) => {
      httpServer.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && p < base + 20 && base !== 0) tryPort(p + 1);
        else reject(e);
      });
      httpServer.listen(p, "127.0.0.1", () => resolve((httpServer.address() as { port: number }).port));
    };
    tryPort(base);
  });
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  o.log?.(`viewer on http://127.0.0.1:${port}/`);

  let opened = false;
  const openBrowser =
    o.openBrowser ??
    ((target: string) => {
      const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", '""', `"${target}"`]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
      const child = spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
      child.on("error", (e) => o.log?.(`could not open the browser: ${e.message}`));
      child.unref();
    });

  return {
    url,
    open(force = false) {
      if (opened && !force) return false;
      opened = true;
      openBrowser(url);
      return true;
    },
    async close() {
      await new Promise<void>((r) => httpServer.close(() => r()));
      await client.close().catch(() => undefined);
    },
  };
}
