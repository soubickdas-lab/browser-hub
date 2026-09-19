#!/usr/bin/env node
// browser-hub, local edition.
//
// One process, no dependencies, nothing to deploy. Claude Code launches it as
// an MCP server over stdio; it also listens on 127.0.0.1 so the Browser Tag
// extension in each Chrome can reach it.
//
//   Chrome + Browser Tag  --HTTP long-poll-->  127.0.0.1:8777  <--stdio-->  Claude
//
// Because it binds to the loopback address only, browsers on any other machine
// physically cannot reach it. Picking the wrong PC's Chrome stops being possible
// rather than merely unlikely.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.BROWSER_HUB_PORT || 8777);
const POLL_HOLD_MS = 25000; // how long a browser's poll waits before returning empty
const CALL_TIMEOUT_MS = 45000;
const ONLINE_WINDOW_MS = 70000; // a browser seen more recently than this is "connected"
const LAUNCH_WAIT_MS = 45000; // how long to wait for a cold-launched Chrome to start polling
const LAUNCH_POLL_MS = 1500;

const os = require("node:os");
const HOME = os.homedir();

const CHROME_EXE_CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    path.join(HOME, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
}[process.platform] || [];

const CHROME_USER_DATA = {
  win32: path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  darwin: path.join(HOME, "Library", "Application Support", "Google", "Chrome"),
  linux: path.join(HOME, ".config", "google-chrome"),
}[process.platform] || "";

function findChromeExe() {
  return CHROME_EXE_CANDIDATES.find((p) => fs.existsSync(p)) || null;
}

// A browser tag (the name typed into the extension popup) only exists once
// that Chrome is running and polling. When it's not connected, Chrome's own
// "Local State" file — the same one the profile picker reads — maps every
// profile directory to the Google account signed into it, which is enough
// to cold-launch the right profile by name with no extension involved.
function readChromeProfileMap() {
  const localState = path.join(CHROME_USER_DATA, "Local State");
  try {
    const data = JSON.parse(fs.readFileSync(localState, "utf8"));
    const cache = (data.profile && data.profile.info_cache) || {};
    const map = {};
    for (const [dir, info] of Object.entries(cache)) {
      if (info && info.user_name) map[info.user_name] = dir;
    }
    return map;
  } catch {
    return {};
  }
}

