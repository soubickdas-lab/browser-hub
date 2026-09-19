# Browser Hub Bridge (browser-tag-extension)

The active half of `browser-hub`. Installing this in a Chrome makes that
Chrome directly drivable by Claude, by name, through the `browsers` MCP
server (`D:\CLAUDE CHAT\browser-hub\local-hub.js`).

```
  Chrome + this extension  --HTTP long-poll-->  127.0.0.1:8777  <--stdio-->  Claude
```

This is different from `browser-tag-lite`, which only labels a Chrome so
Claude-in-Chrome can find it by reading a page — it cannot execute anything.
This extension executes: `browser_tabs`, `browser_open`, `browser_goto`,
`browser_close`, `browser_text`, `browser_html`, `browser_click`,
`browser_fill`, `browser_eval`, `browser_shot` (see `browser-hub/README.md`).

## Install

1. Make sure Claude Code has run at least once in `D:\CLAUDE CHAT` so the
   hub (`browsers` in `.mcp.json`) has started and is listening on
   `127.0.0.1:8777`.
2. `chrome://extensions` → Developer mode on → **Load unpacked** →
   `D:\CLAUDE CHAT\browser-tag-extension`.
3. Click the toolbar icon, type a **name** (this is exactly what
   `browser_list` will show, e.g. `DNS YT`) and the **machine name**, then
   **Save**.

Badge blank/green = polling the hub normally. Amber `...` = hub not
reachable (Claude not running, or the wrong port). Red `SET` = no name typed
yet.

## Notes

- One extension load = one browser identity. Load it separately in each
  Chrome profile you want Claude to control, and give each a distinct name.
- `browser_eval` attaches the Chrome debugger to the target tab for the
  duration of the call (you'll see Chrome's "being debugged" bar) so it
  works even on pages with a strict CSP.
- `browser_shot` can only capture a tab's *own* window's active tab (a
  Chrome API limitation), so the extension activates the requested tab
  first if it isn't already focused.
- If the hub's port was moved via `BROWSER_HUB_PORT`, set the same URL under
  **Advanced → Hub URL** in the popup.
