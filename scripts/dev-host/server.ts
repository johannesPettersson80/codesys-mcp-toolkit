/**
 * Dev host for the simulation panel (not shipped). Runs the MCP server
 * in-process with the tank fixture as the CODESYS side and a real
 * trust-runtime, and serves a page that embeds the panel through the ext-apps
 * AppBridge, like Claude Desktop does.
 *
 *   TRUST_RUNTIME=<path> node scripts/dev-host/run.mjs [port]
 *
 * Then open http://localhost:<port>. POST /scenario runs a demo scenario
 * (start, experiment, breakpoint) so the panel has something to show.
 */
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createServer } from "../../src/server.js";
import { SimController } from "../../src/sim/controller.js";
import { PANEL_URI } from "../../src/sim/panel.js";
import type { AppContext } from "../../src/tools.js";
import { LINES, TANK_PLANT, tankNodes, tankTasks } from "../../test/fixtures/tank.js";

export async function startDevHost(port: number, hostJs: string, pageHtml: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cmcp-devhost-"));
  const project = join(root, "Tank.project");
  writeFileSync(join(root, "Tank.plant.toml"), TANK_PLANT.replace('initial_state = [0.2]', 'initial_state = [0.2]\ndisplay = { max = 2.5, unit = "m", label = "T101" }'));
  const sim = new SimController({ exportSt: async () => tankNodes(), tasks: async () => tankTasks(), projectPath: () => project }, { mirrorRoot: join(root, "mirrors"), log: (m) => console.error(m) });
  const ctx = { bridge: {} as AppContext["bridge"], autosave: false, workspace: root, startWaitMs: 0, sim } as AppContext;
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "dev-host", version: "1" }, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } as never });
  await client.connect(b);

  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  let scenario: Promise<void> | undefined;
  const log: string[] = [];
  const status: { running?: string; queued: string[]; done: string[]; error?: string } = { queued: [], done: [] };
  const step = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await call(name, args)) as { content: { text: string }[] };
    log.push(`> ${name}\n${r.content.map((c) => c.text).join("\n")}`);
  };
  const runScenario = async (which: string) => {
    if (which === "start") {
      await step("sync_mirror");
      await step("sim_start", { speed: 20 });
      await step("run_for", { seconds: 5 });
    } else if (which === "experiment") {
      await step("run_experiment", { name: "level step", duration_s: 300, speed: 20, pv: "GVL_IO.lrLT101_Level", sp: { var: "GVL_Par.rLevelSP", value: 1.2, at_s: 10 }, watch: ["PRG_Tank.nTrips"] });
    } else if (which === "tuned") {
      await step("run_experiment", { name: "level step", duration_s: 300, speed: 20, pv: "GVL_IO.lrLT101_Level", sp: { var: "GVL_Par.rLevelSP", value: 1.2, at_s: 10 }, set: { "PRG_Tank.fbPI._rKp": 150 }, watch: ["PRG_Tank.nTrips"] });
    } else if (which === "breakpoint") {
      await step("set_breakpoint", { path: "PRG_Tank", line: LINES.trip });
      await step("force_var", { name: "GVL_IO.lrLT101_Level", value: "2.4" });
      await step("continue", { timeoutMs: 30000 });
    } else if (which === "release") {
      await step("unforce_var", { name: "GVL_IO.lrLT101_Level" });
      await step("clear_breakpoint", { all: true });
      await step("run_for", { seconds: 2 });
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
          const r = await call(name, args ?? {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(r));
        } else if (req.url?.startsWith("/scenario/") && req.method === "POST") {
          const which = req.url.slice("/scenario/".length);
          const prev = scenario ?? Promise.resolve();
          status.queued.push(which);
          status.error = undefined;
          scenario = prev
            .then(async () => {
              status.queued.splice(status.queued.indexOf(which), 1);
              status.running = which;
              await runScenario(which);
              status.done = [...status.done.filter((d) => d !== which), which];
            })
            .catch((e: Error) => {
              status.error = `${which}: ${e.message}`;
              log.push(`error: ${e.message}`);
            })
            .finally(() => (status.running = undefined));
          res.writeHead(202);
          res.end("started");
        } else if (req.url === "/shutdown" && req.method === "POST") {
          res.writeHead(200);
          res.end("bye");
          await stop();
        } else if (req.url === "/status") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(status));
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

  const stop = async () => {
    await sim.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
