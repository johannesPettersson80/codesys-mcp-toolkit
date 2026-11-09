/** The full workspace: tree, editor tabs and bottom tabs. */
import { lineDiff } from "../../src/codesys/diff.js";
import { model, type ObjData, type WsNode } from "./model.js";
import { highlight } from "./st.js";
import { $, ago, esc, persist, segmented, store } from "./util.js";
import { reviewView, statusPill, viewTabs, type ViewName } from "./views.js";

const KIND_LABEL: Record<string, string> = {
  program: "PRG",
  function_block: "FB",
  function: "FN",
  method: "M",
  interface_method: "M",
  property: "P",
  accessor: "·",
  action: "A",
  gvl: "GVL",
  dut: "DUT",
  interface: "I",
  task_config: "TSK",
  task: "T",
  task_call: "·",
  library_manager: "LIB",
  folder: "",
};

export interface WorkspaceHooks {
  /** Ask main to fetch an object's text. */
  needObject(path: string): void;
  /** Tell the model what the user is looking at. */
  context(text: string): void;
  /** Run a user action (an app-only ui_* tool); `what` describes it for the model. */
  act(tool: string, args: Record<string, unknown>, what: string): Promise<{ ok: boolean; message: string } | undefined>;
  /** The user picked a view (stops following Claude). */
  pickView(view: ViewName): void;
  /** Follow Claude was switched. */
  followChanged(): void;
  /** Accept / Revert / show changes from a review list. */
  review(kind: string, path: string, btn: HTMLElement): void;
}

/**
 * Compile errors and warnings of one object by line: "impl:12" -> the message.
 * Positions read "Line 12, Column 5 (Impl)" (the column comes from CODESYS's offset).
 */
export function problemLines(path: string): Map<string, { severity: string; text: string }> {
  const out = new Map<string, { severity: string; text: string }>();
  for (const m of model.ws?.compile?.messages ?? []) {
    if ((m.object ?? "").toLowerCase() !== path.toLowerCase()) continue;
    const p = /Line (\d+)(?:, Column (\d+))?\s*\((Impl|Decl)\)/i.exec(m.position ?? "");
    if (!p) continue;
    const key = `${p[3]!.toLowerCase() === "decl" ? "decl" : "impl"}:${p[1]}`;
    const prev = out.get(key);
    if (prev?.severity === "error" && m.severity !== "error") continue; // an error wins over a warning
    out.set(key, { severity: m.severity, text: `${m.severity === "error" ? "Error" : "Warning"}${m.code ? ` ${m.code}` : ""}${p[2] ? ` (column ${p[2]})` : ""}: ${m.text}` });
  }
  return out;
}

export class Workspace {
  tabs: string[] = store("ws-tabs", [] as string[]);
  active?: string = store("ws-active", undefined as string | undefined);
  follow = store("ws-follow", true);
  diff = false;
  bottom = "problems";
  filter = "";
  collapsed = new Set<string>(store("ws-collapsed", [] as string[]));
  selected?: { path: string; part: "decl" | "impl"; line: number };
  private lastFocusAt?: string;
  private editorHtml = "";
  /** The current view (set by main) and whether it follows Claude. */
  view: ViewName = "code";