function launchChromeProfile(profileDir) {
  const exe = findChromeExe();
  if (!exe) return false;
  const child = spawn(exe, [`--profile-directory=${profileDir}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const browsers = new Map(); // name -> { pc, installId, lastSeen }
const waiting = new Map(); // name -> http response held open
const queues = new Map(); // name -> [command]
const pending = new Map(); // callId -> { resolve, reject, timer }
let seq = 0;

// ------------------------------------------------------------ browser side

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 32 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function flush(name) {
  const res = waiting.get(name);
  const queue = queues.get(name);
  if (!res || !queue || !queue.length) return;
  waiting.delete(name);
  clearTimeout(res._holdTimer);
  send(res, 200, { cmd: queue.shift() });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      // Chrome preflights requests that cross into the private network.
      "access-control-allow-private-network": "true",
    });
    return res.end();
  }

  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, port: PORT, browsers: listBrowsers() });
  }

  // Every Chrome profile on this machine Chrome itself knows about, not just
  // the ones currently polling — lets a dashboard show every account with a
  // live online/offline dot instead of only the ones already connected.
  if (url.pathname === "/profiles") {
    const map = readChromeProfileMap();
    return send(
      res,
      200,
      Object.entries(map).map(([name, dir]) => ({ name, dir }))
    );
  }

  if (url.pathname === "/launch" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    const name = String(body.name || "").trim();
    const dir = readChromeProfileMap()[name];
    if (!dir) return send(res, 404, { ok: false, error: `no known Chrome profile for "${name}"` });
    const launched = launchChromeProfile(dir);
    return send(res, 200, launched ? { ok: true } : { ok: false, error: "Google Chrome not found" });
  }

  if (url.pathname === "/poll" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    const name = String(body.name || "").trim();
    if (!name) return send(res, 400, { error: "missing name" });

    browsers.set(name, {
      pc: body.pc || "",
      installId: body.installId || "",
      lastSeen: Date.now(),
    });

    // Only one poll per browser is held; a second replaces the first.
    const older = waiting.get(name);
    if (older) {
      clearTimeout(older._holdTimer);
      send(older, 200, {});
    }

    const queue = queues.get(name);
    if (queue && queue.length) return send(res, 200, { cmd: queue.shift() });

    waiting.set(name, res);
    res._holdTimer = setTimeout(() => {
      if (waiting.get(name) === res) {
        waiting.delete(name);
        send(res, 200, {});
      }
    }, POLL_HOLD_MS);
    res.on("close", () => {
      if (waiting.get(name) === res) waiting.delete(name);
    });
    return;
  }

  if (url.pathname === "/result" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    const waiter = pending.get(body.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      pending.delete(body.id);
      if (body.ok) waiter.resolve(body.result);
      else waiter.reject(new Error(body.error || "the browser reported an unspecified failure"));
    }
    return send(res, 200, { ok: true });
  }

  // Every MCP process talks to the browser registry through this HTTP API,
  // never through its own in-memory Map — only one process ever wins the
  // port bind (see server.on("error") below), so this is the only registry
  // that ever actually hears from a browser. A second, third, ... Claude
  // session's local-hub.js loses the bind but still answers tool calls
  // correctly by forwarding here instead of consulting its own empty state.
  if (url.pathname === "/control/call" && req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    try {
      const result = await callBrowser(body.name, body.op, body.args);
      return send(res, 200, { ok: true, result });
    } catch (err) {
      return send(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  send(res, 404, { error: "not found" });
});

let bound = false;
let retryTimer = null;
const REBIND_RETRY_MS = 4000;

server.on("listening", () => {
  bound = true;
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
  process.stderr.write(`browser-hub: listening on ${PORT}\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Another hub already owns the port — almost always a second Claude
    // session, or the always-on background copy. That one is serving the
    // browsers; this process answers tool calls through it (see
    // fetchBrowserList/fetchCallBrowser below) and keeps quietly retrying
    // the bind so it takes over automatically the moment the port frees up
    // — no restart of this process required.
    bound = false;
    process.stderr.write(
      `browser-hub: port ${PORT} is already in use, so another hub is already running. ` +
        `This instance will answer tool calls through it, and will take over automatically ` +
        `if that one exits.\n`
    );
    if (!retryTimer) {
      retryTimer = setInterval(() => {
        if (!bound) server.listen(PORT, "127.0.0.1");
      }, REBIND_RETRY_MS);
    }
  } else {
    process.stderr.write(`browser-hub: ${err.message}\n`);
  }
});

server.listen(PORT, "127.0.0.1");

function listBrowsers() {
  const now = Date.now();
  return [...browsers.entries()]
    .filter(([, b]) => now - b.lastSeen < ONLINE_WINDOW_MS)
    .map(([name, b]) => ({
      name,
      pc: b.pc,
      installId: b.installId,
      lastSeenSecondsAgo: Math.round((now - b.lastSeen) / 1000),
    }));
}

