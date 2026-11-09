/**
 * What CODESYS's own library browser knows about an installed library. Each
 * library in a repository has a `browsercache` XML file listing its objects
 * and their descriptions. Scripting can't read a compiled library's contents,
 * and this works for libraries the project doesn't reference yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BrowseEntry {
  name: string;
  comment?: string;
}

export interface InstalledLibrary {
  title: string;
  version: string;
  company: string;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");

export function parseBrowseCache(xml: string): BrowseEntry[] {
  const out: BrowseEntry[] = [];
  for (const node of xml.matchAll(/<Node\s+([^>]*?)\/?>/g)) {
    const attrs = new Map([...node[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1]!, decode(a[2]!)] as const));
    const name = attrs.get("Name");
    if (!name) continue;
    const comment = attrs.get("Comment")?.trim().replace(/\s+/g, " ");
    out.push({ name, ...(comment ? { comment } : {}) });
  }
  return out;
}

const versionParts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);

/** The newest of several installed versions, compared as numbers (3.5.22 is newer than 3.5.9). */
export function newestLibrary<T extends { version: string }>(libs: T[]): T | undefined {
  return [...libs].sort((a, b) => {
    const [x, y] = [versionParts(a.version), versionParts(b.version)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  })[0];
}

/** The library's browse cache in one of the repositories CODESYS reports. */
export function browseCacheFile(repositories: string[], lib: InstalledLibrary): string | undefined {
  return repositories.map((root) => join(root, lib.company, lib.title, lib.version, "browsercache")).find((f) => existsSync(f));
}

export function readBrowseCache(file: string): BrowseEntry[] {
  return parseBrowseCache(readFileSync(file, "utf8"));
}

/** A library's objects as text; `symbol` narrows it to names or descriptions containing that text. */
export function describeBrowse(head: string, entries: BrowseEntry[], symbol?: string, maxLines = 300): string {
  const want = symbol?.toLowerCase();
  const shown = want ? entries.filter((e) => e.name.toLowerCase().includes(want) || e.comment?.toLowerCase().includes(want)) : entries;
  if (want && !shown.length) return `${head} has nothing matching '${symbol}'.`;
  const lines = shown.slice(0, maxLines).map((e) => `- ${e.name}${e.comment ? ` :: ${e.comment}` : ""}`);
  const more = shown.length > maxLines ? [`... ${shown.length - maxLines} more. Pass symbol to narrow it.`] : [];
  return [`${head}: ${want ? `${shown.length} of ` : ""}${entries.length} objects, from CODESYS's library browser. Parameters aren't listed here; test a call with compile.`, ...lines, ...more].join("\n");
}