  constructor(private readonly hooks: WorkspaceHooks) {
    const hold = () => void hooks.act("ui_hold", { on: !model.state?.held }, model.state?.held ? "resumed Claude" : "paused Claude");
    $("w-hold").addEventListener("click", hold);
    $("w-held").addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-resume]")) hold();
    });
    $("w-filter").addEventListener("input", (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTree();
    });
    $("w-follow").addEventListener("click", () => {
      this.follow = !this.follow;
      persist("ws-follow", this.follow);
      hooks.followChanged();
    });
    $("w-views").addEventListener("click", (e) => {
      const v = (e.target as HTMLElement).closest<HTMLElement>("[data-view]")?.dataset.view as ViewName | undefined;
      if (v) hooks.pickView(v);
    });
    $("w-diff").addEventListener("click", () => {
      this.diff = !this.diff;
      $("w-diff").setAttribute("aria-pressed", String(this.diff));
      this.renderEditor(true);
    });
    segmented("w-bottom-tabs", (k) => {
      this.bottom = k;
      this.renderBottom();
    });
    $("w-tree").addEventListener("click", (e) => this.onTreeClick(e));
    $("w-tabs").addEventListener("click", (e) => this.onTabClick(e));
    $("w-editor").addEventListener("click", (e) => this.onEditorClick(e));
    $("w-bottom").addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const rv = t.closest<HTMLElement>("[data-rv]");
      if (rv) {
        const path = rv.closest<HTMLElement>("[data-path]")!.dataset.path!;
        if (rv.dataset.rv === "diff") {
          this.diff = true;
          $("w-diff").setAttribute("aria-pressed", "true");
          return this.open(path, true);
        }
        return this.hooks.review(rv.dataset.rv!, path, rv);
      }
      const p = t.closest<HTMLElement>("[data-open]")?.dataset.open;
      if (p) this.open(p, true);
    });
  }

  // ------------------------------------------------------------ actions

  open(path: string, byUser: boolean): void {
    const node = model.ws?.tree?.find((n) => n.path.toLowerCase() === path.toLowerCase());
    const p = node?.path ?? path;
    if (!this.tabs.some((t) => t.toLowerCase() === p.toLowerCase())) this.tabs = [...this.tabs, p].slice(-8);
    this.active = p;
    persist("ws-tabs", this.tabs);
    persist("ws-active", this.active);
    // reveal in the tree
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) this.collapsed.delete(parts.slice(0, i).join("/").toLowerCase());
    this.hooks.needObject(p);
    if (byUser) this.hooks.context(`The user opened ${p} in the CODESYS workspace panel.`);
    this.render();
  }

  close(path: string): void {
    this.tabs = this.tabs.filter((t) => t !== path);
    if (this.active === path) this.active = this.tabs.at(-1);
    persist("ws-tabs", this.tabs);
    persist("ws-active", this.active);
    this.render();
  }

  /** Follow Claude: open what it touched last. */
  autoFollow(): void {
    if (!this.follow) return;
    const f = model.ws?.focus;
    if (f && f.at !== this.lastFocusAt && f.action !== "delete") {
      this.lastFocusAt = f.at;
      if (model.ws?.tree?.some((n) => n.path.toLowerCase() === f.path.toLowerCase())) this.open(f.path, false);
    }
  }

  /** Lay the workspace out for a view: the bottom tab, the diff, and what is open. */
  applyView(v: ViewName): void {
    this.view = v;
    const bottom = v === "review" ? "review" : "problems";
    this.bottom = bottom;
    for (const b of $("w-bottom-tabs").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.t === bottom));
    this.diff = v === "review";
    $("w-diff").setAttribute("aria-pressed", String(this.diff));
    if (v === "review") {
      const changed = model.ws?.tree?.find((n) => n.change)?.path;
      if (changed) this.open(changed, false);
    }
    this.render();
  }

  // ------------------------------------------------------------ render

  render(): void {
    this.renderTop();
    this.renderTree();
    this.renderTabs();
    this.renderEditor();
    this.renderBottom();
  }

  renderTop(): void {
    const s = model.state;
    const pill = statusPill();
    $("w-status").className = pill.cls;
    $("w-statusText").textContent = pill.text;
    $("w-meta").textContent = [model.ws?.project?.split(/[\\/]/).pop(), model.ws?.versions].filter(Boolean).join(" · ");
    $("w-meta").title = model.ws?.versions ?? "";
    const f = model.ws?.focus;
    $("w-activity").textContent = f && Date.now() - Date.parse(f.at) < 60_000 ? `Claude ${f.action === "read" ? "is reading" : f.action === "write" ? "edited" : f.action === "create" ? "created" : f.action === "delete" ? "deleted" : f.action === "revert" ? "reverted" : "renamed"} ${f.path}` : "";
    $("w-follow").setAttribute("aria-pressed", String(this.follow));
    $("w-views").innerHTML = viewTabs(this.view, this.follow);
    const held = !!s?.held;
    $("w-hold").setAttribute("aria-pressed", String(held));
    $("w-hold").querySelector("span")!.textContent = held ? "Claude paused" : "Pause Claude";
    $("w-held").classList.toggle("hidden", !held);
  }

  private visibleNodes(): WsNode[] {
    const tree = model.ws?.tree ?? [];
    if (this.filter) {
      const keep = new Set<string>();
      for (const n of tree) {
        if (!n.name.toLowerCase().includes(this.filter)) continue;
        const parts = n.path.split("/");
        for (let i = 1; i <= parts.length; i++) keep.add(parts.slice(0, i).join("/").toLowerCase());
      }
      return tree.filter((n) => keep.has(n.path.toLowerCase()));
    }
    return tree.filter((n) => {
      const parts = n.path.split("/");
      for (let i = 1; i < parts.length; i++) if (this.collapsed.has(parts.slice(0, i).join("/").toLowerCase())) return false;
      return true;
    });
  }

  renderTree(): void {
    const el = $("w-tree");
    const tree = model.ws?.tree;
    if (!tree) {
      el.innerHTML = `<div class="empty">${model.ws?.project === null || !model.ws ? "Open a CODESYS project to see its tree." : "Loading the project…"}</div>`;
      return;
    }
    const f = model.ws?.focus;
    const claude = f && Date.now() - Date.parse(f.at) < 30_000 ? f.path.toLowerCase() : undefined;
    const hasKids = new Set<string>();
    tree.forEach((n, i) => {
      if ((tree[i + 1]?.depth ?? -1) > n.depth) hasKids.add(n.path.toLowerCase());
    });
    const rows = this.visibleNodes().map((n) => {
      const k = n.path.toLowerCase();
      const kind = n.kind === "pou" ? (n.sub ?? "pou") : n.kind;
      const label = KIND_LABEL[kind] ?? KIND_LABEL[n.kind] ?? "·";
      const kids = hasKids.has(k);
      const open = !this.collapsed.has(k) || !!this.filter;
      const marks: string[] = [];
      if (claude === k) marks.push(`<span class="mk claude" title="Claude worked here">✦</span>`);
      if (n.errors) marks.push(`<span class="mk err" title="${n.errors} compile error(s)">${n.errors}</span>`);
      if (n.change) marks.push(`<span class="mk ${n.change}" title="${n.change === "A" ? "Added" : "Modified"} since you last reviewed it">${n.change}</span>`);
      const dim = n.st === false || ["task_config", "task", "task_call", "library_manager", "device", "other"].includes(n.kind);
      const folderIcon = n.kind === "folder" ? `<svg width="14" height="12" viewBox="0 0 16 13" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.5 2.5h4l1.5 1.5h7.5v7.5h-13z"/></svg>` : label;
      return `<div class="tn${this.active?.toLowerCase() === k ? " sel" : ""}${dim ? " dim" : ""}" data-path="${esc(n.path)}" style="padding-left:${6 + n.depth * 14}px" title="${esc(n.path)}${n.st === false ? " (graphical, not ST)" : ""}">
<span class="tw" data-toggle="${kids ? esc(n.path) : ""}">${kids ? (open ? "▾" : "▸") : ""}</span><span class="ic k-${kind}">${folderIcon}</span><span class="nm">${esc(n.name)}</span><span class="marks">${marks.join("")}</span></div>`;
    });
    const removed = model.ws?.removed ?? [];
    el.innerHTML = rows.join("") + (removed.length ? `<div class="removed">Removed since session start: ${removed.map(esc).join(", ")}</div>` : "");
  }

  renderTabs(): void {
    $("w-tabs").innerHTML = this.tabs
      .map((t) => {
        const n = model.ws?.tree?.find((x) => x.path === t);
        return `<span class="tab${t === this.active ? " active" : ""}" data-tab="${esc(t)}" title="${esc(t)}">${esc(t.split("/").slice(-2).join("/"))}${n?.change ? ` <span class="mk ${n.change}">${n.change}</span>` : ""}<button class="x" data-close="${esc(t)}" aria-label="Close ${esc(t)}">×</button></span>`;
      })
      .join("");
  }

  renderEditor(force = false): void {
    const el = $("w-editor");
    if (!this.active) {
      this.setEditor(el, `<div class="empty">Select an object in the tree.</div>`, force);
      return;
    }
    const data = model.objects.get(this.active.toLowerCase());
    if (!data) {
      this.setEditor(el, `<div class="empty">Loading ${esc(this.active)}…</div>`, force);
      return;
    }
    this.setEditor(el, this.editorBody(this.active, data), force);
  }

  private setEditor(el: HTMLElement, html: string, force: boolean): void {
    if (!force && html === this.editorHtml) return;
    const keepScroll = !force && this.editorHtml !== "" && el.dataset.path === this.active;
    const top = el.scrollTop;
    this.editorHtml = html;
    el.innerHTML = html;
    el.dataset.path = this.active ?? "";
    if (keepScroll) el.scrollTop = top;
  }

  private editorBody(path: string, d: ObjData): string {
    const o = d.object;
    if (!o) return `<div class="empty">${esc(path)} was removed${d.base ? " since you last reviewed it" : ""}.</div>`;
    if (o.st === false) return `<div class="empty">${esc(path)} has a graphical body (SFC, CFC, LD or FBD), which isn't shown as text.</div>`;
    const out: string[] = [];
    for (const part of ["decl", "impl"] as const) {
      const text = part === "decl" ? o.declaration : o.implementation;
      if (text === null || (part === "impl" && !text.trim() && o.kind !== "pou" && o.kind !== "method" && o.kind !== "action" && o.kind !== "accessor")) continue;
      out.push(`<div class="part">${part === "decl" ? "Declaration" : "Implementation"}</div>`);
      const lines = (text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      const hs = { inComment: false };
      const problems = problemLines(path);
      if (this.diff && d.base) {
        const base = (part === "decl" ? d.base.declaration : d.base.implementation) ?? "";
        const ops = lineDiff(base.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), lines.join("\n"));
        let n = 0;
        for (const op of ops) {
          if (op.op !== "-") n++;
          const cls = op.op === "+" ? " add" : op.op === "-" ? " del" : "";
          out.push(`<div class="ln${cls}"><span class="sg">${op.op === " " ? "" : op.op}</span><span class="no">${op.op === "-" ? "" : n}</span><span class="tx">${highlight(op.text, hs) || " "}</span></div>`);
        }
        if (ops.every((x) => x.op === " ")) out.push(`<div class="empty">No changes since you last reviewed it.</div>`);
        continue;
      }
      lines.forEach((t, i) => {
        const no = i + 1;
        const sel = this.selected?.path === path && this.selected.part === part && this.selected.line === no;
        const problem = problems.get(`${part}:${no}`);
        out.push(
          `<div class="ln ${part}${sel ? " sel" : ""}${problem ? ` ${problem.severity === "error" ? "has-err" : "has-wrn"}` : ""}" data-part="${part}" data-line="${no}"${problem ? ` title="${esc(problem.text)}"` : ""}><span class="sg"></span><span class="no">${no}</span><span class="tx">${highlight(t, hs) || " "}</span></div>`,
        );
      });
    }
    if (this.diff && !d.base) out.unshift(`<div class="empty">${esc(path)} was added since you last reviewed it.</div>`);
    const node = model.ws?.tree?.find((n) => n.path.toLowerCase() === path.toLowerCase());
    if (node?.change) {
      out.unshift(
        `<div class="review"><span class="mk ${node.change}">${node.change}</span><span>${node.change === "A" ? "Added" : "Changed"} since you last reviewed it.</span>` +
          `<button class="btn" data-review="diff">${this.diff ? "Hide changes" : "Show changes"}</button>` +
          `<button class="btn good" data-review="accept" title="Mark the current text as reviewed">Accept</button>` +
          `<button class="btn danger" data-review="revert" title="Put the reviewed text back in CODESYS">Revert</button></div>`,
      );
    }
    return out.join("");
  }

  /** Accept / Revert / diff from the review bar. Revert asks for a second click. */
  private async review(kind: string, btn: HTMLElement): Promise<void> {
    const path = this.active!;
    if (kind === "diff") {
      this.diff = !this.diff;
      $("w-diff").setAttribute("aria-pressed", String(this.diff));
      return this.renderEditor(true);
    }
    if (kind === "accept") {
      await this.hooks.act("ui_accept_object", { path }, `accepted Claude's changes to ${path} after reviewing them`);
      return;
    }
    if (btn.dataset.confirm !== "1") {
      btn.dataset.confirm = "1";
      btn.textContent = "Click again to revert in CODESYS";
      setTimeout(() => {
        btn.dataset.confirm = "";
        btn.textContent = "Revert";
      }, 4000);
      return;
    }
    await this.hooks.act("ui_revert_object", { path }, `reverted ${path} in CODESYS to the reviewed version`);
  }

  renderBottom(): void {
    const el = $("w-bottom");
    const info = $("w-bottom-info");
    info.textContent = "";
    if (this.bottom === "review") {
      const html = reviewView();
      if (el.dataset.html !== html) {
        el.innerHTML = `<div class="vpad">${html}</div>`;
        el.dataset.html = html;
      }
      return;
    }
    delete el.dataset.html;
    const c = model.ws?.compile;
    const rows: string[] = [];
    if (c) {
      info.textContent = `compile ${ago(c.at)}: ${c.errors} error(s), ${c.warnings} warning(s)`;
      for (const m of c.messages) {
        const obj = m.object?.replace(/^\/+/, "");
        rows.push(`<div class="row"><span class="${m.severity === "error" ? "err" : "wrn"}">${m.severity === "error" ? "Error" : "Warning"}${m.code ? ` ${esc(m.code)}` : ""}</span> ${obj ? `<a href="#" data-open="${esc(obj)}">${esc(obj)}</a>${m.position ? ` <span class="muted">${esc(m.position)}</span>` : ""}: ` : ""}${esc(m.text)}</div>`);
      }
    }
    el.innerHTML = rows.length ? `<div class="list">${rows.join("")}</div>` : `<div class="empty">${c ? "No problems in the last compile." : "No compile yet in this session."}</div>`;
  }

  // ------------------------------------------------------------ events

  private onTreeClick(e: Event): void {
    const t = e.target as HTMLElement;
    const toggle = t.closest<HTMLElement>("[data-toggle]")?.dataset.toggle;
    const row = t.closest<HTMLElement>(".tn");
    if (!row) return;
    const path = row.dataset.path!;
    const node = model.ws?.tree?.find((n) => n.path === path);
    if (toggle || node?.kind === "folder") {
      const k = path.toLowerCase();
      if (this.collapsed.has(k)) this.collapsed.delete(k);
      else this.collapsed.add(k);
      persist("ws-collapsed", [...this.collapsed]);
      this.renderTree();
      if (toggle) return;
    }
    if (node && node.kind !== "folder") this.open(path, true);
  }

  private onTabClick(e: Event): void {
    const t = e.target as HTMLElement;
    const close = t.closest<HTMLElement>("[data-close]")?.dataset.close;
    if (close) return this.close(close);
    const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab;
    if (tab) this.open(tab, true);
  }

  private onEditorClick(e: Event): void {
    const t = e.target as HTMLElement;
    const review = t.closest<HTMLElement>("[data-review]")?.dataset.review;
    if (review && this.active) return void this.review(review, t.closest("button")!);
    const ln = t.closest<HTMLElement>(".ln[data-line]");
    if (!ln || !this.active) return;
    const part = ln.dataset.part as "decl" | "impl";
    const line = Number(ln.dataset.line);
    this.selected = { path: this.active, part, line };
    const text = ln.querySelector(".tx")?.textContent ?? "";
    this.hooks.context(`In the CODESYS workspace the user selected ${this.active} ${part === "decl" ? "declaration" : "implementation"} line ${line}: ${text.trim()}`);
    this.renderEditor(true);
  }
}
