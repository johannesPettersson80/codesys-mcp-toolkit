/**
 * The HMI page bundle (dist/panel/hmi.js). Two modes:
 * - static (screenshots): window.HMI_STATIC holds a screen and values;
 * - live (the browser page /hmi): reads screens and values from the MCP
 *   server's local viewer endpoint and writes button presses back.
 */
import { CANVAS, HMI_CSS, renderScreen } from "../../src/hmi/render.js";
import type { Screen } from "../../src/hmi/spec.js";
import { mountLive, seedHistory, type LiveScreen, type Values } from "./hmi-live.js";

declare global {
  interface Window {
    HMI_STATIC?: { screen: Screen; values: Values; sim?: { state?: string } };
  }
}

const PAGE_CSS = `
html,body{margin:0;height:100%;background:#05080f;overflow:hidden}
#stage{position:absolute;left:50%;top:50%;transform-origin:0 0}
#tabs{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:6px;padding:5px;border-radius:999px;background:rgba(15,23,42,.75);border:1px solid rgba(148,163,184,.18);backdrop-filter:blur(10px);font:600 13px "Segoe UI",system-ui,sans-serif;z-index:5}
#tabs:empty{display:none}
#tabs button{border:0;border-radius:999px;padding:7px 16px;background:transparent;color:#94a3b8;font:inherit;cursor:pointer}
#tabs button.cur{background:#38bdf8;color:#04121f}
#banner{position:fixed;left:50%;top:14px;transform:translateX(-50%);padding:9px 16px;border-radius:10px;background:#7f1d1d;color:#fff;font:500 13px "Segoe UI",system-ui,sans-serif;z-index:6}
`;

function css(text: string) {
  const s = document.createElement("style");
  s.textContent = text;
  document.head.appendChild(s);
}

function mount(stage: HTMLElement, screen: Screen, write: (v: string, value: string) => void): LiveScreen {
  const r = renderScreen(screen);
  stage.innerHTML = r.html;
  return mountLive(stage.firstElementChild as HTMLElement, r.bindings, write);
}

function fit(stage: HTMLElement, fixed: boolean) {
  if (fixed) {
    stage.style.left = "0";
    stage.style.top = "0";
    return;
  }
  const s = Math.min(innerWidth / CANVAS.w, innerHeight / CANVAS.h) * 0.98;
  stage.style.left = "50%";
  stage.style.top = "50%";
  stage.style.transform = `translate(-50%,-50%) scale(${s})`;
  stage.style.transformOrigin = "center";
}

async function live(stage: HTMLElement) {
  const q = new URLSearchParams(location.search);
  const token = q.get("t") ?? "";
  let name = q.get("s") ?? undefined;
  const tabs = document.getElementById("tabs")!;
  const banner = document.getElementById("banner")!;
  const call = async (tool: string, args: Record<string, unknown>) => {
    const r = await fetch("/call", { method: "POST", headers: { "content-type": "application/json", "x-viewer-token": token }, body: JSON.stringify({ name: tool, arguments: args }) });
    if (!r.ok) throw new Error(r.status === 403 ? "This link is out of date: ask Claude to open the HMI again." : await r.text());
    const j = (await r.json()) as { content?: { text?: string }[]; isError?: boolean };
    const text = j.content?.[0]?.text ?? "{}";
    if (j.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const show = (msg?: string) => {
    banner.hidden = !msg;
    banner.textContent = msg ?? "";
  };
  let screenKey = "";
  let screen: LiveScreen | undefined;
  const write = (variable: string, value: string) => void call("ui_hmi_write", { variable, value }).then((r) => show(r.ok === false ? String(r.message) : undefined), (e: Error) => show(e.message));
  for (;;) {
    try {
      const r = (await call("get_hmi", { screen: name })) as { screens: { name: string; title: string }[]; screen?: Screen; values?: Values; sim?: { state?: string } };
      show(r.screen ? undefined : "No HMI screens in this project yet: ask Claude to make one.");
      tabs.innerHTML = r.screens.length > 1 ? r.screens.map((s) => `<button data-s="${s.name}" class="${s.name === r.screen?.name ? "cur" : ""}">${s.title.replace(/[<&]/g, "")}</button>`).join("") : "";
      if (r.screen) {
        const key = JSON.stringify(r.screen);
        if (key !== screenKey) {
          screen?.destroy();
          screen = mount(stage, r.screen, write);
          screenKey = key;
          document.title = r.screen.title;
          fit(stage, false);
        }
        screen!.update(r.values ?? {}, r.sim);
      }
    } catch (e) {
      show((e as Error).message.includes("fetch") ? "The CODESYS MCP server isn't answering; this page reconnects by itself." : (e as Error).message);
    }
    await new Promise((res) => setTimeout(res, 300));
    tabs.onclick = (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b) {
        name = b.dataset.s;
        history.replaceState(null, "", `?t=${encodeURIComponent(token)}&s=${encodeURIComponent(name ?? "")}`);
      }
    };
  }
}

css(HMI_CSS + PAGE_CSS);
const stage = document.getElementById("stage")!;
const data = window.HMI_STATIC;
if (data) {
  fit(stage, true);
  const s = mount(stage, data.screen, () => undefined);
  seedHistory(s, data.values);
  s.update(data.values, data.sim);
  document.body.dataset.ready = "1";
} else {
  addEventListener("resize", () => fit(stage, false));
  void live(stage);
}
