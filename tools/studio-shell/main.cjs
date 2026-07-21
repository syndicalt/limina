// Limina studio desktop shell: the studio web app in an Electron window with
// PINNED GPU behavior. Two real incidents motivate it: a dual-GPU laptop where
// Chrome picked the weak integrated GPU at random, and a host whose WebGPU is
// broken where browser secure-context rules removed every fallback. Inside
// this shell the GPU choice and WebGPU availability are configuration, not
// browser roulette.
//
// GPU env (Linux, set BEFORE launching — see package.json start script):
//   NVIDIA PRIME offload: __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia
//   Mesa/nouveau dGPU:    DRI_PRIME=1
//
// Config:
//   LIMINA_STUDIO_URL — the studio origin (default http://localhost:5173/,
//     e.g. an SSH tunnel endpoint or a LAN stack).
//   LIMINA_STUDIO_INSECURE_ORIGIN=1 — mark a plain-http LAN origin as a secure
//     context (WebGPU + SAB/cross-origin isolation APIs need it on non-
//     localhost origins; harmless for loopback).

const { app, BrowserWindow } = require("electron");

const rawUrl = process.env.LIMINA_STUDIO_URL ?? "http://localhost:5173/";
let studioUrl;
try {
  studioUrl = new URL(rawUrl);
} catch {
  console.error(`studio-shell: LIMINA_STUDIO_URL is not a URL: ${rawUrl}`);
  process.exit(1);
}
if (studioUrl.protocol !== "http:" && studioUrl.protocol !== "https:") {
  console.error(`studio-shell: LIMINA_STUDIO_URL must be http(s): ${rawUrl}`);
  process.exit(1);
}

// These switches must be appended before app ready.
// Prefer the high-performance GPU on dual-GPU systems (Optimus/PRIME laptops).
app.commandLine.appendSwitch("force_high_performance_gpu");
// WebGPU without browser secure-context gating — this is a local app talking
// to a local/LAN stack, so the web rule that broke the GB10 host does not apply.
app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.env.LIMINA_STUDIO_INSECURE_ORIGIN === "1" && studioUrl.protocol === "http:") {
  // LAN stack over plain http: SAB (cross-origin isolation) + WebGPU both key
  // off secure-context. The stack is the user's own machine; the LAN segment
  // is the trust boundary, exactly like the SSH tunnel it replaces.
  app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", studioUrl.origin);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    title: "limina studio",
    autoHideMenuBar: true,
    webPreferences: {
      // The shell is a frame, not a runtime: no node, no preload bridge. The
      // studio app needs nothing beyond standard web APIs.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  // The editor's own links stay in-shell; anything else goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === studioUrl.origin) return { action: "allow" };
    } catch { /* fall through to deny */ }
    return { action: "deny" };
  });
  void win.loadURL(studioUrl.href);
  // Diagnostics: LIMINA_STUDIO_DEVTOOLS=1 opens Chromium devtools (check the
  // GL renderer via chrome://gpu or a webgl canvas probe on the client).
  if (process.env.LIMINA_STUDIO_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "right" });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
