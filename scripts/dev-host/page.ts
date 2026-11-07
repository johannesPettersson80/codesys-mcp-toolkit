// Browser side of the dev host: embeds the panel with the ext-apps AppBridge,
// runs demo scenarios and switches the host theme.
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

type Theme = "light" | "dark";

const iframe = document.getElementById("panel") as HTMLIFrameElement;
const statusEl = document.getElementById("status")!;
const statusText = document.getElementById("statusText")!;
const steps = [...document.querySelectorAll<HTMLButtonElement>("button[data-s]")];
const themeButtons = [...document.querySelectorAll<HTMLButtonElement>("button[data-theme]")];

const LABEL: Record<string, string> = { start: "Start", experiment: "Experiment", tuned: "Tuned run", breakpoint: "Interlock breakpoint", release: "Release" };

function storedTheme(): Theme {
  if (new URLSearchParams(location.search).has("dark")) return "dark";
  try {
    const t = localStorage.getItem("devhost-theme");
    if (t === "light" || t === "dark") return t;
  } catch {
    /* storage unavailable */
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let theme: Theme = storedTheme();
let bridge: AppBridge | undefined;

async function call(name: string, args: Record<string, unknown>) {
  const r = await fetch("/call", { method: "POST", body: JSON.stringify({ name, arguments: args }) });
  return r.json();
}

function applyTheme(t: Theme) {
  theme = t;
  document.documentElement.dataset.theme = t;
  for (const b of themeButtons) b.setAttribute("aria-pressed", String(b.dataset.theme === t));
  try {
    localStorage.setItem("devhost-theme", t);
  } catch {
    /* storage unavailable */
  }
}

async function mount() {
  await bridge?.close().catch(() => undefined);
  const html = await (await fetch("/panel.html")).text();
  const embed = iframe.closest(".embed")!;
  embed.classList.remove("fullscreen");
  bridge = new AppBridge(null, { name: "dev-host", version: "1" }, { serverTools: {}, updateModelContext: {} }, { hostContext: { theme, displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
  bridge.oncalltool = async (params) => call(params.name, (params.arguments ?? {}) as Record<string, unknown>);
  bridge.onsizechange = ({ height }) => {
    if (height && !embed.classList.contains("fullscreen")) iframe.style.height = `${Math.ceil(height)}px`;
  };
  bridge.onrequestdisplaymode = async ({ mode }) => {
    const full = mode === "fullscreen";
    embed.classList.toggle("fullscreen", full);
    await bridge!.sendHostContextChange({ displayMode: full ? "fullscreen" : "inline" });
    return { mode: full ? "fullscreen" : "inline" };
  };
  bridge.onupdatemodelcontext = async (p) => {
    const text = (p.content ?? []).map((c) => ("text" in c ? c.text : "")).join(" ");
    document.getElementById("ctx")!.textContent = `Model context: ${text}`;
    return {};
  };
  bridge.oninitialized = async () => {
    const r = await call("open_sim_panel", {});
    await bridge!.sendToolInput({ arguments: {} });
    await bridge!.sendToolResult(r);
  };
  // Listen before the panel loads, so its first message isn't missed.
  const connected = bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = html;
  await connected;
}

async function refreshStatus() {
  try {
    const s = (await (await fetch("/status")).json()) as { running?: string; queued: string[]; done: string[]; error?: string };
    for (const b of steps) {
      const id = b.dataset.s!;
      b.classList.toggle("running", s.running === id);
      b.classList.toggle("queued", s.queued.includes(id));
      b.classList.toggle("done", s.done.includes(id) && s.running !== id);
    }
    statusEl.className = `status${s.running ? " busy" : s.error ? " error" : ""}`;
    statusText.textContent = s.error
      ? `Failed: ${s.error}`
      : s.running
        ? `${LABEL[s.running] ?? s.running}${s.queued.length ? ` · ${s.queued.length} queued` : ""}`
        : "Idle";
  } catch {
    statusText.textContent = "Dev host not reachable";
  }
  setTimeout(refreshStatus, 600);
}

for (const b of steps) {
  b.onclick = () => void fetch(`/scenario/${b.dataset.s}`, { method: "POST" });
}
for (const b of themeButtons) {
  b.onclick = () => {
    applyTheme(b.dataset.theme as Theme);
    void bridge?.sendHostContextChange({ theme });
  };
}
document.getElementById("reopen")!.onclick = () => void mount();

applyTheme(theme);
void mount();
void refreshStatus();
