/**
 * The panel's views. While "Follow Claude" is on, the view follows what Claude
 * is doing; clicking a view pins it.
 *
 *   Code    Claude writes, creates or compiles
 *   Review  Claude changed objects and has been quiet for a while
 */
import { countDiff, lineDiff, type DiffOp } from "../../src/codesys/diff.js";
import { model, type ObjData } from "./model.js";
import { highlight } from "./st.js";
import { ago, esc } from "./util.js";

export type ViewName = "code" | "review";

export const VIEWS: [ViewName, string][] = [
  ["code", "Code"],
  ["review", "Review"],
];

/** Review comes up only once Claude has been quiet this long, so it never interrupts work. */
export const REVIEW_AFTER_MS = 20_000;

export const views = {
  /** The view the user picked (used while not following Claude). */
  pinned: undefined as ViewName | undefined,
  /** Review rows whose changes the card shows in place (lower-case paths). */
  expanded: new Set<string>(),
};

export function unreviewed(): number {
  return model.ws?.changeCount ?? 0;
}

/** The view that fits what Claude is doing. */
export function autoView(): ViewName {
  return unreviewed() > 0 && (model.state?.phase?.quietMs ?? Infinity) > REVIEW_AFTER_MS ? "review" : "code";
}

export function currentView(follow: boolean): ViewName {
  return !follow && views.pinned ? views.pinned : autoView();
}

/** The status pill's text while CODESYS's own simulation runs. */
export function codesysSimLabel(sim: { state: string; forced: string[] }): string {
  return `CODESYS simulation: ${sim.state === "run" ? "running" : "stopped"}${sim.forced.length ? ` · ${sim.forced.length} forced` : ""}`;
}

/** The status pill: its CSS classes and text. */
export function statusPill(): { cls: string; text: string } {
  const s = model.state;
  const sim = s?.codesysSim;
  if (sim) return { cls: `pill ${sim.state === "run" ? "running" : "paused"}`, text: codesysSimLabel(sim) };
  return { cls: "pill", text: !s ? "Connecting" : model.ws?.project ? "Project open" : "No project" };
}

/** The view tab row; the view Claude's work points at is marked while following. */
export function viewTabs(current: ViewName, follow: boolean): string {
  const auto = autoView();
  const count = (id: ViewName): string => {
    if (id === "review" && unreviewed()) return `<span class="vc">${unreviewed()}</span>`;
    if (id === "code" && model.ws?.compile?.errors) return `<span class="vc bad">${model.ws.compile.errors}</span>`;
    return "";
  };
  return VIEWS.map(
    ([id, label]) =>
      `<button data-view="${id}" aria-pressed="${id === current}"${follow && id === auto ? ' class="auto" title="Claude is working here"' : ""}>${label}${count(id)}</button>`,
  ).join("");
}

// ------------------------------------------------------------------ code

/** The object Claude is working on (or the last one it changed). */
export function codePath(): string | undefined {
  const f = model.ws?.focus;
  if (f && f.action !== "delete" && f.action !== "read") return f.path;
  return model.ws?.tree?.find((n) => n.change)?.path ?? (f && f.action !== "delete" ? f.path : undefined);
}

