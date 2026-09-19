const $ = (id) => document.getElementById(id);
const DEFAULT_HUB = "http://127.0.0.1:8777";

let installId = null;

(async () => {
  const d = await chrome.storage.local.get(["tagName", "installId", "hubUrl"]);
  if (!d.tagName) {
    let email = "";
    try {
      email = await chrome.runtime.sendMessage({ type: "profileEmail" });
    } catch {}
    if (email) {
      d.tagName = email;
      await chrome.storage.local.set({ tagName: email });
    }
  }
  $("tag").value = d.tagName || "";
  $("hub").value = d.hubUrl || "";

  installId = d.installId;
  if (!installId) {
    installId = crypto.randomUUID();
    await chrome.storage.local.set({ installId, createdAt: new Date().toISOString() });
  }
  $("iid").textContent = "installId: " + installId;

  syncCopyButton();
  $("tag").addEventListener("input", syncCopyButton);
  await refreshStatus(d.tagName, d.hubUrl);
  $("tag").focus();
})();

// Keep in sync with buildPrompt() in browser-hub/ui/index.html.
function buildPrompt(name) {
  return `Browser hub connect kar. Chrome ka naam "${name}" hai (Browser Hub Bridge extension ka naam).
1. mcp__browsers__browser_list chalao. Agar (none) aaye ya browsers tools hi na milein, to check karo http://127.0.0.1:8777/health par hub kya dikha raha hai, aur Claude ke MCP settings mein \"browsers\" server registered hai ya nahi (Browser Hub app ka \"Connect Claude\" button ise register karta hai).
2. Hub aur MCP alag instances hon to duplicate hub process band karke sahi wala chalao (koi bhi kaam ka process kill karne se pehle mujhse pooch lena).
3. Jab list mein naam aa jaye, browser_open se https://aipoint.online kholo aur confirm karo.
Browser picker mat kholna aur mujhse kaunsa Chrome pooch mat.`;
}

function syncCopyButton() {
  const name = $("tag").value.trim();
  const btn = $("copyPrompt");
  btn.disabled = !name;
  btn.textContent = name ? `Copy Claude prompt — ${name}` : "Copy Claude prompt";
}

$("copyPrompt").addEventListener("click", async () => {
  const name = $("tag").value.trim();
  if (!name) return;
  try {
    await navigator.clipboard.writeText(buildPrompt(name));
    flash(`Prompt copied for "${name}". Claude chat mein paste karo.`);
  } catch {
    flash("Copy failed", false);
  }
});

async function refreshStatus(tagName, hubUrl) {
  const el = $("status");
  if (!tagName) {
    el.textContent = "No name set yet.";
    el.style.background = "#fdecea";
    el.style.color = "#b42318";
    return;
  }

  const base = (hubUrl || DEFAULT_HUB).replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/health`, { method: "GET" });
    const data = await res.json();
    const mine = (data.browsers || []).find((b) => b.name === tagName);
    if (mine) {
      el.textContent = `Connected as "${tagName}" — last seen ${mine.lastSeenSecondsAgo}s ago.`;
      el.style.background = "#e6f4ea";
      el.style.color = "#1a7f37";
    } else {
      el.textContent =
        `Hub is running, but "${tagName}" hasn't polled it yet. ` +
        `Give it a few seconds, or reload this extension.`;
      el.style.background = "#fff4e5";
      el.style.color = "#b45309";
    }
  } catch {
    el.textContent = "Hub not reachable — open the Browser Hub app (it starts the hub).";
    el.style.background = "#fff4e5";
    el.style.color = "#b45309";
  }
}

function flash(text, ok = true) {
  const el = $("status");
  el.textContent = text;
  el.style.background = ok ? "#e6f4ea" : "#fdecea";
  el.style.color = ok ? "#1a7f37" : "#b42318";
}

$("save").addEventListener("click", async () => {
  const tag = $("tag").value.trim();
  if (!tag) return flash("Type a name for this Chrome first", false);

  const hubUrl = $("hub").value.trim();
  await chrome.storage.local.set({
    tagName: tag,
    hubUrl: hubUrl || undefined,
  });

  flash(`Saved as "${tag}". Reconnecting…`);
  setTimeout(() => refreshStatus(tag, hubUrl), 1500);
});
