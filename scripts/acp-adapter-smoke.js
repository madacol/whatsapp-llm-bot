#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

const [, , label, command, ...args] = process.argv;

if (!label || !command) {
  console.error("Usage: node scripts/acp-adapter-smoke.js <label> <command> [args...]");
  process.exit(2);
}

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    signal: controller.signal,
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    const text = String(chunk).trimEnd();
    if (text) {
      console.error(`[${label} stderr] ${text}`);
    }
  });
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
  const pending = new Map();
  const readLoop = (async () => {
    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line);
      if (typeof message.id === "number" && "result" in message) {
        pending.get(message.id)?.resolve(message.result);
        pending.delete(message.id);
        continue;
      }
      if (typeof message.id === "number" && "error" in message) {
        pending.get(message.id)?.reject(new Error(message.error?.message ?? "ACP request failed."));
        pending.delete(message.id);
        continue;
      }
      if (typeof message.id === "number" && typeof message.method === "string") {
        proc.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `Smoke client does not implement ${message.method}.` },
        })}\n`);
      }
    }
  })();
  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<unknown>}
   */
  const sendRequest = (method, params) => {
    const id = nextId++;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };
  try {
    const result = await sendRequest("initialize", {
      protocolVersion: 1,
      clientInfo: {
        name: "madabot-smoke",
        title: "Madabot Smoke",
        version: "1.0.0",
      },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        elicitation: { form: {}, url: {} },
      },
    });
    const agentInfo = result && typeof result === "object" && "agentInfo" in result
      ? result.agentInfo
      : null;
    const agentCapabilities = result && typeof result === "object" && "agentCapabilities" in result && result.agentCapabilities && typeof result.agentCapabilities === "object"
      ? Object.keys(result.agentCapabilities).sort()
      : [];
    console.log(JSON.stringify({
      label,
      command,
      args,
      agentInfo,
      agentCapabilities,
    }, null, 2));
  } finally {
    proc.kill();
    await readLoop.catch(() => {});
  }
} finally {
  clearTimeout(timeout);
}
