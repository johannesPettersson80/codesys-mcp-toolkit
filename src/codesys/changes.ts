/**
 * Change tracking for CODESYS edits: checkpoints (snapshots of every ST
 * object's text), diffs against them, and what's needed to revert.
 * Checkpoints live on disk per project, so they survive a server restart.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TreeNode } from "./st.js";
import { countDiff as count, lineDiff } from "./diff.js";
export { formatDiff, lineDiff, type DiffOp } from "./diff.js";

export interface SnapObject {
  path: string;
  name: string;
  kind: TreeNode["kind"];
  sub?: string;
  st?: boolean;
  declaration?: string;
  implementation?: string;
}

export interface Checkpoint {
  name: string;
  at: string;
  project: string;
  objects: SnapObject[];
}

/** Object kinds whose text is tracked (folders are tracked for structure only). */
const TRACKED = new Set(["pou", "method", "property", "accessor", "action", "dut", "gvl", "interface", "interface_method", "folder"]);

export function snapshot(nodes: TreeNode[]): SnapObject[] {
  return nodes
    .filter((n) => TRACKED.has(n.kind))
    .map((n) => ({
      path: n.path,
      name: n.name,
      kind: n.kind,
      ...(n.sub ? { sub: n.sub } : {}),
      ...(n.st === false ? { st: false } : {}),
      ...(n.declaration !== undefined ? { declaration: n.declaration } : {}),
      ...(n.implementation !== undefined ? { implementation: n.implementation } : {}),
    }));
}

const norm = (s: string | undefined) => (s ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");

export interface ObjectChange {
  path: string;
  kind: string;
  change: "added" | "removed" | "modified";
  decl?: { plus: number; minus: number };
  impl?: { plus: number; minus: number };
}

export function diffObjects(before: SnapObject[], after: SnapObject[]): ObjectChange[] {
  const b = new Map(before.map((o) => [o.path.toLowerCase(), o] as const));
  const a = new Map(after.map((o) => [o.path.toLowerCase(), o] as const));
  const out: ObjectChange[] = [];
  for (const [k, o] of a) {
    const old = b.get(k);
    if (!old) {
      out.push({ path: o.path, kind: o.kind, change: "added" });
      continue;
    }
    const d = norm(old.declaration) === norm(o.declaration) ? undefined : count(lineDiff(norm(old.declaration), norm(o.declaration)));
    const i = norm(old.implementation) === norm(o.implementation) ? undefined : count(lineDiff(norm(old.implementation), norm(o.implementation)));
    if (d || i) out.push({ path: o.path, kind: o.kind, change: "modified", ...(d ? { decl: d } : {}), ...(i ? { impl: i } : {}) });
  }
  for (const [k, o] of b) if (!a.has(k)) out.push({ path: o.path, kind: o.kind, change: "removed" });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export class ChangeStore {
  /** Projects that already have a session-start checkpoint in this process. */
  private started = new Set<string>();

  constructor(readonly root: string) {}

  dir(project: string): string {
    const base = basename(project).replace(/\.project$/i, "").replace(/[^A-Za-z0-9_.-]/g, "_");
    const h = createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 8);
    return join(this.root, `${base}-${h}`);
  }

  private file(project: string, name: string): string {
    return join(this.dir(project), `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  async save(project: string, name: string, nodes: TreeNode[]): Promise<Checkpoint> {
    const cp: Checkpoint = { name, at: new Date().toISOString(), project, objects: snapshot(nodes) };
    await mkdir(this.dir(project), { recursive: true });
    await writeFile(this.file(project, name), JSON.stringify(cp), "utf8");
    return cp;
  }

  async load(project: string, name: string): Promise<Checkpoint | undefined> {
    const f = this.file(project, name);
    if (!existsSync(f)) return undefined;
    return JSON.parse(await readFile(f, "utf8")) as Checkpoint;
  }

  async list(project: string): Promise<{ name: string; at: string; objects: number }[]> {
    const d = this.dir(project);
    if (!existsSync(d)) return [];
    const out: { name: string; at: string; objects: number }[] = [];
    for (const f of await readdir(d)) {
      if (!f.endsWith(".json")) continue;
      try {
        const cp = JSON.parse(await readFile(join(d, f), "utf8")) as Checkpoint;
        out.push({ name: cp.name, at: cp.at, objects: cp.objects.length });
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((x, y) => x.at.localeCompare(y.at));
  }

  /** Take the session-start checkpoint once per project per process. */
  async sessionStart(project: string, exportNodes: () => Promise<TreeNode[]>): Promise<boolean> {
    const key = project.toLowerCase();
    if (this.started.has(key)) return false;
    this.started.add(key);
    try {
      const nodes = await exportNodes();
      await this.save(project, "session-start", nodes);
      // The review baseline starts as the session start; Accept moves it per object.
      await this.save(project, REVIEW, nodes);
      return true;
    } catch {
      this.started.delete(key);
      return false;
    }
  }

  /** The review baseline (what the user has accepted); falls back to session-start. */
  async review(project: string): Promise<Checkpoint | undefined> {
    return (await this.load(project, REVIEW)) ?? (await this.load(project, "session-start"));
  }

  /** Accept the current state of an object and everything under it into the review baseline. */
  async accept(project: string, path: string, now: SnapObject[]): Promise<number> {
    const cp = await this.review(project);
    if (!cp) throw new Error("No review baseline yet: open the project first.");
    const key = path.replace(/^\/+/, "").toLowerCase();
    const inTree = (o: SnapObject) => o.path.toLowerCase() === key || o.path.toLowerCase().startsWith(key + "/");
    const kept = cp.objects.filter((o) => !inTree(o));
    const taken = now.filter(inTree);
    const objects = [...kept, ...taken];
    await mkdir(this.dir(project), { recursive: true });
    await writeFile(this.file(project, REVIEW), JSON.stringify({ ...cp, name: REVIEW, at: new Date().toISOString(), objects }), "utf8");
    return taken.length;
  }
}

/** Name of the checkpoint the workspace's diffs and badges compare against. */
export const REVIEW = "review";
