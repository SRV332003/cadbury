// Mochi desktop pet: transparent, frameless, always-on-top window that hosts the cat UI.
const { app, BrowserWindow, ipcMain, Menu, Tray, globalShortcut, screen, session, Notification, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");

// GNOME/Wayland ignores always-on-top for native Wayland windows → run under XWayland.
app.commandLine.appendSwitch("ozone-platform", "x11");
app.commandLine.appendSwitch("enable-transparent-visuals");
// Hide Chromium's harmless GTK/X11 startup noise; set MOCHI_DEBUG=1 to see it again.
if (!process.env.MOCHI_DEBUG) app.commandLine.appendSwitch("log-level", "3");
// Software rendering paints nothing into transparent XWayland windows, so keep the GPU on.
if (process.env.MOCHI_SOFTWARE) app.disableHardwareAcceleration();
const OPAQUE = !!process.env.MOCHI_OPAQUE; // fallback if your compositor can't do transparency

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.MOCHI_PORT || 8787);
const OC_PORT = Number(process.env.OPENCODE_PORT || 4096);
const URL = `http://127.0.0.1:${PORT}/`;
const BASE_W = 380, BASE_H_SMALL = 340, BASE_H_BIG = 700;

// ---- pet size: right-click → Size, remembered in ~/.config/mochi/prefs.json; MOCHI_SCALE in .env sets the default ----
const fs = require("node:fs");
const PREFS = path.join(process.env.XDG_CONFIG_HOME || path.join(require("node:os").homedir(), ".config"), "mochi", "prefs.json");
function loadPrefs() { try { return JSON.parse(fs.readFileSync(PREFS, "utf8")); } catch { return {}; } }
function savePrefs(p) { try { fs.mkdirSync(path.dirname(PREFS), { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify(p, null, 2)); } catch {} }
const clampScale = (s) => Math.min(3, Math.max(0.3, Number(s) || 1));
let scale = clampScale(loadPrefs().scale ?? process.env.MOCHI_SCALE ?? 1);
let panelOpen = false;
const dims = () => ({ w: Math.round(BASE_W * scale), h: Math.round((panelOpen ? BASE_H_BIG : BASE_H_SMALL) * scale) });
const HOTKEY = process.env.MOCHI_HOTKEY || "Control+Alt+Space";

let win, tray, bridge;
if (!app.requestSingleInstanceLock()) app.exit(0);

function bridgeUp() {
  return new Promise((res) => {
    http.get(URL + "api/health", (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false));
  });
}

async function ensureBridge() {
  if (await bridgeUp()) return;
  bridge = spawn(process.env.BUN || "bun", ["bridge/index.ts"], { cwd: ROOT, stdio: "inherit", env: process.env });
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await bridgeUp()) return;
  }
  throw new Error("bridge failed to start");
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: dims().w, height: dims().h,
    x: workArea.x + workArea.width - dims().w - 24,
    y: workArea.y + workArea.height - dims().h - 12,
    transparent: !OPAQUE, frame: false, resizable: false, hasShadow: false, show: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: OPAQUE ? "#2b1d14" : "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on("did-finish-load", () => win.webContents.setZoomFactor(scale));
  win.once("ready-to-show", () => {
    win.show();
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true);
    console.log(`[mochi] cat window shown at ${JSON.stringify(win.getBounds())} on display ${JSON.stringify(workArea)}`);
  });
  // Diagnostics: forward page console errors to the log, and snapshot what the window rendered.
  win.webContents.on("console-message", (e) => {
    if (e.level === "error" || e.level === "warning") console.log(`[cat page] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once("did-finish-load", () => setTimeout(async () => {
    try {
      const dir = path.join(process.env.XDG_CACHE_HOME || path.join(require("node:os").homedir(), ".cache"), "mochi");
      require("node:fs").writeFileSync(path.join(dir, "cat-shot.png"), (await win.webContents.capturePage()).toPNG());
      const info = await win.webContents.executeJavaScript(
        `JSON.stringify({ cat: !!document.querySelector('#cat'), size: [innerWidth, innerHeight], body: document.body.className })`);
      console.log(`[mochi] page rendered: ${info} — snapshot in ~/.cache/mochi/cat-shot.png`);
    } catch (err) { console.error("[mochi] snapshot failed", err); }
  }, 1500));
  // stream the mouse position so the cat's eyes can follow it anywhere on screen
  let last = "";
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint(), [winX, winY] = win.getPosition();
    const key = `${p.x},${p.y},${winX},${winY}`;
    if (key !== last) { last = key; win.webContents.send("cursor", { x: p.x, y: p.y, winX, winY, zoom: scale }); }
  }, 80);
  win.webContents.on("did-fail-load", (_e, code, desc) => console.error(`[mochi] cat page failed to load: ${code} ${desc}`));
  win.webContents.on("render-process-gone", (_e, d) => console.error(`[mochi] cat renderer crashed: ${d.reason}`));
  win.loadURL(URL);
}

/** Resize the window around the current scale, keeping the bottom-right corner where it is. */
function applySize() {
  if (!win) return;
  const b = win.getBounds(), d = dims();
  win.setBounds({ x: b.x + b.width - d.w, y: b.y + b.height - d.h, width: d.w, height: d.h });
  win.webContents.setZoomFactor(scale);
}
function setScale(s) {
  scale = clampScale(s);
  savePrefs({ ...loadPrefs(), scale });
  applySize();
}

function openTui(dir) {
  const cmd = ["opencode", "attach", `http://127.0.0.1:${OC_PORT}`, "--dir", dir, "--continue"];
  const term = process.env.MOCHI_TERMINAL || "kgx";
  const args = term === "gnome-terminal" ? ["--", ...cmd] : term === "foot" ? cmd : ["--", ...cmd];
  spawn(term, args, { cwd: dir, detached: true, stdio: "ignore" }).unref();
}

async function getState() {
  return new Promise((res) => {
    http.get(URL + "api/state", (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch { res({}); } }); }).on("error", () => res({}));
  });
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(["media", "audioCapture", "notifications"].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ["media", "audioCapture", "notifications"].includes(perm));

  await ensureBridge();
  setTimeout(createWindow, 400);

  ipcMain.on("move-by", (_e, dx, dy) => {
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ipcMain.on("panel", (_e, open) => { panelOpen = open; applySize(); });
  ipcMain.on("notify", (_e, body) => {
    if (!win.isFocused() && Notification.isSupported()) new Notification({ title: "Mochi 🐱", body, silent: false }).show();
  });
  ipcMain.on("menu", async (_e, info) => {
    const send = (a, arg) => win.webContents.send("menu", a, arg);
    const st = await getState();
    const projects = (info.projects || []).slice(0, 40).map((p) => ({ label: p, type: "radio", checked: p === info.current, click: () => send("project", p) }));
    Menu.buildFromTemplate([
      { label: info.voice === "off" ? "🎙  Start talking" : info.voice === "muted" ? "🎙  Unmute" : "🔇  Mute", click: () => send("talk") },
      ...(info.voice !== "off" ? [{ label: "📴  Hang up voice", click: () => send("hangup") }] : []),
      { type: "separator" },
      { label: "🖥  Open opencode TUI here", click: () => openTui(st.directory || ROOT) },
      { label: "📜  Activity / diff panel", click: () => send("panel") },
      { label: "🔍  Show changes", click: () => send("diff") },
      { label: "✋  Stop task", click: () => send("stop") },
      { label: "✨  New session", click: () => send("new") },
      { label: `📁  Project: ${info.current || "?"}`, submenu: projects },
      { label: `🐾  Size: ${Math.round(scale * 100)}%`, submenu: [0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => ({
          label: `${Math.round(s * 100)}%`, type: "radio", checked: Math.abs(s - scale) < 0.01, click: () => setScale(s) })) },
      { type: "separator" },
      { label: "Reload", click: () => win.reload() },
      { label: "DevTools", click: () => win.webContents.openDevTools({ mode: "detach" }) },
      { label: "Quit Mochi", click: () => app.quit() },
    ]).popup({ window: win });
  });

  // On GNOME Wayland apps can't grab global keys; bin/mochi-talk (bound as a GNOME shortcut) is the reliable path.
  if (process.env.XDG_SESSION_TYPE !== "wayland") globalShortcut.register(HOTKEY, () => win.webContents.send("hotkey"));

  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ROOT, "web", "icon.png")));
    tray.setToolTip("Mochi");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show / hide", click: () => (win.isVisible() ? win.hide() : win.show()) },
      { label: "Quit", click: () => app.quit() },
    ]));
  } catch {}
});

app.on("will-quit", () => { globalShortcut.unregisterAll(); bridge?.kill(); });
app.on("window-all-closed", () => app.quit());
