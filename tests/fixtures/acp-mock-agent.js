#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

/** @type {string | null} */
let sessionId = null;

/**
 * @param {Record<string, unknown>} message
 */
function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
function notify(method, params) {
  send({ method, params });
}

for await (const line of rl) {
  if (!line.trim()) {
    continue;
  }
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            resume: {},
            fork: {},
            steer: {},
          },
          session: {
            fork: {},
          },
        },
      },
    });
    continue;
  }
  if (message.method === "session/new") {
    sessionId = "mock-session-1";
    send({ id: message.id, result: { sessionId } });
    continue;
  }
  if (message.method === "session/load") {
    sessionId = message.params?.sessionId ?? "mock-session-1";
    send({ id: message.id, result: { sessionId } });
    continue;
  }
  if (message.method === "session/resume") {
    sessionId = message.params?.sessionId ?? "mock-session-1";
    send({ id: message.id, result: { sessionId } });
    continue;
  }
  if (message.method === "session/fork") {
    sessionId = "mock-session-fork";
    send({ id: message.id, result: { sessionId } });
    continue;
  }
  if (message.method === "session/prompt") {
    const sid = sessionId ?? "mock-session-1";
    notify("session/update", {
      sessionId: sid,
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Mock ACP work", status: "in_progress" }],
      },
    });
    notify("session/update", {
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "toolu-task-1",
        title: "Review mock code",
        kind: "think",
        rawInput: { subagent_type: "reviewer", prompt: "Look for issues" },
        status: "in_progress",
      },
    });
    notify("session/update", {
      sessionId: sid,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Subagent result." },
        _meta: { claudeCode: { parentToolUseId: "toolu-task-1" } },
      },
    });
    notify("session/update", {
      sessionId: sid,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        title: "Edited mock.txt",
        status: "completed",
        content: [{ type: "diff", path: "mock.txt", oldText: "old", newText: "new" }],
      },
    });
    notify("session/update", {
      sessionId: sid,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Main result." },
      },
    });
    notify("session/update", {
      sessionId: sid,
      update: {
        sessionUpdate: "usage_update",
        used: 42,
        size: 1000,
        cost: { amount: 0.002, currency: "USD" },
      },
    });
    send({
      id: message.id,
      result: {
        sessionId: sid,
        stopReason: "end_turn",
        usage: {
          total_tokens: 42,
          input_tokens: 30,
          output_tokens: 10,
          thought_tokens: 2,
          cached_read_tokens: 5,
          cached_write_tokens: 1,
        },
      },
    });
    continue;
  }
  send({ id: message.id, result: {} });
}
