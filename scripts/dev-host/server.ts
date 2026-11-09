/**
 * Dev host for the panel (not shipped). Runs the MCP server in-process with
 * the tank fixture as the CODESYS side, and serves a page that embeds the
 * panel through the ext-apps AppBridge, like Claude Desktop does.
 *
 *   node scripts/dev-host/run.mjs [port]
 *
 * Then open http://localhost:<port>. POST /scenario/<edit|compile> shows
 * Claude changing an object and a compile with problems.
 */
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "../../src/server.js";
import { PANEL_URI } from "../../src/panel.js";
import type { AppContext } from "../../src/tools.js";
import { tankNodes, tankTestNodes } from "../../test/fixtures/tank.js";
import { ProjectCache } from "../../src/codesys/cache.js";
import { ChangeStore } from "../../src/codesys/changes.js";
import { Driver } from "../../src/driver.js";

export async function startDevHost(port: number, hostJs: string, pageHtml: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cmcp-devhost-"));
  const project = join(root, "Tank.project");
  // The dev host has no CODESYS: feed the workspace cache from the fixture, as the CODESYS tools would.
  const cache = new ProjectCache();
  const changes = new ChangeStore(join(root, "checkpoints"));
  const nodes = [...tankNodes(), ...tankTestNodes()];
  cache.reset(project);
  cache.setAll(structuredClone(nodes));
  await changes.sessionStart(project, async () => nodes);
  const ctx = { bridge: { health: () => ({ scripting: "4.2.0.0" }) } as unknown as AppContext["bridge"], codesys: { exe: "", profile: "", label: "CODESYS 3.5.22.40" }, autosave: false, workspace: root, startWaitMs: 0, cache, changes, project: { path: project, compiler_version: "3.5.22.40" }, driver: new Driver() } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "dev-host", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } as never });
  await client.connect(b);

  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const log: string[] = [];

  const runScenario = (which: string) => {
    if (which === "edit") {
      // What write_object does to the cache: Claude changes FB_PI's anti-windup.
      const fb = cache.get("FB_PI")!;
      cache.upsert({ ...fb, implementation: fb.implementation!.replace("rI := LIMIT(0.0, rI + _rKp * rE * rCycleS / _rTi, 100.0);", "IF rY > 0.0 AND rY < 100.0 THEN // anti-windup\n        rI := LIMIT(0.0, rI + _rKp * rE * rCycleS / _rTi, 100.0);\n    END_IF") });
      cache.touch("FB_PI", "write");
    } else if (which === "compile") {
      cache.setCompile({ at: new Date().toISOString(), errors: 1, warnings: 1, messages: [
        { severity: "error", text: "Identifier 'rIntegral' not defined", object: "FB_PI", position: "Line 4, Column 9 (Impl)", code: "C0077" },
        { severity: "warning", text: "Unused variable 'rE'", object: "FB_PI", position: "Line 14, Column 5 (Decl)", code: "C0373" },
      ] });
    } else if (which === "simulate") {
      ctx.codesysSim = { state: ctx.codesysSim?.state === "run" ? "stop" : "run", forced: ["PLC_PRG.xStart"], cycles: 0 };
    }
  };

  const body = (req: http.IncomingMessage) => new Promise<string>((res) => {
    let s = "";
    req.on("data", (d) => (s += d));
    req.on("end", () => res(s));
  });

  http
    .createServer(async (req, res) => {
      try {
        const path = (req.url ?? "/").split("?")[0];
        if (path === "/" || path === "/index.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(readFileSync(pageHtml, "utf8"));
        } else if (req.url === "/host.js") {
          res.writeHead(200, { "content-type": "text/javascript" });
          res.end(hostJs);
        } else if (req.url === "/panel.html") {
          const r = await client.readResource({ uri: PANEL_URI });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end((r.contents[0] as { text: string }).text);
        } else if (req.url === "/call" && req.method === "POST") {
          const { name, arguments: args } = JSON.parse(await body(req));
          if (!String(name).startsWith("get_")) log.push(`panel call ${name} ${JSON.stringify(args)}`);
          const r = await call(name, args ?? {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
        } else if (req.url?.startsWith("/scenario/") && req.method === "POST") {
          runScenario(req.url.slice("/scenario/".length));
          res.writeHead(202);
          res.end("done");
        } else if (req.url === "/shutdown" && req.method === "POST") {
          res.writeHead(200);
          res.end("bye");
          process.exit(0);
        } else if (req.url === "/status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ queued: [], done: [] }));
        } else if (req.url === "/log") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(log.join("\n\n"));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (e) {
        res.writeHead(500);
        res.end((e as Error).message);
      }
    })
    .listen(port, "127.0.0.1", () => console.error(`dev host on http://localhost:${port}`));
}
