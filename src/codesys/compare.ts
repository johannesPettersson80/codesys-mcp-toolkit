/**
 * Comparing two projects as the text files export_sources writes: what was
 * added, removed and changed, with a line diff per changed file. Pure, apart
 * from reading an export folder.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { countDiff, formatDiff, lineDiff } from "./diff.js";

const MANIFEST = ".codesys-export.json";
const TEXT = /\.(st|xml|txt|json)$/i;

/** An export_sources folder as relative path -> text (the files its manifest lists, or every text file). */
export function readSourceDir(dir: string): Map<string, string> {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder. Give a folder export_sources wrote, or a .project file.`);
  const out = new Map<string, string>();
  const manifest = join(dir, MANIFEST);
  let listed: string[] | undefined;
  if (existsSync(manifest)) {
    try {
      listed = (JSON.parse(readFileSync(manifest, "utf8")) as { files?: string[] }).files;
    } catch {
      listed = undefined;
    }
  }
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  if (listed) {
    for (const f of listed) if (!f.includes("..") && existsSync(join(dir, f))) out.set(f, norm(readFileSync(join(dir, f), "utf8")));
    return out;
  }
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(p);
      } else if (TEXT.test(e.name) && e.name !== MANIFEST) out.set(relative(dir, p).replace(/\\/g, "/"), norm(readFileSync(p, "utf8")));
    }
  };
  walk(dir);
  return out;
}

export interface Comparison {
  added: string[];
  removed: string[];
  changed: { file: string; plus: number; minus: number; diff: string[] }[];
  same: number;
}

/** What `to` has that `from` hasn't, the other way round, and the changed files with their diffs. */
export function compareSources(from: Map<string, string>, to: Map<string, string>, only?: string): Comparison {
  const want = (only ?? "").toLowerCase().replace(/^\/+|\/+$/g, "");
  const keep = (f: string) => {
    const l = f.toLowerCase();
    return !want || l === want || l.startsWith(`${want}.`) || l.startsWith(`${want}/`);
  };
  const out: Comparison = { added: [], removed: [], changed: [], same: 0 };
  for (const [f, text] of to) {
    if (!keep(f)) continue;
    const before = from.get(f);
    if (before === undefined) out.added.push(f);
    else if (before.trimEnd() === text.trimEnd()) out.same++;
    else {
      const ops = lineDiff(before.trimEnd(), text.trimEnd());
      out.changed.push({ file: f, ...countDiff(ops), diff: formatDiff(ops) });
    }
  }
  for (const f of from.keys()) if (keep(f) && !to.has(f)) out.removed.push(f);
  out.added.sort();
  out.removed.sort();
  out.changed.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** The comparison as text; diffs stop after maxLines lines in all. */
export function describeComparison(c: Comparison, fromName: string, toName: string, maxLines = 400): string {
  const object = (f: string) => (/\.xml$/i.test(f) ? `${f.slice(0, -4)} (graphical body)` : f.replace(/\.st$/i, ""));
  if (!c.added.length && !c.removed.length && !c.changed.length) return `No differences between ${fromName} and ${toName} (${c.same} file(s) compared).`;
  const lines = [
    `${fromName} -> ${toName}: ${c.changed.length} changed, ${c.added.length} added, ${c.removed.length} removed, ${c.same} the same.`,
  ];
  if (c.added.length) lines.push("", `Only in ${toName}:`, ...c.added.map((f) => `  + ${object(f)}`));
  if (c.removed.length) lines.push("", `Only in ${fromName}:`, ...c.removed.map((f) => `  - ${object(f)}`));
  if (c.changed.length) {
    lines.push("", "Changed:", ...c.changed.map((x) => `  ~ ${object(x.file)} (+${x.plus} -${x.minus})`));
    let budget = maxLines;
    for (const x of c.changed) {
      if (budget <= 0) {
        lines.push("", `(More diffs left out: pass path to see one object, or a larger max_lines.)`);
        break;
      }
      const shown = x.diff.slice(0, budget);
      lines.push("", `=== ${object(x.file)} ===`, ...shown);
      if (shown.length < x.diff.length) lines.push(`  ... (${x.diff.length - shown.length} more lines: pass path to see this object, or a larger max_lines)`);
      budget -= shown.length;
    }
  }
  return lines.join("\n");
}