/** Live code: the object as Claude writes it, with new lines marked. */
export function codeView(path: string | undefined, d: ObjData | undefined): string {
  if (!model.ws?.tree) return `<div class="empty">Open a project: Claude's code shows up here as it is written.</div>`;
  if (!path) return `<div class="empty">Waiting for Claude to write code. Each object it creates or changes shows here.</div>`;
  const f = model.ws.focus;
  const verb = f?.path === path ? ({ write: "is writing", create: "created", revert: "reverted", rename: "renamed" } as Record<string, string>)[f.action] ?? "" : "";
  const head = `<div class="vhead"><b>${esc(path)}</b>${verb ? `<span class="muted">Claude ${verb} it${f ? ` · ${ago(f.at)}` : ""}</span>` : ""}${compileLine()}</div>`;
  if (!d) return `${head}<div class="empty">Loading…</div>`;
  const o = d.object;
  if (!o) return `${head}<div class="empty">${esc(path)} was removed.</div>`;
  if (o.st === false) return `${head}<div class="empty">${esc(path)} has a graphical body (SFC, CFC, LD or FBD), which isn't shown as text.</div>`;
  const out: string[] = [head, `<div class="code live">`];
  for (const part of ["decl", "impl"] as const) {
    const text = part === "decl" ? o.declaration : o.implementation;
    if (text === null || (part === "impl" && !text.trim() && o.kind !== "pou" && o.kind !== "method" && o.kind !== "accessor")) continue;
    out.push(`<div class="part">${part === "decl" ? "Declaration" : "Implementation"}</div>`);
    const now = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    const base = d.base ? ((part === "decl" ? d.base.declaration : d.base.implementation) ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "") : "";
    const hs = { inComment: false };
    let n = 0;
    for (const op of lineDiff(base, now)) {
      if (op.op === "-") continue; // live view: what is there now; the Review view shows removals
      n++;
      out.push(`<div class="ln${op.op === "+" ? " add" : ""}"><span class="no">${n}</span><span class="tx">${highlight(op.text, hs) || " "}</span></div>`);
    }
  }
  out.push(`</div>`);
  return out.join("");
}

function compileLine(): string {
  const c = model.ws?.compile;
  if (!c) return "";
  return `<span class="cl ${c.errors ? "bad" : "good"}">${c.errors ? `${c.errors} compile error${c.errors > 1 ? "s" : ""}` : "Compiles"}${c.warnings ? `, ${c.warnings} warning${c.warnings > 1 ? "s" : ""}` : ""}</span>`;
}

/** Compile messages for the object (or all), below the code. */
export function problemsList(path?: string): string {
  const msgs = (model.ws?.compile?.messages ?? []).filter((m) => m.severity !== "info" && (!path || (m.object ?? "").toLowerCase().includes(path.toLowerCase().split("/")[0]!)));
  if (!msgs.length) return "";
  return `<ul class="problems">${msgs
    .slice(0, 6)
    .map((m) => `<li><span class="${m.severity === "error" ? "err" : "wrn"}">${m.severity === "error" ? "Error" : "Warning"}</span> ${esc(m.text)}${m.position ? ` <span class="muted">${esc(m.position)}</span>` : ""}</li>`)
    .join("")}</ul>`;
}

// ------------------------------------------------------------------ review

/** The changed objects to review: a changed object hides its changed children (they show inside its row). */
export function reviewRows(): { path: string; mark: "A" | "M" | "D"; members: string[] }[] {
  const tree = model.ws?.tree ?? [];
  const under = (p: string, q: string) => p.toLowerCase().startsWith(q.toLowerCase() + "/");
  const changed = tree.filter((n) => n.change);
  const top = changed.filter((n) => !changed.some((p) => under(n.path, p.path)));
  const removed = model.ws?.removed ?? [];
  return [
    ...top.map((n) => ({ path: n.path, mark: n.change!, members: [n.path, ...changed.filter((c) => under(c.path, n.path)).map((c) => c.path)] })),
    ...removed.filter((p) => !removed.some((q) => under(p, q))).map((p) => ({ path: p, mark: "D" as const, members: [] })),
  ];
}

