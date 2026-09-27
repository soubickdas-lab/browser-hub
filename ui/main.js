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

// Every place a Claude on this machine keeps its MCP servers. Claude Desktop is
// the one that matters on a machine with no CLI, so it is written directly —
// no CLI, no PATH, nothing to find.
function claudeDesktopConfigPath() {
  if (process.platform === "win32") return path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

// Adds/replaces mcpServers.browsers in a JSON config, keeping everything else.
function writeMcpInto(file) {
  let config = {};
  if (fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      return `${file}\n  not valid JSON, left alone`;
    }
    fs.copyFileSync(file, file + ".bak");
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers.browsers = mcpServerEntry();
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return `${file}\n  registered`;
}

function hasMcpEntry(file) {
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    return !!(config.mcpServers && config.mcpServers.browsers);
  } catch {
    return false;
  }
}

// A running Claude keeps its own copy of its config in memory and writes it
// back whenever anything changes, which silently undoes our entry. So: write,
// wait, check it is still there, and say plainly if it is not.
async function writeAndVerify(app_, file) {
  const written = writeMcpInto(file);
  keepRegistered(file);
  await new Promise((r) => setTimeout(r, 2500));
  if (!hasMcpEntry(file)) {
    return (
      `${app_}: ${app_} is running and rewrote this file.\n${file}\n` +
      `  Browser Hub puts the entry back and keeps it there — quit ${app_}\n` +
      "  completely (tray/menu-bar icon -> Quit), then start it again."
    );
  }
  return `${app_} (restart it):\n` + written;
}

function registerClaudeDesktop() {
  return writeAndVerify("Claude Desktop", claudeDesktopConfigPath());
}

// Claude rewrites its config from the copy it loaded at startup, so an entry
// added while it is running disappears again — including on the way out, which
// is why registering once is not enough. Watching the file and putting the
// entry back means the next start always finds it.
const KEEP_FILE = () => path.join(app.getPath("userData"), "keep-registered.json");

function keptFiles() {
  try {
    return JSON.parse(fs.readFileSync(KEEP_FILE(), "utf8")).files || [];
  } catch {
    return [];
  }
}

function keepRegistered(file) {
  const files = keptFiles();
  if (!files.includes(file)) {
    files.push(file);
    fs.writeFileSync(KEEP_FILE(), JSON.stringify({ files }, null, 2));
  }
  watchConfig(file);
}

const watched = new Set();
function watchConfig(file) {
  if (watched.has(file) || !fs.existsSync(path.dirname(file))) return;
  watched.add(file);
  let timer = null;
  fs.watch(path.dirname(file), (_event, name) => {
    if (name && name !== path.basename(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (fs.existsSync(file) && !hasMcpEntry(file)) {
        try {
          writeMcpInto(file);
        } catch {}
      }
    }, 1500);
  });
}

// Optional extra: Claude Code, if this machine has the CLI. Not every machine does.
function findClaudeCli() {
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".local", "bin", "claude.exe"),
          path.join(home, ".local", "bin", "claude.cmd"),
          path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
          path.join(home, ".bun", "bin", "claude.exe"),
        ]
      : [
          path.join(home, ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
          path.join(home, ".bun", "bin", "claude"),
          path.join(home, ".npm-global", "bin", "claude"),
        ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function registerClaudeCode() {
  const cli = findClaudeCli();
  // Node refuses to run a .cmd without a shell, and a shell mangles the JSON,
  // so a .cmd install takes the config-file route below instead.
  const runnable = cli && (process.platform !== "win32" || cli.endsWith(".exe"));
  if (!runnable) {
    // Same entry, written where `claude mcp add --scope user` would put it.
    const file = path.join(os.homedir(), ".claude.json");
    if (!fs.existsSync(file)) return "Claude Code: not installed, skipped";
    return writeAndVerify("Claude Code", file);
  }
  const json = JSON.stringify({ type: "stdio", ...mcpServerEntry() });
  return new Promise((resolve) => {
    // No shell: the JSON and the paths reach the CLI exactly as written.
    const run = (args, cb) => execFile(cli, args, { windowsHide: true, timeout: 90000 }, cb);
    run(["mcp", "remove", "--scope", "user", "browsers"], () => {
      run(["mcp", "add-json", "--scope", "user", "browsers", json], (err) => {
        resolve(
          err
            ? `Claude Code: ${cli}\n  failed: ${String(err.message || err).split("\n")[0]}`
            : "Claude Code (restart it):\n  registered for all projects"
        );
      });
    });
  });
}

async function connectClaude() {
  const lines = [await registerClaudeDesktop(), await registerClaudeCode()];
  return lines.join("\n\n");
}

function copyMcpConfig() {
  clipboard.writeText(JSON.stringify({ mcpServers: { browsers: mcpServerEntry() } }, null, 2));
}

async function connectClaudeWithDialog() {
  const result = await connectClaude();
  dialog.showMessageBox({ type: "info", title: "Browser Hub", message: "Connect Claude", detail: result });
}

// ------------------------------------------------------------------ updates
// Releases carry one zip per platform (installer + extension), so the app
// fetches the release, unpacks it and hands the installer over. No extra
// update server, no second set of release files to keep in step.
const REPO = "soubickdas-lab/browser-hub";

function isNewer(remote, local) {
  const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(remote), parse(local)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function latestRelease() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "browser-hub-app" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return res.json();
}

async function checkUpdate() {
  const current = app.getVersion();
  try {
    const release = await latestRelease();
    const version = String(release.tag_name || "").replace(/^v/, "");
    return { current, version, available: isNewer(version, current), url: release.html_url };
  } catch (err) {
    return { current, error: String(err.message || err) };
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 300000 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).split("\n")[0])) : resolve(stdout)
    );
  });
}

