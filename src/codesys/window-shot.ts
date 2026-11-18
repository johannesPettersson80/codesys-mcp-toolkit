/**
 * A picture of the CODESYS window (--show-window), so Claude can see what the
 * user sees there: a visualization running in the simulation, an editor.
 *
 * Windows' PrintWindow with PW_RENDERFULLCONTENT draws the window into a
 * bitmap even when other windows cover it. The capturing PowerShell is left
 * DPI-unaware, like CODESYS: the window's size and its drawing then agree, and
 * the picture holds the whole window at its own scale.
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = (pid: number, png: string) => `
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class CmcpShot {
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  public static string Shot(IntPtr h, string path) {
    if (IsIconic(h)) { ShowWindow(h, 4); System.Threading.Thread.Sleep(600); }
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return "empty";
    using (var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb))
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc();
      bool ok = PrintWindow(h, dc, 2);
      g.ReleaseHdc(dc);
      if (!ok) return "failed";
      bmp.Save(path, ImageFormat.Png);
      return w + "x" + hh;
    }
  }
}
"@
$p = Get-Process -Id ${pid}
if ($p.MainWindowHandle -eq [IntPtr]::Zero) { 'nowindow'; exit 0 }
[CmcpShot]::Shot($p.MainWindowHandle, '${png.replace(/'/g, "''")}')
`;

/** The CODESYS window of process pid as a PNG, with its size ("1160x1152"). */
export async function codesysWindowShot(pid: number): Promise<{ png: Buffer; size: string }> {
  if (process.platform !== "win32") throw new Error("A picture of the CODESYS window needs Windows.");
  const png = join(tmpdir(), `cmcp-window-${pid}-${Date.now()}.png`);
  const encoded = Buffer.from(SCRIPT(pid, png), "utf16le").toString("base64");
  const out = await new Promise<string>((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split("\n")[0])) : resolve(stdout.trim()),
    ),
  );
  if (out === "nowindow") throw new Error("CODESYS has no window open (start the toolkit with --show-window).");
  if (!/^\d+x\d+$/.test(out)) throw new Error(`Couldn't capture the CODESYS window (${out || "no output"}).`);
  try {
    return { png: await readFile(png), size: out };
  } finally {
    await rm(png, { force: true });
  }
}