async function callBrowser(name, op, args) {
  let known = listBrowsers().map((b) => b.name);
  let justLaunched = false;
  if (!known.includes(name)) {
    const profileMap = readChromeProfileMap();
    const profileDir = profileMap[name];
    if (profileDir && launchChromeProfile(profileDir)) {
      justLaunched = true;
      const deadline = Date.now() + LAUNCH_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(LAUNCH_POLL_MS);
        known = listBrowsers().map((b) => b.name);
        if (known.includes(name)) break;
      }
    }
  }
  if (!known.includes(name)) {
    throw new Error(
      `No browser named "${name}" is connected` +
        (readChromeProfileMap()[name]
          ? ` (tried launching its Chrome profile, but it didn't come online within ${LAUNCH_WAIT_MS / 1000}s)`
          : "") +
        `. Currently connected: ` +
        (known.length ? known.join(", ") : "(none)") +
        ". Check that Chrome is open and the Browser Tag extension is named."
    );
  }

  // A profile we just cold-launched has only just started polling — its tab
  // may still be on the new-tab page's first paint, sync/sign-in checks
  // still settling, extensions still finishing their own startup. The very
  // first command it runs deserves more slack than a browser that was
  // already sitting there warm and idle.
  const timeoutMs = justLaunched ? CALL_TIMEOUT_MS + LAUNCH_WAIT_MS : CALL_TIMEOUT_MS;

  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`"${name}" did not answer ${op} within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });

    if (!queues.has(name)) queues.set(name, []);
    queues.get(name).push({ id, op, args });
    flush(name);
  });
}

// ---------------------------------------------------------------- MCP side

const NAME_ARG = {
  type: "string",
  description:
    'The browser\'s tag, exactly as typed into its Browser Tag extension (e.g. "DNS YT").',
};
const TAB_ARG = {
  type: "number",
  description: "Tab id from browser_tabs or browser_open. Omit to use the browser's active tab.",
};

const TOOLS = [
  {
    name: "browser_list",
    description:
      "List every Chrome on this machine that is connected to the hub, by the name its " +
      "owner gave it. Call this first when unsure which browsers are up. These names are " +
      "stable — they never shuffle the way the Claude in Chrome picker's Browser 1/2/3 " +
      "labels do, and only browsers on this PC can appear here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_tabs",
    description: "List the open tabs in one browser: tab id, title and URL.",
    inputSchema: { type: "object", properties: { name: NAME_ARG }, required: ["name"] },
  },
  {
    name: "browser_open",
    description: "Open a new tab in one browser and return its tab id.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_ARG,
        url: { type: "string", description: "URL to load." },
        active: { type: "boolean", description: "Focus the new tab. Default true." },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "browser_goto",
    description: "Navigate an existing tab to a URL and wait for it to finish loading.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG, url: { type: "string" } },
      required: ["name", "url"],
    },
  },
  {
    name: "browser_close",
    description: "Close a tab.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG },
      required: ["name", "tabId"],
    },
  },
  {
    name: "browser_text",
    description: "Read a tab's visible text. The cheapest way to see what a page says.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG, maxChars: { type: "number" } },
      required: ["name"],
    },
  },
  {
    name: "browser_html",
    description:
      "Read a tab's HTML. Use when the visible text alone is not enough to find a selector.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG, maxChars: { type: "number" } },
      required: ["name"],
    },
  },
  {
    name: "browser_click",
    description: "Click the first element matching a CSS selector.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG, selector: { type: "string" } },
      required: ["name", "selector"],
    },
  },
  {
    name: "browser_fill",
    description:
      "Set the value of an input, textarea or contenteditable, firing the input and change " +
      "events that React and similar frameworks listen for.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_ARG,
        tabId: TAB_ARG,
        selector: { type: "string" },
        value: { type: "string" },
      },
      required: ["name", "selector", "value"],
    },
  },
  {
    name: "browser_eval",
    description:
      "Run JavaScript in a tab and return the last expression's value. Runs through the " +
      "Chrome debugger, so it works even on pages whose CSP blocks injected scripts.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG, code: { type: "string" } },
      required: ["name", "code"],
    },
  },
  {
    name: "browser_upload",
    description:
      "Set files on a file <input>, as if the user picked them from a native OS file dialog — " +
      "including inputs hidden inside a shadow DOM (upload dialogs, e.g. YouTube Studio, bury " +
      "them there). The selector does not need to match the visible upload button; point it at " +
      "the actual <input type=file>, or a container to search inside. Files must be absolute " +
      "paths on THIS PC.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_ARG,
        tabId: TAB_ARG,
        selector: { type: "string" },
        files: { type: "array", items: { type: "string" }, description: "Absolute file paths on this machine." },
      },
      required: ["name", "selector", "files"],
    },
  },
  {
    name: "browser_upload_via_chooser",
    description:
      "Like browser_upload, but for an upload trigger (button, div, etc.) whose file <input> " +
      "does not exist in the page until the moment it is clicked - common on Material-style " +
      "upload widgets. Point the selector at the CLICKABLE trigger, not an <input>. This arms " +
      "Chrome's file-chooser interception first, so clicking it never pops a real OS file " +
      "dialog on the person's screen; the files are attached directly instead.",
    inputSchema: {
      type: "object",
      properties: {
        name: NAME_ARG,
        tabId: TAB_ARG,
        selector: { type: "string", description: "CSS selector of the clickable upload trigger." },
        files: { type: "array", items: { type: "string" }, description: "Absolute file paths on this machine." },
      },
      required: ["name", "selector", "files"],
    },
  },
  {
    name: "browser_shot",
    description: "Screenshot the visible area of a tab.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG },
      required: ["name"],
    },
  },
];

const OPS = {
  browser_tabs: ["tabs.list", (a) => ({})],
  browser_open: ["tab.open", (a) => ({ url: a.url, active: a.active !== false })],
  browser_close: ["tab.close", (a) => ({ tabId: a.tabId })],
  browser_goto: ["goto", (a) => ({ tabId: a.tabId, url: a.url })],
  browser_text: ["text", (a) => ({ tabId: a.tabId, maxChars: a.maxChars || 40000 })],
  browser_html: ["html", (a) => ({ tabId: a.tabId, maxChars: a.maxChars || 40000 })],
  browser_click: ["click", (a) => ({ tabId: a.tabId, selector: a.selector })],
  browser_fill: ["fill", (a) => ({ tabId: a.tabId, selector: a.selector, value: a.value })],
  browser_eval: ["eval", (a) => ({ tabId: a.tabId, code: a.code })],
  browser_upload: ["uploadFile", (a) => ({ tabId: a.tabId, selector: a.selector, files: a.files })],
  browser_upload_via_chooser: ["uploadFileViaChooser", (a) => ({ tabId: a.tabId, selector: a.selector, files: a.files })],
  browser_shot: ["shot", (a) => ({ tabId: a.tabId })],
};

// Always the local HTTP API, never the in-process Map — this is what makes
// tool calls correct regardless of which local-hub.js process (there may be
// several, one per open Claude session) happens to be answering MCP stdio.
async function fetchBrowserList() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  const data = await res.json();
  return data.browsers || [];
}

async function fetchCallBrowser(target, op, opArgs) {
  const res = await fetch(`http://127.0.0.1:${PORT}/control/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: target, op, args: opArgs }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "call failed");
  return data.result;
}

