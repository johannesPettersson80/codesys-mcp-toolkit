/**
 * Writes a composed mirror to its folder. The folder belongs to the toolkit:
 * only files listed in the previous manifest are ever removed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Composition, MirrorFile } from "./mirror.js";

const run = promisify(execFile);

export const MANIFEST = "mirror.json";

export interface Manifest {
  version: 1;
  syncedAt: string;
  project?: string;
  files: string[];
  hashes: Record<string, string>;
  map: Record<string, MirrorFile["map"]>;
  cycleMs: number;
  clockTask: string;
  harnessLine0: number;
  addresses: Record<string, string>;
  notes: string[];
  warnings: string[];
  enums?: string[];
  tests?: { name: string; path: string; kind: "program" | "function_block" }[];
}

export interface SyncResult {
  manifest: Manifest;
  changed: string[];
  added: string[];
  removed: string[];
  committed?: string;
}

export async function readManifest(dir: string): Promise<Manifest | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

const STATIC_FILES: Record<string, string> = {
  "io.toml": '[io]\ndriver = "simulated"\nparams = {}\n',
  "trust-lsp.toml": 'include_paths = ["src"]\n\n[project]\nvendor_profile = "codesys"\n',
  ".gitignore": "build/\nprogram.tpi\ndeployment-record.bin\n.trust-runtime/\nruntime.toml\n*.log\n",
};

/** Objects whose hash differs between two manifests. */
export function changedObjects(prev: Record<string, string> | undefined, next: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(next)) if (prev?.[k] !== v) out.push(k);
  for (const k of Object.keys(prev ?? {})) if (!(k in next)) out.push(k);
  return out;
}

export async function writeMirror(dir: string, c: Composition, simulationToml: string, project?: string, git = true): Promise<SyncResult> {
  await mkdir(join(dir, "src"), { recursive: true });
  const prev = await readManifest(dir);
  const all: { path: string; text: string }[] = [...c.files, { path: "simulation.toml", text: simulationToml }, ...Object.entries(STATIC_FILES).map(([path, text]) => ({ path, text }))];
  const added: string[] = [];
  for (const f of all) {
    const p = join(dir, f.path);
    const old = existsSync(p) ? await readFile(p, "utf8") : undefined;
    if (old === undefined) added.push(f.path);
    if (old !== f.text) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, f.text, "utf8");
    }
  }
  const now = new Set(all.map((f) => f.path));
  const removed: string[] = [];
  for (const f of prev?.files ?? []) {
    if (!now.has(f) && /^src\/[^/]+\.st$/.test(f)) {
      await rm(join(dir, f), { force: true });
      removed.push(f);
    }
  }
  const manifest: Manifest = {
    version: 1,
    syncedAt: new Date().toISOString(),
    project,
    files: [...now],
    hashes: c.hashes,
    map: Object.fromEntries(c.files.map((f) => [f.path, f.map])),
    cycleMs: c.cycleMs,
    clockTask: c.clockTask,
    harnessLine0: c.harnessLine0,
    addresses: Object.fromEntries(c.addresses),
    notes: c.notes,
    warnings: c.warnings,
    enums: c.enums,
    tests: c.tests,
  };
  await writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 1), "utf8");
  const result: SyncResult = { manifest, changed: changedObjects(prev?.hashes, c.hashes), added, removed };
  if (git) result.committed = await gitCommit(dir, result).catch(() => undefined);
  return result;
}

/** Commit the mirror (best effort; skipped when git is missing). */
async function gitCommit(dir: string, r: SyncResult): Promise<string | undefined> {
  const g = (...args: string[]) => run("git", ["-c", `safe.directory=${dir.replace(/\\/g, "/")}`, "-C", dir, ...args], { windowsHide: true });
  if (!existsSync(join(dir, ".git"))) await g("init", "-q");
  await g("add", "-A");
  const status = (await g("status", "--porcelain")).stdout.trim();
  if (!status) return undefined;
  const msg = r.changed.length ? `sync: ${r.changed.slice(0, 8).join(", ")}${r.changed.length > 8 ? ", ..." : ""}` : "sync";
  await g("-c", "user.name=codesys-mcp-toolkit", "-c", "user.email=mirror@codesys-mcp-toolkit.invalid", "commit", "-q", "-m", msg);
  return (await g("rev-parse", "--short", "HEAD")).stdout.trim();
}
