#!/usr/bin/env node
// Registers this folder's local-hub.js as the `browsers` MCP server for a
// project, so Claude launches it automatically. Safe to re-run.
//
//   node install.js              -> registers in the folder above this one
//   node install.js "D:\work"    -> registers in that folder instead

const fs = require("node:fs");
const path = require("node:path");

const hubPath = path.join(__dirname, "local-hub.js").replace(/\\/g, "/");
const target = path.resolve(process.argv[2] || path.dirname(__dirname));
const configPath = path.join(target, ".mcp.json");

function bail(message) {
  console.error("\n  " + message + "\n");
  process.exit(1);
}

if (!fs.existsSync(hubPath)) {
  bail(`local-hub.js is missing next to this script — expected it at ${hubPath}`);
}
if (!fs.existsSync(target)) {
  bail(`That folder does not exist: ${target}`);
}

let config = { mcpServers: {} };
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    bail(`${configPath} is not valid JSON, so it was left alone: ${err.message}`);
  }
  // Keep a copy before touching a file that already has other servers in it.
  const backup = configPath + ".bak-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  fs.copyFileSync(configPath, backup);
  console.log("  backed up  " + backup);
}

if (!config.mcpServers) config.mcpServers = {};
const existing = config.mcpServers.browsers;
config.mcpServers.browsers = { command: "node", args: [hubPath] };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

console.log(existing ? "  updated    " : "  registered ", configPath);
console.log("  hub        " + hubPath);
console.log("");
console.log("  Node " + process.version + " — fine.");
console.log("");
console.log("  Next:");
console.log("    1. Restart Claude Code, opened on:  " + target);
console.log("    2. In each Chrome here: chrome://extensions -> Developer mode ->");
console.log("       Load unpacked -> the browser-tag-extension folder next to this one");
console.log("    3. Click the Browser Tag icon, give this Chrome a name, Save");
console.log("");
console.log("  The popup should then read: connected as \"<your name>\".");
console.log("  Until Claude is running, \"hub not running\" is the correct answer —");
console.log("  Claude is what starts the hub.");
console.log("");
