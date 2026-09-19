# browser-hub

Lets Claude drive a Chrome **by the name its owner gave it**, with no deviceId
anywhere in the loop.

## Install — Windows or Mac

Download from **Releases**:

- **Windows:** `Browser-Hub-Setup-<version>.exe` — double-click, done.
- **Mac:** `Browser-Hub-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel) —
  open, drag **Browser Hub** into Applications. First launch: right-click → **Open**
  (the app is not notarised; on macOS 15+ use System Settings → Privacy & Security →
  **Open Anyway**).

No Node.js needed — the app carries its own runtime and runs the hub itself. It
starts at login and lives in the tray / menu bar.

Then, once per machine:

1. In the app: **Connect Claude**. It registers the `browsers` MCP server for Claude
   Code (all projects, via the `claude` CLI) and for Claude Desktop. Restart Claude.
   No `claude` CLI? Use **Copy MCP config** and paste it into your MCP settings.
2. In each Chrome: `chrome://extensions` → Developer mode ON → **Load unpacked** →
   the folder from **Open extension folder**.
3. The extension names itself after the profile's Google account (Chrome sign-in,
   or the account logged in on the web). It shows up in the app's list.

Badge green = talking to the hub. Amber = hub not running (open the app).
Red = no name yet (not signed in anywhere — type one in the popup).

**Prompts for Claude:** the app's **Copy hub prompt** (connect + list profiles);
click a profile row for **Copy <email> prompt**. The extension popup has the same
per-profile button.

## Build the installers

```bash
cd ui
npm ci
npm run dist:win   # on Windows -> ui/dist/*.exe
npm run dist:mac   # on a Mac   -> ui/dist/*.dmg (x64 + arm64)
```

Pushing a `v*` tag builds both on GitHub Actions and attaches them to a Release.

## Without the app (Node installed)

`install.cmd` / `install.sh` register `local-hub.js` with plain `node` in a
project's `.mcp.json` — the older setup, still works.

## Why it works

```
  Chrome + Browser Tag  ──HTTP long-poll──▶  127.0.0.1:8777  ◀──stdio──  Claude
```

Claude in Chrome lists browsers as `Browser 1`, `Browser 2`, `Browser 3` — those
are **positions in a list**, reassigned whenever any browser connects or
disconnects, including browsers on other machines. The deviceIds behind them
rotate too. So neither can be written down and relied on later.

Here the name is set by the owner inside the browser and sent on every poll. It
is the address, and it never changes on its own.

The hub binds to the **loopback address only**. A browser on another PC cannot
reach it, so picking the wrong PC's Chrome stops being possible rather than
merely unlikely. Each PC runs its own hub and sees only its own browsers.

## Tools

```
browser_list
browser_tabs   { name }
browser_open   { name, url, active? }
browser_goto   { name, url, tabId? }
browser_close  { name, tabId }
browser_text   { name, tabId?, maxChars? }
browser_html   { name, tabId?, maxChars? }
browser_click  { name, selector, tabId? }
browser_fill   { name, selector, value, tabId? }
browser_eval   { name, code, tabId? }
browser_shot   { name, tabId? }
```

`tabId` is optional everywhere it appears — omit it to act on that browser's
active tab.

`browser_eval` runs through the Chrome debugger, so page CSP cannot block it.
Chrome shows its "being debugged" bar during the call.

It does **not** reproduce Claude in Chrome's accessibility tree, `ref_N` element
targeting or smart clicking. For heavy interactive UI work Claude in Chrome is
still the better tool; this hub is for reaching the *right* browser reliably and
doing solid, selector-driven work in it.

## Check it by hand

```bash
curl http://127.0.0.1:8777/health
```

Answers while the Browser Hub app (or a Claude session) is running. `browsers: []` means no Chrome
has been named yet.

Port clash? Set `BROWSER_HUB_PORT` in `.mcp.json` and put the same URL in each
extension's Advanced → Hub URL.

## Files

| file | what it does |
|---|---|
| `local-hub.js` | the whole thing — MCP server on stdio, HTTP hub on loopback |
| `ui/` | the Browser Hub desktop app (Electron) — dashboard, tray, installers |
| `extension/` | the Browser Hub Bridge Chrome extension |
| `src/index.js` | optional Cloudflare Worker version, see below |
| `wrangler.toml` | config for that Worker |

## The Cloudflare version (not needed)

`src/index.js` is the same hub as a Worker + Durable Object, for reaching a
browser on a *different* machine over the internet. It needs a deploy, a domain
and an owner key, and that key can drive browsers already logged into Google and
YouTube Studio — a real thing to secure.

The local hub has none of that exposure and solves the actual problem, so use it
unless cross-machine control is genuinely wanted. Deploy steps are in the git
history of this README, or ask.
