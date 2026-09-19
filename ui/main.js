const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, clipboard, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");

let mainWindow = null;
let tray = null;
let hubChild = null;
app.isQuitting = false;

app.setAppUserModelId("SoubickDas.BrowserHub");
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => createWindow(true));
}

// Packaged: resources/hub + resources/extension. Dev: the repo folders.
const HUB_JS = app.isPackaged
  ? path.join(process.resourcesPath, "hub", "local-hub.js")
  : path.join(__dirname, "..", "local-hub.js");
const EXTENSION_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "extension")
  : path.join(__dirname, "..", "extension");

// A copy outside the app bundle: Chrome needs a stable folder it can read, and
// on macOS it cannot load an unpacked extension from inside /Applications/*.app reliably.
function extensionFolder() {
  const target = path.join(app.getPath("userData"), "extension");
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const f of fs.readdirSync(EXTENSION_DIR)) {
      fs.copyFileSync(path.join(EXTENSION_DIR, f), path.join(target, f));
    }
    return target;
  } catch {
    return EXTENSION_DIR;
  }
}

// The same binary runs the hub as plain Node, so no separate Node install is needed.
// Forward slashes: cmd.exe (claude CLI via shell) strips backslashes.
function mcpServerEntry() {
  const fwd = (p) => p.replace(/\\/g, "/");
  return {
    command: fwd(process.execPath),
    args: [fwd(HUB_JS)],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function startHub() {
  hubChild = spawn(process.execPath, [HUB_JS], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    // stdin stays open (the hub exits when its stdin closes).
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  hubChild.on("exit", () => {
    hubChild = null;
    if (!app.isQuitting) setTimeout(startHub, 3000);
  });
}

function claudeDesktopConfigPath() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function registerClaudeDesktop() {
  const file = claudeDesktopConfigPath();
  if (!fs.existsSync(path.dirname(file))) return "Claude Desktop: not installed, skipped";
  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return "Claude Desktop: config is not valid JSON, left alone";
    }
    fs.copyFileSync(file, file + ".bak");
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.browsers = mcpServerEntry();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return "Claude Desktop: registered (restart Claude Desktop)";
}

function registerClaudeCode() {
  const json = JSON.stringify({ type: "stdio", ...mcpServerEntry() });
  // A GUI app on macOS gets a minimal PATH that misses where the claude CLI lives.
  const extra = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const env = { ...process.env, PATH: [...extra, process.env.PATH || ""].join(path.delimiter) };
  return new Promise((resolve) => {
    const run = (args, cb) =>
      execFile("claude", args, { shell: true, windowsHide: true, timeout: 90000, env }, cb);
    run(["mcp", "remove", "--scope", "user", "browsers"], () => {
      // shell:true on Windows needs the JSON quoted for cmd.exe.
      const arg = process.platform === "win32" ? `"${json.replace(/"/g, '\\"')}"` : `'${json}'`;
      run(["mcp", "add-json", "--scope", "user", "browsers", arg], (err, stdout, stderr) => {
        if (err) resolve("Claude Code: `claude` CLI not found — use Copy MCP config instead");
        else resolve("Claude Code: registered for all projects (restart Claude Code)");
      });
    });
  });
}

async function connectClaude() {
  const lines = [await registerClaudeCode(), registerClaudeDesktop()];
  return lines.join("\n");
}

function copyMcpConfig() {
  clipboard.writeText(JSON.stringify({ mcpServers: { browsers: mcpServerEntry() } }, null, 2));
}

async function connectClaudeWithDialog() {
  const result = await connectClaude();
  dialog.showMessageBox({ type: "info", title: "Browser Hub", message: "Connect Claude", detail: result });
}

ipcMain.handle("hub:connectClaude", () => connectClaude());
ipcMain.handle("hub:copyMcpConfig", () => copyMcpConfig());
ipcMain.handle("hub:openExtensionFolder", () => shell.openPath(extensionFolder()));
ipcMain.handle("hub:extensionFolder", () => extensionFolder());

function createWindow(show) {
  if (mainWindow) {
    if (show) {
      mainWindow.show();
      mainWindow.focus();
    }
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    title: "Browser Hub",
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon-512.png"),
    backgroundColor: "#0b1021",
    autoHideMenuBar: true,
    show,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  // Closing only hides; Quit lives in the tray menu.
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function createTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, "tray-icon.png"));
  if (process.platform === "darwin") icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Browser Hub — 127.0.0.1:8777");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open dashboard", click: () => createWindow(true) },
      { label: "Connect Claude (register MCP)", click: () => connectClaudeWithDialog() },
      { label: "Copy MCP config", click: () => copyMcpConfig() },
      { label: "Open extension folder", click: () => shell.openPath(extensionFolder()) },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => createWindow(true));
}

const startHidden = process.argv.includes("--hidden");

app.whenReady().then(() => {
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
  }
  startHub();
  extensionFolder();
  createTray();
  createWindow(!startHidden);
  app.on("activate", () => createWindow(true));
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (hubChild) hubChild.kill();
});

// The tray keeps the app alive after every window closes.
app.on("window-all-closed", (e) => {
  e.preventDefault();
});
