#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const recordPath = process.env.FAKE_CODEX_RECORD_PATH;
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

/**
 * @param {Record<string, unknown>} message
 */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * @param {unknown} id
 * @param {unknown} result
 */
function respond(id, result) {
  send({ id, result });
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
function notify(method, params) {
  send({ method, params });
}

/**
 * @param {string} event
 * @param {unknown} value
 */
function record(event, value) {
  if (!recordPath) {
    return;
  }
  fs.appendFileSync(recordPath, `${JSON.stringify({ event, value })}\n`);
}

for await (const line of rl) {
  if (!line.trim()) {
    continue;
  }
  const message = JSON.parse(line);
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      respond(id, {});
      break;
    case "account/read":
      respond(id, { requiresOpenaiAuth: false, account: null });
      break;
    case "skills/list":
      respond(id, { skills: [] });
      break;
    case "thread/start":
      respond(id, {
        thread: { id: "fake-thread-1" },
        model: "fake-model",
        reasoningEffort: "none",
      });
      break;
    case "model/list":
      respond(id, {
        data: [{
          id: "fake-model",
          displayName: "Fake Model",
          description: "Fake model",
          isDefault: true,
          defaultReasoningEffort: "none",
          supportedReasoningEfforts: [{ reasoningEffort: "none", description: "None" }],
          inputModalities: ["text"],
        }],
        nextCursor: null,
      });
      break;
    case "turn/start":
      respond(id, { turn: { id: "fake-turn-1" } });
      notify("turn/started", { threadId: params.threadId, turn: { id: "fake-turn-1" } });
      break;
    case "turn/steer":
      record("turn/steer", params);
      respond(id, {});
      notify("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId: params.expectedTurnId,
        itemId: "agent-message-1",
        delta: "steered response",
      });
      notify("turn/completed", {
        threadId: params.threadId,
        turn: { id: params.expectedTurnId, status: "completed" },
      });
      break;
    default:
      respond(id, {});
      break;
  }
}
