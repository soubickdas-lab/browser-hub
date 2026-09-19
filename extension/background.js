// Browser Hub Bridge — background.js
//
// This is the active half of the loop the browser-hub README describes:
//
//   Chrome + this extension  --HTTP long-poll-->  127.0.0.1:8777  <--stdio-->  Claude
//
// It long-polls the local hub for a command, runs it against this Chrome's
// tabs, and posts the result back. No popup UI drives execution — the popup
// only sets this browser's name and (rarely) a non-default
// hub URL.

const DEFAULT_HUB = "http://127.0.0.1:8777";
const KEEPALIVE_ALARM = "browser-hub-bridge-keepalive";
const POLL_ERROR_BACKOFF_MS = 4000;
const NO_NAME_RECHECK_MS = 5000;

let looping = false;
let lastPollOk = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chrome sign-in first; otherwise the first Google account logged in on the web (Gmail etc.).
async function profileEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: "ANY" });
    if (info && info.email) return info.email;
  } catch {}
  try {
    const res = await fetch(
      "https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&json=standard",
      { method: "POST", credentials: "include" }
    );
    const m = (await res.text()).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/);
    if (m) return m[0];
  } catch {}
  return "";
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "profileEmail") {
    profileEmail().then(reply);
    return true;
  }
});

async function getConfig() {
  const stored = await chrome.storage.local.get(["tagName", "installId", "hubUrl"]);
  if (!stored.installId) {
    stored.installId = crypto.randomUUID();
    await chrome.storage.local.set({ installId: stored.installId, createdAt: new Date().toISOString() });
  }
  if (!(stored.tagName || "").trim()) {
    const email = await profileEmail();
    if (email) {
      stored.tagName = email;
      await chrome.storage.local.set({ tagName: email });
    }
  }
  return {
    tagName: (stored.tagName || "").trim(),
    installId: stored.installId,
    hubUrl: (stored.hubUrl || DEFAULT_HUB).replace(/\/+$/, ""),
  };
}

async function setBadge(state) {
  const map = {
    connected: ["", "#1a7f37"],
    down: ["...", "#b45309"],
    noname: ["SET", "#b42318"],
  };
  const [text, color] = map[state] || ["?", "#666"];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  const titles = {
    connected: "Browser Hub Bridge — connected",
    down: "Browser Hub Bridge — hub not reachable (is the Browser Hub app running?)",
    noname: "Browser Hub Bridge — click to name this Chrome",
  };
  await chrome.action.setTitle({ title: titles[state] || "Browser Hub Bridge" });
}

function ensurePolling() {
  if (looping) return;
  looping = true;
  pollLoop().finally(() => {
    looping = false;
  });
}

async function pollLoop() {
  for (;;) {
    const cfg = await getConfig();
    if (!cfg.tagName) {
      await setBadge("noname");
      await sleep(NO_NAME_RECHECK_MS);
      continue;
    }

    let data;
    try {
      const res = await fetch(`${cfg.hubUrl}/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: cfg.tagName, installId: cfg.installId }),
      });
      data = await res.json();
      lastPollOk = true;
      await setBadge("connected");
    } catch (err) {
      lastPollOk = false;
      await setBadge("down");
      await sleep(POLL_ERROR_BACKOFF_MS);
      continue;
    }

    if (data && data.cmd) {
      await handleCommand(cfg.hubUrl, data.cmd);
    }
    // else: the hub held the poll open (no command) and returned empty —
    // loop straight back into the next poll.
  }
}

async function handleCommand(hubUrl, cmd) {
  const { id, op, args } = cmd;
  let ok = true;
  let result;
  let error;
  try {
    result = await runOp(op, args || {});
  } catch (err) {
    ok = false;
    error = String((err && err.message) || err);
  }
  try {
    await fetch(`${hubUrl}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ok, result, error }),
    });
  } catch {
    // The hub didn't get the result; its own call-timeout will surface the
    // failure to Claude on the next attempt.
  }
}

