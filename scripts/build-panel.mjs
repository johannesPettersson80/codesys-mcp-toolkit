// Bundle the simulation panel into one self-contained HTML file:
// panel/src/main.ts (+ the ext-apps App class) -> minified IIFE, inlined into
// panel/sim-panel.html -> dist/panel/sim-panel.html.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await build({
  entryPoints: [join(root, "panel", "src", "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  write: false,
  legalComments: "none",
  logLevel: "warning",
  plugins: [
    {
      // zod ships error messages in ~40 languages; the panel only needs English.
      name: "zod-english-only",
      setup(b) {
        b.onResolve({ filter: /^\.\/[a-zA-Z-]+\.js$/ }, (args) => {
          if (!/[\\/]zod[\\/]v4[\\/]locales[\\/]?$/.test(args.resolveDir) || args.path === "./en.js") return undefined;
          return { path: args.path, namespace: "zod-locale-stub" };
        });
        b.onLoad({ filter: /.*/, namespace: "zod-locale-stub" }, () => ({ contents: "export default function () { return { localeError: () => undefined }; }", loader: "js" }));
      },
    },
  ],
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile(join(root, "panel", "sim-panel.html"), "utf8");
if (!template.includes("/*PANEL_SCRIPT*/")) throw new Error("panel template has no /*PANEL_SCRIPT*/ marker");
const html = template.replace("/*PANEL_SCRIPT*/", () => js);
await mkdir(join(root, "dist", "panel"), { recursive: true });
await writeFile(join(root, "dist", "panel", "sim-panel.html"), html, "utf8");
console.error(`panel: dist/panel/sim-panel.html (${(html.length / 1024).toFixed(0)} kB)`);
