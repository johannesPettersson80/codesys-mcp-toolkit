/** The compact card shown inline in the chat: status, a view tab row, and the current view. */
import { model } from "./model.js";
import { $, ago, esc } from "./util.js";
import { codePath, codeView, problemsList, reviewView, statusPill, viewTabs, type ViewName } from "./views.js";

let shownView: ViewName | undefined;
let shownHtml = "";
/** The added lines last scrolled to, so a re-render doesn't jump around. */
let writtenKey = "";

export function renderCard(view: ViewName, follow: boolean): void {
  const s = model.state;
  const ws = model.ws;
  const pill = statusPill();
  $("c-status").className = pill.cls;
  $("c-statusText").textContent = pill.text;
  $("c-meta").textContent = ws?.project?.split(/[\\/]/).pop() ?? "";
  $("c-meta").title = ws?.versions ?? "";
  $("c-activity").textContent = s?.held ? "You're driving: Claude is paused." : "";
  $("c-hold").setAttribute("aria-pressed", String(!!s?.held));
  $("c-hold").textContent = s?.held ? "Resume Claude" : "Pause Claude";
  $("c-follow").setAttribute("aria-pressed", String(follow));

  const facts: string[] = [];
  const f = ws?.focus;
  if (f) facts.push(`<span class="fact"><span class="muted">Working on</span><b>${esc(f.path)}</b><span class="muted">${f.action} · ${ago(f.at)}</span></span>`);
  if (ws?.changeCount !== undefined && ws.tree) facts.push(`<span class="fact"><span class="muted">Changes</span><b>${ws.changeCount}</b><span class="muted">to review</span></span>`);
  $("c-facts").innerHTML = facts.join("");

  $("c-views").innerHTML = viewTabs(view, follow);
  const el = $("c-view");
  let html = "";
  if (view === "code") {
    const path = codePath();
    html = codeView(path, path ? model.objects.get(path.toLowerCase()) : undefined) + problemsList(path);
  } else html = reviewView(true);
  // Don't rebuild (and lose the scroll position) when nothing changed.
  if (shownView !== view || html !== shownHtml) {
    const before = el.querySelector<HTMLElement>(".code.live")?.scrollTop ?? 0;
    el.innerHTML = html;
    shownHtml = html;
    const live = el.querySelector<HTMLElement>(".code.live");
    if (live) {
      // Follow the writing: jump to the newest added line when Claude wrote
      // something new; otherwise keep where the user scrolled to.
      const added = live.querySelectorAll<HTMLElement>(".ln.add");
      const key = `${codePath()}|${added.length}|${added[added.length - 1]?.textContent ?? ""}`;
      if (added.length && (key !== writtenKey || shownView !== view)) live.scrollTop = Math.max(0, added[added.length - 1]!.offsetTop - live.clientHeight / 2);
      else live.scrollTop = before;
      writtenKey = key;
    }
  }
  shownView = view;
}
