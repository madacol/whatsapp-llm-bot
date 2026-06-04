#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const recordPath = process.env.FAKE_CODEX_RECORD_PATH;
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
process.stdin.resume();
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

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

/**
 * @param {unknown} input
 * @returns {string}
 */
function firstTextInput(input) {
  if (!Array.isArray(input)) {
    return "";
  }
  const first = input[0];
  return first && typeof first === "object" && typeof first.text === "string"
    ? first.text
    : "";
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
      record("turn/start", params);
      respond(id, { turn: { id: "fake-turn-1" } });
      notify("turn/started", { threadId: params.threadId, turn: { id: "fake-turn-1" } });
      if (firstTextInput(params.input) === "web") {
        notify("item/started", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "web-search-1",
            type: "webSearch",
            status: "inProgress",
            query: "runtime migration",
            action: {
              type: "search",
              query: "runtime migration",
              queries: ["runtime migration"],
            },
          },
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "web-search-1",
            type: "webSearch",
            status: "completed",
            query: "runtime migration",
            action: {
              type: "search",
              query: "runtime migration",
              queries: ["runtime migration"],
            },
          },
        });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: "fake-turn-1", status: "completed" },
        });
      }
      break;
    case "thread/settings/update":
      record("thread/settings/update", params);
      respond(id, {});
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
