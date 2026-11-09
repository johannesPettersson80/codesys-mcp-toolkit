// Build and start the panel dev host (see server.ts). Requires the panel to be built (npm run build:panel).
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Inside the repo so the external node_modules imports resolve.
const out = join(here, ".build");
const page = await build({ entryPoints: [join(here, "page.ts")], bundle: true, format: "iife", platform: "browser", write: false, logLevel: "warning" });
await build({
  entryPoints: [join(here, "server.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: join(out, "server.mjs"),
  logLevel: "warning",
  define: { "import.meta.url": JSON.stringify(pathToFileURL(join(here, "..", "..", "src", "panel.ts")).href) },
});
const { startDevHost } = await import(pathToFileURL(join(out, "server.mjs")).href);
await startDevHost(Number(process.argv[2] ?? 5199), page.outputFiles[0].text, join(here, "page.html"));