async function runTool(name, args) {
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const json = (o) => text(JSON.stringify(o, null, 2));

  if (name === "browser_list") {
    const list = await fetchBrowserList();
    if (!list.length) {
      return text(
        "No browsers are connected. Each Chrome on this machine needs the Browser Hub Bridge " +
          "extension: open chrome://extensions, turn on Developer mode, Load unpacked -> the " +
          "extension folder (Browser Hub app -> tray menu -> Open extension folder). It names " +
          "itself after the profile's Google account; click its icon to check."
      );
    }
    return json(list);
  }

  const target = String(args.name || "").trim();
  if (!target) throw new Error('`name` is required — the browser\'s tag, e.g. "DNS YT"');

  const entry = OPS[name];
  if (!entry) throw new Error(`unhandled tool: ${name}`);
  const [op, buildArgs] = entry;
  const result = await fetchCallBrowser(target, op, buildArgs(args));

  if (name === "browser_shot") {
    const dataUrl = String(result);
    return {
      content: [
        { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg" },
      ],
    };
  }
  return typeof result === "string" ? text(result) : json(result);
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    return ok({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "browser-hub-local", version: "1.0.0" },
    });
  }
  if (method && method.startsWith("notifications/")) return null;
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });

  if (method === "tools/call") {
    const toolName = params?.name;
    if (!TOOLS.some((t) => t.name === toolName)) return fail(-32602, `unknown tool: ${toolName}`);
    try {
      return ok(await runTool(toolName, params?.arguments || {}));
    } catch (err) {
      // Report through the tool result so Claude can read the reason and retry.
      return ok({ isError: true, content: [{ type: "text", text: String(err.message || err) }] });
    }
  }

  return fail(-32601, `unknown method: ${method}`);
}

// MCP over stdio is newline-delimited JSON-RPC.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleRpc(msg).then((reply) => {
      if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
    });
  }
});
process.stdin.on("end", () => process.exit(0));
