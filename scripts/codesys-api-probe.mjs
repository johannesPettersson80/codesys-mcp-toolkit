// Record the scripting API a CODESYS install offers, to compare service packs
// (docs/sp22-plan.md, step 1). Offline only: it opens a copy of a project
// without saving and never goes online.
//
//   npm run build
//   node scripts/codesys-api-probe.mjs <CODESYS.exe> "<profile>" <project> <out.json>
//
// Compare two results with scripts/codesys-api-diff.mjs.
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodesysBridge } from "../dist/bridge/bridge.js";
import { describeInstall } from "../dist/codesys/install.js";

const [exe, profile, project, out] = process.argv.slice(2);
if (!exe || !profile || !project || !out) {
  console.error('usage: node scripts/codesys-api-probe.mjs <CODESYS.exe> "<profile>" <project> <out.json>');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "cmcp-probe-"));
const copy = join(dir, basename(project)); // never touch the original
copyFileSync(project, copy);
const bridge = new CodesysBridge({
  command: exe,
  profile,
  additionalFolder: describeInstall(exe).additionalFolder, // SP22 keeps its add-ons there
  watcherSource: fileURLToPath(new URL("../watcher", import.meta.url)),
  sessionRoot: join(dir, "sessions"),
  log: (m) => console.error(m),
});
try {
  await bridge.start();
  const opened = await bridge.call("project.open", { path: copy }, { timeoutMs: 300_000 });
  const dumpPath = resolve(out.replace(/\.json$/i, "") + "-api.txt"); // absolute: CODESYS runs in another folder
  const reflectPath = resolve(out.replace(/\.json$/i, "") + "-reflect.json"); // Scripting 4.2 has no dump_scripting_api
  const probe = await bridge.call("api.probe", { dump_path: dumpPath, reflect_path: reflectPath }, { timeoutMs: 300_000 });
  const result = { exe, profile, project: basename(project), opened, ...probe };
  writeFileSync(out, JSON.stringify(result, null, 1));
  const n = Object.values(probe.members).reduce((s, m) => s + (m?.length ?? 0), 0);
  console.log(`${out}: ${n} members in ${Object.keys(probe.members).length} objects, ${Object.keys(probe.types).length} object types (${probe.unknown_types.length} unknown), python ${probe.python}; API dump: ${probe.dump}; reflected: ${probe.reflected}`);
} finally {
  await bridge.call("project.close", { discard_changes: true }).catch(() => undefined);
  await bridge.stop();
}
