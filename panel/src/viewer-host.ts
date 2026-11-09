/**
 * The browser viewer's host page: it embeds the panel with the ext-apps
 * AppBridge, the way Claude Desktop would, and forwards the panel's tool calls
 * to the MCP server's local viewer endpoint. Used where the chat can't show
 * MCP Apps inline.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const token = new URLSearchParams(location.search).get("t") ?? "";
const iframe = document.getElementById("panel") as HTMLIFrameElement;
const banner = document.getElementById("banner")!;
const dark = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (dark.matches ? "dark" : "light");

let bridge: AppBridge | undefined;
let down = false;

async function call(name: string, args: Record<string, unknown>) {
  try {
    const r = await fetch("/call", { method: "POST", headers: { "content-type": "application/json", "x-viewer-token": token }, body: JSON.stringify({ name, arguments: args }) });
    if (!r.ok) throw new Error(await r.text());
    if (down) {
      down = false;
      banner.hidden = true;
    }
    return await r.json();
  } catch (e) {
    down = true;
    banner.hidden = false;
    banner.textContent = `The CODESYS MCP server isn't answering (${(e as Error).message}). It runs while Claude Desktop is open; this page reconnects by itself.`;
    return { content: [{ type: "text", text: "not connected" }], isError: true };
  }
}

async function mount() {
  await bridge?.close().catch(() => undefined);
  const r = await fetch(`/panel.html?t=${encodeURIComponent(token)}`);
  if (!r.ok) {
    banner.hidden = false;
    banner.textContent = r.status === 403 ? "This link is out of date: ask Claude to open the workspace again." : `Could not load the panel (${r.status}).`;
    return;
  }
  const html = await r.text();
  let mode: "fullscreen" | "inline" = "fullscreen";
  bridge = new AppBridge(null, { name: "codesys-viewer", version: "1" }, { serverTools: {}, updateModelContext: {} }, { hostContext: { theme: theme(), displayMode: mode, availableDisplayModes: ["fullscreen", "inline"] } });
  bridge.oncalltool = async (p) => call(p.name, (p.arguments ?? {}) as Record<string, unknown>);
  bridge.onrequestdisplaymode = async (p) => {
    mode = p.mode === "inline" ? "inline" : "fullscreen";
    document.body.classList.toggle("inline", mode === "inline");
    await bridge!.sendHostContextChange({ displayMode: mode });
    return { mode };
  };
  bridge.onsizechange = ({ height }) => {
    if (mode === "inline" && height) iframe.style.height = `${Math.ceil(height)}px`;
  };
  // There is no chat here: what the user selects stays in the page.
  bridge.onupdatemodelcontext = async () => ({});
  // No panelId: the viewer is never superseded by a panel Claude opens in the chat.
  bridge.oninitialized = async () => {
    await bridge!.sendToolInput({ arguments: {} });
    await bridge!.sendToolResult({ content: [{ type: "text", text: "Browser viewer" }] });
  };
  const connected = bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = html;
  await connected;
}

dark.addEventListener("change", () => void bridge?.sendHostContextChange({ theme: theme() }));
void mount();