const norm = (t: string | null | undefined) => (t ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");

/** The line diff of one object's declaration and implementation against the reviewed version. */
function objectDiff(d: ObjData): { part: "Declaration" | "Implementation"; ops: DiffOp[] }[] {
  if (!d.object) return [];
  const out: { part: "Declaration" | "Implementation"; ops: DiffOp[] }[] = [];
  for (const [part, now, was] of [
    ["Declaration", d.object.declaration, d.base?.declaration],
    ["Implementation", d.object.implementation, d.base?.implementation],
  ] as const) {
    if (now === null && !was) continue;
    out.push({ part, ops: lineDiff(norm(was), norm(now)) });
  }
  return out;
}

/** +added / -removed lines of a review row; undefined until its objects are loaded. */
export function rowCounts(members: string[]): { plus: number; minus: number } | undefined {
  let plus = 0;
  let minus = 0;
  for (const p of members) {
    const d = model.objects.get(p.toLowerCase());
    if (!d) return undefined;
    for (const { ops } of objectDiff(d)) {
      const c = countDiff(ops);
      plus += c.plus;
      minus += c.minus;
    }
  }
  return { plus, minus };
}

/** Only the changed lines, with `context` lines around them, numbered as in the new text. */
function hunks(ops: DiffOp[], context = 2): string {
  const keep = new Set<number>();
  ops.forEach((o, k) => {
    if (o.op !== " ") for (let d = -context; d <= context; d++) keep.add(k + d);
  });
  const hs = { inComment: false };
  const out: string[] = [];
  let n = 0;
  let last = -2;
  ops.forEach((o, k) => {
    if (o.op !== "-") n++;
    if (!keep.has(k)) {
      highlight(o.text, hs); // keep the comment state right across skipped lines
      return;
    }
    if (k !== last + 1 && out.length) out.push(`<div class="ln gap"><span class="no"></span><span class="tx">⋯</span></div>`);
    const cls = o.op === "+" ? " add" : o.op === "-" ? " del" : "";
    out.push(`<div class="ln${cls}"><span class="sg">${o.op === " " ? "" : o.op === "-" ? "−" : "+"}</span><span class="no">${o.op === "-" ? "" : n}</span><span class="tx">${highlight(o.text, hs) || " "}</span></div>`);
    last = k;
  });
  return out.join("");
}

/** A row's changes in place: each changed part of the object and its changed members. */
function rowDiff(members: string[]): string {
  const out: string[] = [];
  for (const p of members) {
    const d = model.objects.get(p.toLowerCase());
    if (!d) {
      out.push(`<div class="muted rd-load">Loading ${esc(p)}…</div>`);
      continue;
    }
    const parts = objectDiff(d).filter(({ ops }) => ops.some((o) => o.op !== " "));
    if (!parts.length) continue;
    if (members.length > 1) out.push(`<div class="rd-obj">${esc(p)}${d.base ? "" : ' <span class="muted">added</span>'}</div>`);
    for (const { part, ops } of parts) out.push(`<div class="part">${part}</div>${hunks(ops)}`);
  }
  return `<div class="code live rdiff">${out.join("") || `<div class="empty">No line changes.</div>`}</div>`;
}

/** The review list. `inline` (the chat card): Changes opens the diff in place; elsewhere it opens the editor. */
export function reviewView(inline = false): string {
  const rows = reviewRows();
  if (!rows.length) return `<div class="empty">Nothing to review: every change Claude made is accepted.</div>`;
  const row = (r: (typeof rows)[number]) => {
    const what = r.mark === "A" ? "added" : r.mark === "D" ? "removed" : "changed";
    const c = r.mark === "D" ? undefined : rowCounts(r.members);
    const counts = c ? ` <span class="good">+${c.plus}</span> <span class="bad">−${c.minus}</span>` : "";
    const open = inline && r.mark !== "D" && views.expanded.has(r.path.toLowerCase());
    return (
      `<li data-path="${esc(r.path)}"${open ? ' class="open"' : ""}><span class="mk ${r.mark}">${r.mark}</span><span class="rp"><b>${esc(r.path)}</b><span class="muted">${what}${counts}</span></span>` +
      (r.mark === "D" ? "" : `<button class="btn" data-rv="diff" aria-pressed="${open}">${open ? "Hide" : "Changes"}</button>`) +
      `<button class="btn good" data-rv="accept">Accept</button><button class="btn danger" data-rv="revert">Revert</button>` +
      (open ? `<div class="rd">${rowDiff(r.members)}<button class="lnk" data-rv="full">Open in full screen</button></div>` : "") +
      `</li>`
    );
  };
  return `<div class="vhead"><b>${rows.length} to review</b><span class="muted">since you last accepted</span></div><ul class="review-list">${rows.map(row).join("")}</ul>`;
}