// ------------------------------------------------------------------- ops

async function activeTabId() {
  const win = await chrome.windows.getLastFocused({ populate: true });
  const active = win?.tabs?.find((t) => t.active);
  if (active) return active.id;
  const [tab] = await chrome.tabs.query({ active: true });
  if (!tab) throw new Error("no active tab found in this browser");
  return tab.id;
}

async function resolveTabId(args) {
  return args.tabId != null ? args.tabId : await activeTabId();
}

function waitForLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function debuggerEval(tabId, code) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || res.exceptionDetails.text || "eval failed"
      );
    }
    const r = res.result || {};
    if (r.value !== undefined) return r.value;
    if (r.description !== undefined) return r.description;
    return null;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function debuggerSetFileInput(tabId, selector, files) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "DOM.enable");
    // Chrome's DOM domain needs its tree fetched once before DOM.requestNode
    // will resolve an objectId to a nodeId — skipping this intermittently
    // fails with "Could not find node with given id".
    await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1, pierce: true });
    const findExpr = `(function(){
      function deepQuerySelector(root, sel) {
        const direct = root.querySelector(sel);
        if (direct) return direct;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const found = deepQuerySelector(el.shadowRoot, sel);
            if (found) return found;
          }
        }
        return null;
      }
      return deepQuerySelector(document, ${JSON.stringify(selector)});
    })()`;
    const evalRes = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: findExpr,
      returnByValue: false,
    });
    if (evalRes.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.exception?.description || "selector eval failed");
    }
    const objectId = evalRes.result?.objectId;
    if (!objectId) throw new Error(`no element matches "${selector}"`);
    const nodeRes = await chrome.debugger.sendCommand(target, "DOM.requestNode", { objectId });
    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
      files,
      nodeId: nodeRes.nodeId,
    });
    return { uploaded: true, files };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function debuggerUploadViaChooser(tabId, selector, files, timeoutMs = 8000, isExpr = false) {
  // For upload buttons that don't keep a real <input type=file> in the DOM
  // until the moment they're clicked (Angular Material and friends create
  // one on the fly and immediately open the native OS picker on it). Plain
  // debuggerSetFileInput can't see that input ahead of time, and clicking it
  // blind would pop a REAL OS file dialog on the user's screen - disruptive
  // on a browser they're actively using. This intercepts the file-chooser
  // dialog at the CDP level (same trick Playwright/Puppeteer use) so the
  // native dialog never opens at all: interception is armed first, then the
  // click fires, then Page.fileChooserOpened hands back the input node to
  // set files on directly.
  // User-activation-gated APIs (file chooser included) appear to require the
  // tab to actually be the foreground one, even when the click itself is a
  // real dispatched Input event via CDP - same as why the "shot" op below
  // activates a background tab before capturing it.
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(200);
  }

  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });

    const chooserPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener);
        reject(new Error(`no file chooser opened within ${timeoutMs}ms of clicking "${selector}"`));
      }, timeoutMs);
      const listener = (source, method, params) => {
        if (source.tabId === tabId && method === "Page.fileChooserOpened") {
          clearTimeout(timer);
          chrome.debugger.onEvent.removeListener(listener);
          resolve(params);
        }
      };
      chrome.debugger.onEvent.addListener(listener);
    });

    // A synthetic el.click() from Runtime.evaluate is NOT a trusted user
    // gesture, and Chrome silently refuses to open a file chooser from one -
    // the click "succeeds" (handler runs) but no Page.fileChooserOpened ever
    // fires. A real Input.dispatchMouseEvent at the element's coordinates
    // IS treated as genuine user activation, so find the element's center
    // point first, then click it the way Playwright/Puppeteer do.
    // `selector` is either a plain CSS selector (deep-queried through shadow
    // DOM, the original behaviour) or, with isExpr, a raw JS expression that
    // evaluates to the target element itself - for triggers only findable by
    // custom logic (e.g. "the visible button whose text matches /resume
    // upload/i inside this specific row"), which no CSS selector expresses.
    const findEl = isExpr
      ? selector
      : `(function(){
          function deepQuerySelector(root, sel) {
            const direct = root.querySelector(sel);
            if (direct) return direct;
            for (const el of root.querySelectorAll("*")) {
              if (el.shadowRoot) {
                const found = deepQuerySelector(el.shadowRoot, sel);
                if (found) return found;
              }
            }
            return null;
          }
          return deepQuerySelector(document, ${JSON.stringify(selector)});
        })()`;
    const rectExpr = `(function(){
      const el = ${findEl};
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`;
    const rectRes = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: rectExpr,
      returnByValue: true,
    });
    if (rectRes.exceptionDetails) {
      throw new Error(rectRes.exceptionDetails.exception?.description || "locate-element eval failed");
    }
    const box = rectRes.result?.value;
    if (!box) throw new Error(`no element matches "${selector}"`);
    if (box.w <= 0 || box.h <= 0) throw new Error(`element matching "${selector}" is not visible (zero size)`);

    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1,
    });

    const chooser = await chooserPromise;
    await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", {
      files,
      backendNodeId: chooser.backendNodeId,
    });
    return { uploaded: true, files };
  } finally {
    try {
      await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: false });
    } catch {
      // ignore - tab may already be gone
    }
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function runOp(op, args) {
  switch (op) {
    case "ping2": {
      return { pong: true, marker: "claude-edit-2026-09-17-v2-dispatchclick" };
    }

    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }

    case "tab.open": {
      try {
        const tab = await chrome.tabs.create({ url: args.url, active: args.active !== false });
        return { tabId: tab.id };
      } catch (err) {
        // Every window in this profile is closed (Chrome is only alive in
        // the background) — chrome.tabs.create has nothing to attach to and
        // fails with "No current window". Opening a window IS launching the
        // profile back onto the screen, and it comes with its own tab.
        if (!/no current window/i.test(String(err.message || err))) throw err;
        const win = await chrome.windows.create({
          url: args.url,
          focused: args.active !== false,
        });
        return { tabId: win.tabs[0].id };
      }
    }

    case "tab.close": {
      await chrome.tabs.remove(await resolveTabId(args));
      return { closed: true };
    }

    case "goto": {
      const tabId = await resolveTabId(args);
      await chrome.tabs.update(tabId, { url: args.url });
      await waitForLoad(tabId);
      return { tabId, url: args.url };
    }

    case "text": {
      const tabId = await resolveTabId(args);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxChars) => {
          const el = document.querySelector("article, main") || document.body;
          return (el.innerText || "").slice(0, maxChars);
        },
        args: [args.maxChars || 40000],
      });
      return result;
    }

    case "html": {
      const tabId = await resolveTabId(args);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxChars) => document.documentElement.outerHTML.slice(0, maxChars),
        args: [args.maxChars || 40000],
      });
      return result;
    }

    case "click": {
      const tabId = await resolveTabId(args);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          function deepQuerySelector(root, sel) {
            const direct = root.querySelector(sel);
            if (direct) return direct;
            for (const el of root.querySelectorAll("*")) {
              if (el.shadowRoot) {
                const found = deepQuerySelector(el.shadowRoot, sel);
                if (found) return found;
              }
            }
            return null;
          }
          const el = deepQuerySelector(document, selector);
          if (!el) return { clicked: false };
          el.scrollIntoView({ block: "center" });
          el.click();
          return { clicked: true };
        },
        args: [args.selector],
      });
      if (!result?.clicked) throw new Error(`no element matches "${args.selector}"`);
      return result;
    }

    case "fill": {
      const tabId = await resolveTabId(args);
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector, value) => {
          function deepQuerySelector(root, sel) {
            const direct = root.querySelector(sel);
            if (direct) return direct;
            for (const el of root.querySelectorAll("*")) {
              if (el.shadowRoot) {
                const found = deepQuerySelector(el.shadowRoot, sel);
                if (found) return found;
              }
            }
            return null;
          }
          const el = deepQuerySelector(document, selector);
          if (!el) return { filled: false };
          const isInput = el instanceof HTMLInputElement;
          const isTextarea = el instanceof HTMLTextAreaElement;
          if (isInput || isTextarea) {
            const proto = isTextarea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
          } else {
            el.textContent = value;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { filled: true };
        },
        args: [args.selector, args.value],
      });
      if (!result?.filled) throw new Error(`no element matches "${args.selector}"`);
      return result;
    }

    case "eval": {
      const tabId = await resolveTabId(args);
      // A session with an older cached tools/list only knows the "code"
      // string field on browser_eval — no new field will reach here, the
      // transport type-checks against that cached schema. So a file upload
      // rides inside the string itself via a sentinel prefix instead of a
      // new argument, letting old sessions reach new capabilities without a
      // fresh MCP handshake.
      const UPLOAD_PREFIX = "__UPLOAD_FILES__:";
      const UPLOAD_CHOOSER_PREFIX = "__UPLOAD_FILES_VIA_CHOOSER__:";
      if (typeof args.code === "string" && args.code.startsWith(UPLOAD_PREFIX)) {
        const { selector, files } = JSON.parse(args.code.slice(UPLOAD_PREFIX.length));
        return await debuggerSetFileInput(tabId, selector, files);
      }
      if (typeof args.code === "string" && args.code.startsWith(UPLOAD_CHOOSER_PREFIX)) {
        const { selector, files } = JSON.parse(args.code.slice(UPLOAD_CHOOSER_PREFIX.length));
        return await debuggerUploadViaChooser(tabId, selector, files);
      }
      return await debuggerEval(tabId, args.code);
    }

    case "uploadFile": {
      const tabId = await resolveTabId(args);
      return await debuggerSetFileInput(tabId, args.selector, args.files);
    }

    case "uploadFileViaChooser": {
      // Like uploadFile, but for triggers that create their <input type=file>
      // only at click time (see debuggerUploadViaChooser). `selector` is the
      // CLICKABLE trigger (button/div/etc), not the input itself - unless
      // args.isExpr is true, in which case `selector` is a raw JS expression
      // evaluating to the element directly (for triggers only findable by
      // custom logic, e.g. "the visible button matching /resume upload/i
      // inside this specific row").
      const tabId = await resolveTabId(args);
      return await debuggerUploadViaChooser(tabId, args.selector, args.files, 8000, !!args.isExpr);
    }

    case "cdpSend": {
      // Generic CDP passthrough for whatever a caller's own Page-style
      // wrapper needs that has no dedicated op (e.g. Browser.setDownload
      // Behavior to point file downloads at a specific local folder).
      // args.method is any CDP method name, args.params its params object.
      const tabId = await resolveTabId(args);
      const target = { tabId };
      await chrome.debugger.attach(target, "1.3");
      try {
        return await chrome.debugger.sendCommand(target, args.method, args.params || {});
      } finally {
        await chrome.debugger.detach(target).catch(() => {});
      }
    }

    case "shot": {
      const tabId = await resolveTabId(args);
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) {
        await chrome.tabs.update(tabId, { active: true });
        await sleep(150);
      }
      return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    }

    default:
      throw new Error(`unhandled op: ${op}`);
  }
}

// ------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  ensurePolling();
});
chrome.runtime.onStartup.addListener(ensurePolling);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) ensurePolling();
});
chrome.storage.onChanged.addListener(ensurePolling);

// The service worker script re-runs every time Chrome wakes it, so kick the
// loop off unconditionally at load too — this is what actually recovers it
// after Chrome suspends the worker mid-poll.
ensurePolling();
