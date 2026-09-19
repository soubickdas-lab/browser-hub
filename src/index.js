// browser-hub — name-addressed browser control.
//
//   Chrome extensions  --WebSocket-->  /agent  \
//                                               >  BrowserHub (Durable Object)
//   Claude (MCP client) --HTTP JSON-RPC-->  /mcp /
//
// Browsers are addressed by the NAME their owner typed into the Browser Tag
// extension. Nothing here ever sees a Claude deviceId, so a deviceId rotating
// changes nothing.

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 45000;

export default {
  async fetch(request, env) {
    const id = env.HUB.idFromName("hub");
    return env.HUB.get(id).fetch(request);
  },
};

function keyOf(request, url) {
  return (
    request.headers.get("x-owner-key") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    ""
  );
}

// Constant-time-ish compare, so a wrong key leaks nothing through timing.
function keyMatches(given, expected) {
  if (!expected) return false;
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export class BrowserHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.agents = new Map(); // name -> { socket, meta }
    this.pending = new Map(); // callId -> { resolve, reject, timer }
    this.seq = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (!keyMatches(keyOf(request, url), this.env.OWNER_KEY || "")) {
      return new Response("unauthorized", { status: 401 });
    }

    if (url.pathname === "/agent") return this.handleAgent(request, url);
    if (url.pathname === "/mcp") return this.handleMcp(request);
    if (url.pathname === "/browsers") {
      return Response.json({ browsers: this.listBrowsers() });
    }
    return new Response(
      "browser-hub: /agent (websocket), /mcp (json-rpc), /browsers",
      { status: 404 }
    );
  }

  listBrowsers() {
    return [...this.agents.entries()].map(([name, a]) => ({
      name,
      pc: a.meta.pc,
      installId: a.meta.installId,
      connectedAt: a.meta.connectedAt,
    }));
  }

  // ---- agent side (the Chrome extensions) --------------------------------

  handleAgent(request, url) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const name = (url.searchParams.get("name") || "").trim();
    if (!name) return new Response("missing ?name", { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const meta = {
      pc: url.searchParams.get("pc") || "",
      installId: url.searchParams.get("installId") || "",
      connectedAt: new Date().toISOString(),
    };

    // A reconnect from the same browser replaces its old socket, rather than
    // leaving a dead entry sitting under the same name.
    const existing = this.agents.get(name);
    if (existing && existing.socket !== server) {
      try {
        existing.socket.close(1000, "replaced by newer connection");
      } catch {}
    }
    this.agents.set(name, { socket: server, meta });

    server.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "pong" || msg.type === "hello") return;

      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error(msg.error || "the browser reported an unspecified failure"));
    });

    const drop = () => {
      const current = this.agents.get(name);
      if (current && current.socket === server) this.agents.delete(name);
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  callBrowser(name, op, args) {
    const agent = this.agents.get(name);
    if (!agent) {
      const open = this.listBrowsers().map((b) => b.name);
      throw new Error(
        `No browser named "${name}" is connected. Currently connected: ` +
          (open.length ? open.join(", ") : "(none)")
      );
    }

    const id = `c${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`"${name}" did not answer ${op} within ${CALL_TIMEOUT_MS / 1000}s`)
        );
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        agent.socket.send(JSON.stringify({ id, op, args }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`Could not reach "${name}": ${err.message}`));
      }
    });
  }

  // ---- MCP side (Claude) -------------------------------------------------

  async handleMcp(request) {
    if (request.method !== "POST") {
      return new Response("browser-hub MCP endpoint — POST JSON-RPC here", {
        status: 405,
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
    }

    const batch = Array.isArray(body) ? body : [body];
    const replies = [];
    for (const msg of batch) {
      const reply = await this.handleRpc(msg);
      if (reply) replies.push(reply);
    }
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? replies : replies[0]);
  }

  async handleRpc(msg) {
    const { id, method, params } = msg || {};
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

    if (method === "initialize") {
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "browser-hub", version: "1.0.0" },
      });
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      if (!TOOLS.some((t) => t.name === toolName)) {
        return fail(-32602, `unknown tool: ${toolName}`);
      }
      try {
        return ok(await this.runTool(toolName, args));
      } catch (err) {
        // Surface the failure as a tool result so Claude can react to it and
        // retry, rather than as a transport-level protocol error.
        return ok({
          isError: true,
          content: [{ type: "text", text: String(err.message || err) }],
        });
      }
    }

    return fail(-32601, `unknown method: ${method}`);
  }

  async runTool(name, args) {
    const text = (t) => ({ content: [{ type: "text", text: t }] });
    const json = (o) => text(JSON.stringify(o, null, 2));

    if (name === "browser_list") {
      const list = this.listBrowsers();
      if (!list.length) {
        return text(
          "No browsers are connected. Each Chrome needs the Browser Tag extension " +
            "installed, named, and pointed at this hub with the owner key."
        );
      }
      return json(list);
    }

    const target = String(args.name || "").trim();
    if (!target) {
      throw new Error('`name` is required — the browser\'s tag, e.g. "DNS YT"');
    }

    switch (name) {
      case "browser_tabs":
        return json(await this.callBrowser(target, "tabs.list", {}));
      case "browser_open":
        return json(
          await this.callBrowser(target, "tab.open", {
            url: args.url,
            active: args.active !== false,
          })
        );
      case "browser_close":
        return json(await this.callBrowser(target, "tab.close", { tabId: args.tabId }));
      case "browser_goto":
        return json(
          await this.callBrowser(target, "goto", { tabId: args.tabId, url: args.url })
        );
      case "browser_text":
        return text(
          await this.callBrowser(target, "text", {
            tabId: args.tabId,
            maxChars: args.maxChars || 40000,
          })
        );
      case "browser_html":
        return text(
          await this.callBrowser(target, "html", {
            tabId: args.tabId,
            maxChars: args.maxChars || 40000,
          })
        );
      case "browser_click":
        return json(
          await this.callBrowser(target, "click", {
            tabId: args.tabId,
            selector: args.selector,
          })
        );
      case "browser_fill":
        return json(
          await this.callBrowser(target, "fill", {
            tabId: args.tabId,
            selector: args.selector,
            value: args.value,
          })
        );
      case "browser_eval":
        return text(
          await this.callBrowser(target, "eval", { tabId: args.tabId, code: args.code })
        );
      case "browser_shot": {
        const dataUrl = String(await this.callBrowser(target, "shot", { tabId: args.tabId }));
        const comma = dataUrl.indexOf(",");
        return {
          content: [
            { type: "image", data: dataUrl.slice(comma + 1), mimeType: "image/jpeg" },
          ],
        };
      }
      default:
        throw new Error(`unhandled tool: ${name}`);
    }
  }
}

const NAME_ARG = {
  type: "string",
  description:
    'The browser\'s tag, exactly as typed into its Browser Tag extension (e.g. "DNS YT").',
};
const TAB_ARG = {
  type: "number",
  description:
    "Tab id from browser_tabs or browser_open. Omit to use the browser's active tab.",
};

const TOOLS = [
  {
    name: "browser_list",
    description:
      "List every Chrome currently connected to the hub, by the name its owner gave it. " +
      "Call this first when unsure which browsers are up. These names are stable — they " +
      "never shuffle the way the Claude in Chrome picker's Browser 1/2/3 labels do.",
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
    name: "browser_shot",
    description: "Screenshot the visible area of a tab.",
    inputSchema: {
      type: "object",
      properties: { name: NAME_ARG, tabId: TAB_ARG },
      required: ["name"],
    },
  },
];
