// Compare two API probes (scripts/codesys-api-probe.mjs) as Markdown.
//
//   node scripts/codesys-api-diff.mjs <old.json> <new.json> [out.md]
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [aFile, bFile, out] = process.argv.slice(2);
const a = JSON.parse(readFileSync(aFile, "utf8"));
const b = JSON.parse(readFileSync(bFile, "utf8"));
const label = (p) => `${p.profile} (python ${p.python})`;
const lines = [`# CODESYS scripting API: ${label(a)} → ${label(b)}`, "", `Probed on \`${a.project}\` / \`${b.project}\`.`, ""];

const diff = (x = [], y = []) => ({ added: y.filter((n) => !x.includes(n)), removed: x.filter((n) => !y.includes(n)) });
const section = (title, xs, ys) => {
  const keys = [...new Set([...Object.keys(xs ?? {}), ...Object.keys(ys ?? {})])].sort();
  const rows = [];
  for (const k of keys) {
    if (xs?.[k] == null && ys?.[k] == null) continue;
    if (xs?.[k] == null || ys?.[k] == null) {
      rows.push(`| \`${k}\` | ${xs?.[k] == null ? "only in the new version" : "only in the old version"} | |`);
      continue;
    }
    const d = diff(xs[k], ys[k]);
    if (d.added.length || d.removed.length) rows.push(`| \`${k}\` | ${d.added.map((n) => `\`${n}\``).join(", ") || "–"} | ${d.removed.map((n) => `\`${n}\``).join(", ") || "–"} |`);
  }
  lines.push(`## ${title}`, "");
  if (rows.length) lines.push("| Object | Added | Removed |", "|---|---|---|", ...rows, "");
  else lines.push("No differences.", "");
};
section("Members", a.members, b.members);
section("Enums", a.enums, b.enums);

lines.push("## Version-like values", "", "| Object | Member | Old | New |", "|---|---|---|---|");
for (const k of [...new Set([...Object.keys(a.versions ?? {}), ...Object.keys(b.versions ?? {})])].sort()) {
  const x = a.versions?.[k] ?? {};
  const y = b.versions?.[k] ?? {};
  for (const m of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) lines.push(`| \`${k}\` | \`${m}\` | ${x[m] ?? "–"} | ${y[m] ?? "–"} |`);
}
lines.push("");

lines.push("## Object types", "");
const ta = a.types ?? {};
const tb = b.types ?? {};
const typeRows = [];
for (const g of [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort()) {
  if (ta[g]?.kind === tb[g]?.kind) continue;
  typeRows.push(`| \`${g}\` | ${ta[g] ? `${ta[g].kind} (${ta[g].example})` : "–"} | ${tb[g] ? `${tb[g].kind} (${tb[g].example})` : "–"} |`);
}
if (typeRows.length) lines.push("| Type GUID | Old | New |", "|---|---|---|", ...typeRows, "");
else lines.push("Every object type maps to the same kind.", "");
lines.push(`Unknown types: old ${a.unknown_types.length ? a.unknown_types.join(", ") : "none"}; new ${b.unknown_types.length ? b.unknown_types.join(", ") : "none"}.`, "");

// The full API from system.dump_scripting_api (<probe>-api.txt next to each probe), when both exist.
// Scripting 4.2 has no dump_scripting_api: then the probe's .NET reflection (<probe>-reflect.json) stands in.
const dumpOf = (f) => {
  for (const p of [f.replace(/\.json$/i, "") + "-api.txt", f.replace(/\.json$/i, "") + "-reflect.json"]) if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return undefined;
};
const da = dumpOf(aFile);
const db = dumpOf(bFile);
if (da && db) {
  // ".NET type, Assembly, Version=..., Culture=..." -> "Namespace.Type"
  const short = (t) => String(t ?? "void").split(",")[0].replace(/^System\./, "");
  // A dump against reflection formats types differently: compare names and parameter counts only.
  const mixed = /^reflection/.test(da.MetaData.Generator) !== /^reflection/.test(db.MetaData.Generator);
  const sig = (m) =>
    mixed
      ? `${m.MemberType === "Method" ? "" : `${m.MemberType} `}${m.Name}(${(m.Parameters ?? []).length} param${(m.Parameters ?? []).length === 1 ? "" : "s"})`
      : `${m.MemberType === "Method" ? "" : `${m.MemberType} `}${m.Name}(${(m.Parameters ?? []).map((p) => short(p.ParameterType ?? p.Type)).join(", ")}) → ${short(m.Type)}`;
  const types = (d) => new Map(d.Types.filter((t) => /ScriptEngine|ScriptDriver/i.test(`${t.Namespace} ${t.Assembly}`)).map((t) => [`${t.Namespace}.${t.Name}`, new Set((t.Members ?? []).map(sig))]));
  const ta2 = types(da);
  const tb2 = types(db);
  const added = [...tb2.keys()].filter((k) => !ta2.has(k)).sort();
  const removed = [...ta2.keys()].filter((k) => !tb2.has(k)).sort();
  lines.push(`## Full scripting API (dump_scripting_api)`, "", `${da.MetaData.Generator.split(",")[1]?.trim()} → ${db.MetaData.Generator.split(",")[1]?.trim()}; ${ta2.size} → ${tb2.size} scripting types.`, "");
  if (added.length) lines.push(`**New types (${added.length}):**`, "", ...added.map((k) => `- \`${k}\`: ${[...tb2.get(k)].map((s) => `\`${s}\``).join(", ") || "no members"}`), "");
  if (removed.length) lines.push(`**Removed types (${removed.length}):**`, "", ...removed.map((k) => `- \`${k}\``), "");
  const changed = [];
  for (const [k, ma] of ta2) {
    const mb = tb2.get(k);
    if (!mb) continue;
    const plus = [...mb].filter((s) => !ma.has(s));
    const minus = [...ma].filter((s) => !mb.has(s));
    if (plus.length || minus.length) changed.push(`- \`${k}\`${plus.length ? `\n  - added: ${plus.map((s) => `\`${s}\``).join(", ")}` : ""}${minus.length ? `\n  - removed: ${minus.map((s) => `\`${s}\``).join(", ")}` : ""}`);
  }
  lines.push(`**Changed types (${changed.length}):**`, "", ...(changed.length ? changed : ["None."]), "");
  const ext = (d) => new Set((d.ExtensionInformations ?? []).map((e) => `${short(e.ExtensionType)}: ${e.Explanation ?? ""}`));
  const ea = ext(da);
  const newExt = [...ext(db)].filter((e) => !ea.has(e));
  if (newExt.length) lines.push(`**New extensions (${newExt.length}):**`, "", ...newExt.map((e) => `- ${e}`), "");
}

const md = lines.join("\n");
if (out) writeFileSync(out, md);
else console.log(md);
