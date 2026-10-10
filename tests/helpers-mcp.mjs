// A stdio MCP server process for tests (the same one mcp-server.test.mjs drives): requests resolve with the
// response, everything without an id is kept as a notification.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

import { ROOT } from "./helpers.mjs";

const SERVER = path.join(ROOT, "plugins", "ultracodex", "scripts", "mcp-server.mjs");

export function startServer(t, env) {
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const waiting = new Map();
  const messages = [];
  let stderr = "";
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const message = JSON.parse(line); // every line the server writes is protocol
      messages.push(message);
      if (message.id !== undefined && message.id !== null && waiting.has(message.id)) {
        waiting.get(message.id)(message);
        waiting.delete(message.id);
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  t.after(() => child.kill());
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const server = {
    child,
    exited,
    stderr: () => stderr,
    messages,
    notifications: () => messages.filter((message) => message.id === undefined && message.method),
    channel: () => messages.filter((message) => message.method === "notifications/claude/channel").map((message) => message.params),
    raw: (text) => child.stdin.write(text),
    notify: (method, params) => write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    request: (method, params, { timeoutMs = 90_000 } = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId;
        nextId += 1;
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} ${JSON.stringify(params)}\n${stderr}`)), timeoutMs);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      }),
    // a tool's text as JSON (or the response when it is an error)
    call: async (name, args = {}) => {
      const response = await server.request("tools/call", { name, arguments: args });
      assert.ok(response.result, JSON.stringify(response));
      const text = response.result.content[0].text;
      let json = null;
      try {
        json = JSON.parse(text.trim().split("\n").at(-1));
      } catch {
        json = null;
      }
      return { isError: Boolean(response.result.isError), text, json };
    },
    initialize: async (protocolVersion = "2025-06-18") => {
      const response = await server.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "0" } });
      server.notify("notifications/initialized");
      return response.result;
    },
  };
  return server;
}
