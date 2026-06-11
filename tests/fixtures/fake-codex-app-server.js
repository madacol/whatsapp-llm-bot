#!/usr/bin/env node
import fs from "node:fs";

const recordPath = process.env.FAKE_CODEX_RECORD_PATH;
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);
let inputBuffer = Buffer.alloc(0);
let useContentLengthFraming = false;
let currentThreadCwd = process.cwd();
const fakeTokenUsage = {
  total: {
    totalTokens: 12345,
    inputTokens: 8000,
    cachedInputTokens: 3000,
    outputTokens: 1345,
    reasoningOutputTokens: 200,
  },
  last: {
    totalTokens: 4345,
    inputTokens: 3000,
    cachedInputTokens: 1000,
    outputTokens: 1345,
    reasoningOutputTokens: 200,
  },
  modelContextWindow: 20000,
};

/**
 * @param {Record<string, unknown>} message
 */
function send(message) {
  const json = JSON.stringify(message);
  if (useContentLengthFraming) {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    return;
  }
  process.stdout.write(`${json}\n`);
}

/**
 * @param {unknown} id
 * @param {unknown} result
 */
function respond(id, result) {
  send({ id, result });
}

/**
 * @param {unknown} id
 * @param {string} message
 */
function reject(id, message) {
  send({ id, error: { code: 1001, message } });
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

/**
 * @param {unknown} parsed
 */
async function handleMessage(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return;
  }
  const message = /** @type {Record<string, unknown>} */ (parsed);
  const { id, method, params } = message;
  record("request", { method, params });
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
      if (typeof params.cwd === "string" && params.cwd.length > 0) {
        currentThreadCwd = params.cwd;
      }
      respond(id, {
        thread: { id: "fake-thread-1" },
        model: "fake-model",
        reasoningEffort: "none",
      });
      break;
    case "thread/resume":
      if (typeof params.cwd === "string" && params.cwd.length > 0) {
        currentThreadCwd = params.cwd;
      }
      respond(id, {
        thread: {
          id: "fake-thread-1",
          turns: [],
        },
        model: "fake-model",
        reasoningEffort: "none",
      });
      break;
    case "thread/settings/update":
      record("thread/settings/update", params);
      if (process.env.FAKE_CODEX_REJECT_SETTINGS_UPDATE === "unknown") {
        reject(id, "Invalid request: unknown variant `thread/settings/update`");
        break;
      }
      if (process.env.FAKE_CODEX_REJECT_SETTINGS_UPDATE === "hard") {
        reject(id, "settings update denied");
        break;
      }
      respond(id, {});
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
      if (process.env.FAKE_CODEX_REJECT_FAST === "1" && params.serviceTier === "fast") {
        reject(id, "fast service tier unavailable");
        break;
      }
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
      } else if (firstTextInput(params.input) === "read") {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : currentThreadCwd;
        const readPath = `${cwd}/sample-lines.txt`;
        const commandAction = {
          type: "read",
          command: "sed -n '10,12p' sample-lines.txt",
          name: "sample-lines.txt",
          path: readPath,
        };
        notify("item/started", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "read-1",
            type: "commandExecution",
            status: "inProgress",
            command: "/bin/zsh -lc \"sed -n '10,12p' sample-lines.txt\"",
            cwd,
            aggregatedOutput: null,
            commandActions: [commandAction],
          },
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "read-1",
            type: "commandExecution",
            status: "completed",
            command: "/bin/zsh -lc \"sed -n '10,12p' sample-lines.txt\"",
            cwd,
            aggregatedOutput: "line 10 value\nline 11 value\nline 12 value\n",
            exitCode: 0,
            commandActions: [commandAction],
          },
        });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: "fake-turn-1", status: "completed" },
        });
      } else if (firstTextInput(params.input) === "reasoning") {
        notify("item/reasoning/summaryPartAdded", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          itemId: "reasoning-1",
          summaryIndex: 0,
        });
        notify("item/reasoning/summaryTextDelta", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          itemId: "reasoning-1",
          summaryIndex: 0,
          delta: "Checking restart status.",
        });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: "fake-turn-1", status: "completed" },
        });
      } else if (firstTextInput(params.input) === "stdin") {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : currentThreadCwd;
        notify("item/started", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "stdin-command-1",
            type: "commandExecution",
            status: "inProgress",
            command: "/bin/zsh -lc \"read answer; echo $answer\"",
            cwd,
            aggregatedOutput: null,
            commandActions: [],
          },
        });
        notify("item/commandExecution/terminalInteraction", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          itemId: "stdin-command-1",
          processId: "65440",
          stdin: "yes\n",
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "stdin-command-1",
            type: "commandExecution",
            status: "completed",
            command: "/bin/zsh -lc \"read answer; echo $answer\"",
            cwd,
            aggregatedOutput: "yes\n",
            exitCode: 0,
            commandActions: [],
          },
        });
        notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: "fake-turn-1", status: "completed" },
        });
      }
      notify("thread/tokenUsage/updated", {
        threadId: params.threadId,
        turnId: "fake-turn-1",
        tokenUsage: fakeTokenUsage,
      });
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
    case "account/rateLimits/read":
      respond(id, {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: {
            usedPercent: 25,
            resetsAt: null,
            windowDurationMins: 300,
          },
          secondary: null,
          credits: null,
          individualLimit: null,
          planType: "pro",
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      });
      break;
    default:
      record("unknown-method", { method, params });
      reject(id, `unknown method ${typeof method === "string" ? method : String(method)}`);
      break;
  }
}

function drainContentLengthMessages() {
  for (;;) {
    const headerEnd = inputBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }
    const header = inputBuffer.subarray(0, headerEnd).toString("utf8");
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(header);
    if (!match) {
      inputBuffer = inputBuffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (inputBuffer.length < bodyEnd) {
      return;
    }
    const body = inputBuffer.subarray(bodyStart, bodyEnd).toString("utf8");
    inputBuffer = inputBuffer.subarray(bodyEnd);
    void handleMessage(JSON.parse(body));
  }
}

function drainLineMessages() {
  for (;;) {
    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    const line = inputBuffer.subarray(0, newlineIndex).toString("utf8").trim();
    inputBuffer = inputBuffer.subarray(newlineIndex + 1);
    if (!line) {
      continue;
    }
    void handleMessage(JSON.parse(line));
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  if (inputBuffer.includes("Content-Length:")) {
    useContentLengthFraming = true;
  }
  if (useContentLengthFraming) {
    drainContentLengthMessages();
  } else {
    drainLineMessages();
  }
});
process.stdin.resume();