async function installUpdate() {
  const release = await latestRelease();
  const version = String(release.tag_name || "").replace(/^v/, "");
  if (!isNewer(version, app.getVersion())) return `Already on the latest version (${app.getVersion()}).`;

  const wanted = process.platform === "win32" ? /^Browser-Hub-Windows-.*\.zip$/ : /^Browser-Hub-Mac-.*\.zip$/;
  const asset = (release.assets || []).find((a) => wanted.test(a.name));
  if (!asset) throw new Error(`Release ${version} has no download for this platform`);

  const dir = path.join(app.getPath("temp"), `browser-hub-update-${version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, asset.name);

  const res = await fetch(asset.browser_download_url, { headers: { "user-agent": "browser-hub-app" } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));

  if (process.platform === "win32") {
    await run("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
    const setup = fs.readdirSync(dir).find((f) => f.endsWith(".exe"));
    if (!setup) throw new Error("No installer inside the downloaded zip");
    // The installer replaces this app, so it has to outlive it.
    spawn(path.join(dir, setup), ["/S"], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => {
      app.isQuitting = true;
      app.quit();
    }, 1500);
    return `Installing ${version}… the app will close and reopen itself.`;
  }

  await run("/usr/bin/unzip", ["-o", zip, "-d", dir]);
  const dmg = fs.readdirSync(dir).find((f) => f.endsWith(`-${process.arch}.dmg`)) ||
    fs.readdirSync(dir).find((f) => f.endsWith(".dmg"));
  if (!dmg) throw new Error("No dmg inside the downloaded zip");
  await shell.openPath(path.join(dir, dmg));
  return `Opened ${dmg} — drag Browser Hub into Applications, replacing the old one.`;
}

// ---------------------------------------------------------------- diagnose
// One report that answers "why can't Claude see my browsers", so a machine
// this app is not sitting in front of can still be fixed.
async function diagnose() {
  const out = [];
  const entry = mcpServerEntry();
  out.push(`Browser Hub v${app.getVersion()}  ${process.platform}-${process.arch}`);
  out.push(`app:  ${process.execPath}`);
  out.push(`hub:  ${HUB_JS}${fs.existsSync(HUB_JS) ? "" : "   <- MISSING"}`);

  let live = null;
  for (let port = 8777; port <= 8787; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      const data = await res.json();
      const mine = data.app === "browser-hub" || (data.ok === true && Array.isArray(data.browsers));
      out.push(
        `port ${port}: ${mine ? `hub, ${(data.browsers || []).length} browser(s) connected` : "something else"}`
      );
      if (mine && !live) live = data;
    } catch {}
  }
  if (!live) out.push("port 8777-8787: no hub answered — the hub is not running");
  else if (!(live.browsers || []).length) {
    out.push("No Chrome is polling: load the extension (Open extension folder) and reload it in chrome://extensions");
  } else {
    out.push("browsers: " + live.browsers.map((b) => `${b.name} (${b.lastSeenSecondsAgo}s)`).join(", "));
  }

  for (const [label, file] of [
    ["Claude Desktop", claudeDesktopConfigPath()],
    ["Claude Code", path.join(os.homedir(), ".claude.json")],
  ]) {
    if (!fs.existsSync(file)) {
      out.push(`${label}: no config at ${file} (not installed?)`);
      continue;
    }
    let config;
    try {
      config = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      out.push(`${label}: config is not valid JSON — ${file}`);
      continue;
    }
    const found = config.mcpServers && config.mcpServers.browsers;
    if (!found) out.push(`${label}: NO browsers entry — press Connect Claude (with ${label} closed)`);
    else if (found.command !== entry.command)
      out.push(`${label}: browsers entry points elsewhere:\n    ${found.command}\n  should be:\n    ${entry.command}`);
    else out.push(`${label}: browsers entry OK`);
  }

  out.push(`extension folder: ${extensionFolder()}`);
  return out.join("\n");
}

// Where this machine actually put everything, read off this machine.
async function livePort() {
  for (let port = 8777; port <= 8787; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      const data = await res.json();
      if (data.app === "browser-hub" || (data.ok === true && Array.isArray(data.browsers))) return port;
    } catch {}
  }
  return null;
}

ipcMain.handle("hub:paths", async () => ({
  version: app.getVersion(),
  app: process.execPath,
  hub: HUB_JS,
  extension: extensionFolder(),
  port: await livePort(),
  mcp: JSON.stringify({ mcpServers: { browsers: mcpServerEntry() } }, null, 2),
}));

ipcMain.handle("hub:copyText", (_e, text) => clipboard.writeText(String(text || "")));

ipcMain.handle("hub:diagnose", async () => {
  const report = await diagnose();
  clipboard.writeText(report);
  return report;
});

ipcMain.handle("hub:version", () => app.getVersion());
ipcMain.handle("hub:checkUpdate", () => checkUpdate());
ipcMain.handle("hub:installUpdate", async () => {
  try {
    return await installUpdate();
  } catch (err) {
    return `Update failed: ${String(err.message || err)}`;
  }
});

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
    width: 760,
    height: 820,
    minWidth: 620,
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
  for (const file of keptFiles()) watchConfig(file);
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
