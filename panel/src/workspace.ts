/** The full workspace: tree, editor tabs, inspector, bottom tabs. */
import { lineDiff } from "../../src/codesys/diff.js";
import { model, type ObjData, type WsNode } from "./model.js";
import { renderPid } from "./plant.js";
import { highlight } from "./st.js";
import { drawTrend } from "./trend.js";
import { $, ago, esc, persist, segmented, show, store } from "./util.js";

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
}

export class Workspace {
  tabs: string[] = store("ws-tabs", [] as string[]);
  active?: string = store("ws-active", undefined as string | undefined);
  follow = store("ws-follow", true);
  diff = false;
  insp = "watch";
  bottom = "trend";
  filter = "";
  collapsed = new Set<string>(store("ws-collapsed", [] as string[]));
  watch: string[] = store("ws-watch", [] as string[]);
  selected?: { path: string; part: "decl" | "impl"; line: number };
  private lastFocusAt?: string;
  private lastStopKey?: string;
  private editorHtml = "";

  constructor(private readonly hooks: WorkspaceHooks) {
    $("w-filter").addEventListener("input", (e) => {
      this.filter = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTree();
    });
    $("w-follow").addEventListener("click", () => {
      this.follow = !this.follow;
      persist("ws-follow", this.follow);
      this.renderTop();
    });
    $("w-diff").addEventListener("click", () => {
      this.diff = !this.diff;
      $("w-diff").setAttribute("aria-pressed", String(this.diff));
      this.renderEditor(true);
    });
    segmented("w-insp-tabs", (k) => {
      this.insp = k;
      this.renderInspector();
    });
    segmented("w-bottom-tabs", (k) => {
      this.bottom = k;
      this.renderBottom();
    });
    $("w-tree").addEventListener("click", (e) => this.onTreeClick(e));
    $("w-tabs").addEventListener("click", (e) => this.onTabClick(e));
    $("w-editor").addEventListener("click", (e) => this.onEditorClick(e));
    $("w-insp").addEventListener("click", (e) => this.onInspectorClick(e));
    $("w-insp").addEventListener("submit", (e) => this.onWatchAdd(e));
    $("w-bottom").addEventListener("click", (e) => {
      const p = (e.target as HTMLElement).closest<HTMLElement>("[data-open]")?.dataset.open;
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

  /** Follow Claude: open what it touched last, or where the simulation stopped. */
  autoFollow(): void {
    if (!this.follow) return;
    const loc = model.state?.location;
    const stopKey = loc && !loc.harness && loc.obj ? `${loc.obj}:${loc.part}:${loc.line}` : undefined;
    if (stopKey && stopKey !== this.lastStopKey) {
      this.lastStopKey = stopKey;
      this.open(loc!.obj!, false);
      return;
    }
    if (!stopKey) this.lastStopKey = undefined;
    const f = model.ws?.focus;
    if (f && f.at !== this.lastFocusAt && f.action !== "delete") {
      this.lastFocusAt = f.at;
      if (model.ws?.tree?.some((n) => n.path.toLowerCase() === f.path.toLowerCase())) this.open(f.path, false);
    }
  }

  // ------------------------------------------------------------ render

  render(): void {
    this.renderTop();
    this.renderTree();
    this.renderTabs();
    this.renderEditor();
    this.renderInspector();
    this.renderBottom();
  }

  renderTop(): void {
    const s = model.state;
    const label: Record<string, string> = { running: "Running", paused: "Paused", stopped: "Stopped", no_mirror: "Not simulated", no_project: "No project" };
    const shown = s?.activity && (s.status === "paused" || s.status === "running") ? "running" : (s?.status ?? "stopped");
    $("w-status").className = `pill ${shown === "running" ? "running" : shown === "paused" ? "paused" : ""}`;
    $("w-statusText").textContent = s ? (label[shown] ?? shown) : "Connecting";
    $("w-meta").textContent = s && (s.status === "running" || s.status === "paused") ? `scan ${s.scan} · ${s.simTime.toFixed(2)} s · ${s.timeScale}x` : (model.ws?.project?.split(/[\\/]/).pop() ?? "");
    const f = model.ws?.focus;
    const where = s?.location && !s.location.harness && s.location.obj ? `Stopped${s.location.breakpoint ? ` at breakpoint #${s.location.breakpoint}` : ""}: ${s.location.obj} line ${s.location.line}` : "";
    const touched = f && Date.now() - Date.parse(f.at) < 60_000 ? `Claude ${f.action === "read" ? "is reading" : f.action === "write" ? "edited" : f.action === "create" ? "created" : f.action === "delete" ? "deleted" : f.action === "revert" ? "reverted" : "renamed"} ${f.path}` : "";
    $("w-activity").textContent = s?.activity ?? (where || touched);
    $("w-follow").setAttribute("aria-pressed", String(this.follow));
    const badge = $("w-badge");
    const warnings = s?.warnings ?? [];
    badge.textContent = `Simulated in truST${s?.trust ? ` ${s.trust}` : ""}${warnings.length ? ` · ${warnings.length} warning${warnings.length > 1 ? "s" : ""}` : ""}`;
    badge.className = `badge${warnings.length ? " warn" : ""}`;
    badge.title = warnings.join("\n");
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
    const s = model.state;
    const bps = new Set((s?.breakpoints ?? []).map((b) => b.obj.toLowerCase()));
    const here = s?.location && !s.location.harness ? s.location.obj?.toLowerCase() : undefined;
    const f = model.ws?.focus;
    const claude = f && Date.now() - Date.parse(f.at) < 30_000 ? f.path.toLowerCase() : undefined;
    const failing = new Set((s?.tests?.failing ?? []).map((x) => x.toLowerCase()));
    const testsRan = !!s?.tests;
    const hasKids = new Set<string>();
    tree.forEach((n, i) => {
      if ((tree[i + 1]?.depth ?? -1) > n.depth) hasKids.add(n.path.toLowerCase());
    });
    const rows = this.visibleNodes().map((n) => {
      const k = n.path.toLowerCase();
      const kind = n.test ? "test" : n.kind === "pou" ? (n.sub ?? "pou") : n.kind;
      const label = n.test ? "T" : (KIND_LABEL[kind] ?? KIND_LABEL[n.kind] ?? "·");
      const kids = hasKids.has(k);
      const open = !this.collapsed.has(k) || !!this.filter;
      const marks: string[] = [];
      if (claude === k) marks.push(`<span class="mk claude" title="Claude worked here">✦</span>`);
      if (here === k) marks.push(`<span class="mk here" title="Simulation stopped here">▶</span>`);
      if (bps.has(k)) marks.push(`<span class="mk bp" title="Breakpoint">●</span>`);
      if (n.test && testsRan) marks.push(failing.has(k) ? `<span class="mk fail" title="Test failed">✗</span>` : `<span class="mk A" title="Test passed">✓</span>`);
      if (n.errors) marks.push(`<span class="mk err" title="${n.errors} compile error(s)">${n.errors}</span>`);
      if (n.change) marks.push(`<span class="mk ${n.change}" title="${n.change === "A" ? "Added" : "Modified"} since the session started">${n.change}</span>`);
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
    const cur = el.querySelector<HTMLElement>(".ln.cur");
    if (cur && (!keepScroll || cur.dataset.key !== el.dataset.cur)) {
      el.scrollTop = Math.max(0, cur.offsetTop - el.clientHeight / 3);
      el.dataset.cur = cur.dataset.key ?? "";
    } else if (keepScroll) el.scrollTop = top;
  }

  private editorBody(path: string, d: ObjData): string {
    const o = d.object;
    if (!o) return `<div class="empty">${esc(path)} was removed${d.base ? " since the session started" : ""}.</div>`;
    if (o.st === false) return `<div class="empty">${esc(path)} has a graphical body (SFC, CFC, LD or FBD), which isn't shown as text.</div>`;
    const s = model.state;
    const loc = s?.location && !s.location.harness ? s.location : undefined;
    const bpLines = new Set((s?.breakpoints ?? []).filter((b) => b.obj.toLowerCase() === path.toLowerCase()).map((b) => b.line));
    const locals = model.locals?.paused ? model.locals.locals.filter((l) => !l.expandable) : [];
    const localNames = new Map(locals.map((l) => [l.name.toLowerCase(), l.value] as const));
    const stopHere = loc?.obj?.toLowerCase() === path.toLowerCase();
    const out: string[] = [];
    for (const part of ["decl", "impl"] as const) {
      const text = part === "decl" ? o.declaration : o.implementation;
      if (text === null || (part === "impl" && !text.trim() && o.kind !== "pou" && o.kind !== "method" && o.kind !== "action" && o.kind !== "accessor")) continue;
      out.push(`<div class="part">${part === "decl" ? "Declaration" : "Implementation"}</div>`);
      const lines = (text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      const hs = { inComment: false };
      if (this.diff && d.base) {
        const base = (part === "decl" ? d.base.declaration : d.base.implementation) ?? "";
        const ops = lineDiff(base.replace(/\r\n?/g, "\n").replace(/\n+$/, ""), lines.join("\n"));
        let n = 0;
        for (const op of ops) {
          if (op.op !== "-") n++;
          const cls = op.op === "+" ? " add" : op.op === "-" ? " del" : "";
          out.push(`<div class="ln${cls}"><span class="bp">${op.op === " " ? "" : op.op}</span><span class="no">${op.op === "-" ? "" : n}</span><span class="tx">${highlight(op.text, hs) || " "}</span></div>`);
        }
        if (ops.every((x) => x.op === " ")) out.push(`<div class="empty">No changes since the session started.</div>`);
        continue;
      }
      lines.forEach((t, i) => {
        const no = i + 1;
        const cur = stopHere && loc!.part === part && loc!.line === no;
        const sel = this.selected?.path === path && this.selected.part === part && this.selected.line === no;
        const bp = part === "impl" && bpLines.has(no);
        let vals = "";
        if (stopHere && part === "impl" && localNames.size) {
          const seen = new Set<string>();
          for (const m of t.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
            const k = m[0].toLowerCase();
            if (seen.has(k) || !localNames.has(k) || seen.size >= 3) continue;
            seen.add(k);
            vals += `<span class="val">${esc(m[0])} = ${esc(localNames.get(k)!)}</span>`;
          }
        }
        out.push(
          `<div class="ln${cur ? " cur" : ""}${sel ? " sel" : ""}" data-part="${part}" data-line="${no}" data-key="${part}:${no}"><span class="bp">${bp ? "●" : ""}</span><span class="no">${no}</span><span class="tx">${highlight(t, hs) || " "}${vals}</span></div>`,
        );
      });
    }
    if (this.diff && !d.base) out.unshift(`<div class="empty">${esc(path)} was added after the session started.</div>`);
    return out.join("");
  }

  renderInspector(): void {
    const el = $("w-insp");
    const s = model.state;
    if (this.insp === "watch") {
      if (!this.watch.length && s?.signals.length) this.watch = s.signals.filter((x) => x.role === "plant_out" || x.role === "plant_in").map((x) => x.name);
      const rows = this.watch.map((n) => {
        const v = model.values[n];
        return `<tr><td>${esc(n)}</td><td class="v">${esc(v?.error ? v.error : show(v))}</td><td><button class="pinbtn" data-unwatch="${esc(n)}" title="Remove">×</button></td></tr>`;
      });
      el.innerHTML = `<form class="add-watch"><input class="filter" name="v" placeholder="Add variable, e.g. PRG_Tank.nTrips" aria-label="Variable to watch"><button class="btn" type="submit">Add</button></form>${
        rows.length ? `<table>${rows.join("")}</table>` : `<div class="empty">Add variables to watch.</div>`
      }${s?.status === "running" || s?.status === "paused" ? "" : `<div class="empty">Values appear while the simulation runs.</div>`}`;
    } else if (this.insp === "locals") {
      const l = model.locals;
      if (!l?.paused || !l.locals.length) {
        el.innerHTML = `<div class="empty">Locals appear when the simulation stops in your code (a breakpoint or a step).</div>`;
        return;
      }
      el.innerHTML = `${l.stack.length ? `<div class="empty">Call stack: ${l.stack.map((f) => (f.obj ? `<a href="#" data-open="${esc(f.obj)}">${esc(f.obj)} line ${f.line}</a>` : esc(f.name))).join(" ← ")}</div>` : ""}<table>${l.locals
        .map((v) => `<tr><td>${esc(v.name)}<div class="r">${esc(v.type)}</div></td><td class="v">${v.expandable ? `<span class="muted">${esc(v.type)}</span>` : esc(v.value)}</td></tr>`)
        .join("")}</table>`;
    } else if (this.insp === "bps") {
      const bps = s?.breakpoints ?? [];
      el.innerHTML = bps.length
        ? `<table>${bps.map((b) => `<tr><td><a href="#" data-open="${esc(b.obj)}">#${b.id} ${esc(b.obj)}</a><div class="r">line ${b.line}${b.condition ? ` · if ${esc(b.condition)}` : ""}</div></td></tr>`).join("")}</table>`
        : `<div class="empty">No breakpoints. Claude sets them with set_breakpoint.</div>`;
    } else {
      const sig = s?.signals ?? [];
      const role: Record<string, string> = { plant_out: "plant → PLC", plant_in: "PLC → plant", feedback: "feedback", command: "command", experiment: "experiment" };
      el.innerHTML = sig.length
        ? `<table>${sig
            .map(
              (x) =>
                `<tr title="${esc(x.value ?? "")}"><td>${esc(x.name)}${x.forced ? '<span class="forced">F</span>' : ""}<div class="r">${role[x.role] ?? x.role}${x.address ? ` · ${esc(x.address)}` : ""}</div></td><td class="v">${esc(show(x))}</td><td><button class="pinbtn" data-watch="${esc(x.name)}" title="Watch">＋</button></td></tr>`,
            )
            .join("")}</table>`
        : `<div class="empty">No plant signals.</div>`;
    }
  }

  renderBottom(): void {
    const el = $("w-bottom");
    const info = $("w-bottom-info");
    const s = model.state;
    info.textContent = "";
    if (this.bottom === "trend") {
      if (!el.querySelector("canvas")) el.innerHTML = `<canvas id="w-trend"></canvas>`;
      if (s) info.textContent = drawTrend(el.querySelector("canvas")!, s, model.trend);
    } else if (this.bottom === "plant") {
      if (!el.querySelector(".pid")) el.innerHTML = `<div class="pid"></div>`;
      if (s) renderPid(el.querySelector<HTMLElement>(".pid")!, s);
    } else if (this.bottom === "tests") {
      const t = s?.tests;
      const testNodes = (model.ws?.tree ?? []).filter((n) => n.test);
      if (!testNodes.length) {
        el.innerHTML = `<div class="empty">No tests. A test is a PROGRAM marked {attribute 'test'}; Claude runs them with run_tests.</div>`;
        return;
      }
      const failing = new Set((t?.failing ?? []).map((x) => x.toLowerCase()));
      info.textContent = t ? `${t.passed} passed, ${t.failed} failed · ${ago(t.at)}` : "not run yet";
      el.innerHTML = `<div class="list">${testNodes
        .map((n) => `<div class="row"><span class="${!t ? "muted" : failing.has(n.path.toLowerCase()) ? "err" : "mk A"}">${!t ? "○" : failing.has(n.path.toLowerCase()) ? "✗" : "✓"}</span> <a href="#" data-open="${esc(n.path)}">${esc(n.path)}</a></div>`)
        .join("")}</div>`;
    } else if (this.bottom === "problems") {
      const c = model.ws?.compile;
      const rows: string[] = [];
      if (c) {
        info.textContent = `compile ${ago(c.at)}: ${c.errors} error(s), ${c.warnings} warning(s)`;
        for (const m of c.messages) {
          const obj = m.object?.replace(/^\/+/, "");
          rows.push(`<div class="row"><span class="${m.severity === "error" ? "err" : "wrn"}">${m.severity === "error" ? "Error" : "Warning"}${m.code ? ` ${esc(m.code)}` : ""}</span> ${obj ? `<a href="#" data-open="${esc(obj)}">${esc(obj)}</a>${m.position ? ` <span class="muted">${esc(m.position)}</span>` : ""}: ` : ""}${esc(m.text)}</div>`);
        }
      }
      for (const w of s?.warnings ?? []) rows.push(`<div class="row"><span class="wrn">Simulation</span> ${esc(w)}</div>`);
      el.innerHTML = rows.length ? `<div class="list">${rows.join("")}</div>` : `<div class="empty">${c ? "No problems in the last compile." : "No compile yet in this session."}</div>`;
    } else {
      el.innerHTML = model.events.length
        ? `<div class="list">${[...model.events]
            .reverse()
            .slice(0, 80)
            .map((e) => `<div class="row"><span class="t">${new Date(e.at).toLocaleTimeString()}</span>${esc(e.text)}</div>`)
            .join("")}</div>`
        : `<div class="empty">No activity yet.</div>`;
    }
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
    const ln = (e.target as HTMLElement).closest<HTMLElement>(".ln[data-line]");
    if (!ln || !this.active) return;
    const part = ln.dataset.part as "decl" | "impl";
    const line = Number(ln.dataset.line);
    this.selected = { path: this.active, part, line };
    const text = ln.querySelector(".tx")?.textContent ?? "";
    this.hooks.context(`In the CODESYS workspace the user selected ${this.active} ${part === "decl" ? "declaration" : "implementation"} line ${line}: ${text.trim()}`);
    this.renderEditor(true);
  }

  private onInspectorClick(e: Event): void {
    const t = e.target as HTMLElement;
    const open = t.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (open) {
      e.preventDefault();
      return this.open(open, true);
    }
    const un = t.closest<HTMLElement>("[data-unwatch]")?.dataset.unwatch;
    if (un) {
      this.watch = this.watch.filter((x) => x !== un);
      persist("ws-watch", this.watch);
      return this.renderInspector();
    }
    const add = t.closest<HTMLElement>("[data-watch]")?.dataset.watch;
    if (add && !this.watch.includes(add)) {
      this.watch = [...this.watch, add];
      persist("ws-watch", this.watch);
      this.renderInspector();
    }
  }

  private onWatchAdd(e: Event): void {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).querySelector("input")!;
    const v = input.value.trim();
    if (v && !this.watch.includes(v)) {
      this.watch = [...this.watch, v];
      persist("ws-watch", this.watch);
    }
    this.renderInspector();
  }
}
