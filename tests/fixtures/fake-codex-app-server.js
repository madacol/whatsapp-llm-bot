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
const fakeReasoningEffort = process.env.FAKE_CODEX_REASONING_EFFORT ?? "none";
const fakeSupportedReasoningEfforts = fakeReasoningEffort === "none"
  ? [{ reasoningEffort: "none", description: "None" }]
  : [{ reasoningEffort: fakeReasoningEffort, description: fakeReasoningEffort }];
const fakeAccount = process.env.FAKE_CODEX_ACCOUNT_TYPE
  ? { type: process.env.FAKE_CODEX_ACCOUNT_TYPE }
  : null;

/**
 * @param {Record<string, unknown>} message
 */
function send(message) {
  const json = JSON.stringify(message);
  if (useContentLengthFraming) {
    fs.writeSync(1, `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    return;
  }
  fs.writeSync(1, `${json}\n`);
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
 * @param {unknown} threadId
 * @param {string} cwd
 */
function notifyDeleteAddRewriteFixture(threadId, cwd) {
  const targetPath = `${cwd}/approval-delete-add.md`;
  const newText = "# Rewritten approval file\nThis content was produced after the approval-blocking delete-plus-add rewrite.\n";
  const turnDiff = [
    "diff --git a/codex-approval-delete-add-WzZqhw/approval-delete-add.md b/codex-approval-delete-add-WzZqhw/approval-delete-add.md",
    "index a6eb855bc856db41afcc044026044bfe318dd6b0..b3aa4fe2a1edbc0e2adf8c603e3dd569e7a4c5a9",
    "--- a/codex-approval-delete-add-WzZqhw/approval-delete-add.md",
    "+++ b/codex-approval-delete-add-WzZqhw/approval-delete-add.md",
    "@@ -1,2 +1,2 @@",
    "-# Original approval file",
    "-This file must be rewritten through one delete-plus-add apply_patch.",
    "+# Rewritten approval file",
    "+This content was produced after the approval-blocking delete-plus-add rewrite.",
    "",
  ].join("\n");
  const item = {
    id: "call_delete_add_rewrite",
    type: "fileChange",
    changes: [{
      path: targetPath,
      kind: { type: "add" },
      diff: newText,
    }],
    status: "completed",
  };

  notify("item/started", {
    threadId,
    turnId: "fake-turn-1",
    item: { ...item, status: "inProgress" },
  });
  notify("item/completed", {
    threadId,
    turnId: "fake-turn-1",
    item,
  });
  notify("turn/diff/updated", {
    threadId,
    turnId: "fake-turn-1",
    diff: turnDiff,
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId: "fake-turn-1",
    itemId: "agent-message-1",
    delta: "DONE",
  });
  notify("turn/completed", {
    threadId,
    turn: { id: "fake-turn-1", status: "completed" },
  });
}

/**
 * @param {unknown} threadId
 * @param {string} cwd
 */
function notifyCreateThenDeleteAddRewriteFixture(threadId, cwd) {
  const targetPath = `${cwd}/generated-delete-add.md`;
  const originalText = "# Generated file\nThis file was created earlier in the same turn.\n";
  const rewrittenText = "# Rewritten generated file\nThis file was rewritten later in the same turn.\n";
  notify("item/started", {
    threadId,
    turnId: "fake-turn-1",
    item: {
      id: "call_create_generated",
      type: "fileChange",
      changes: [{
        path: targetPath,
        kind: { type: "add" },
        diff: originalText,
      }],
      status: "inProgress",
    },
  });
  notify("item/completed", {
    threadId,
    turnId: "fake-turn-1",
    item: {
      id: "call_create_generated",
      type: "fileChange",
      changes: [{
        path: targetPath,
        kind: { type: "add" },
        diff: originalText,
      }],
      status: "completed",
    },
  });
  notify("item/started", {
    threadId,
    turnId: "fake-turn-1",
    item: {
      id: "call_rewrite_generated",
      type: "fileChange",
      changes: [{
        path: targetPath,
        kind: { type: "add" },
        diff: rewrittenText,
      }],
      status: "inProgress",
    },
  });
  notify("item/completed", {
    threadId,
    turnId: "fake-turn-1",
    item: {
      id: "call_rewrite_generated",
      type: "fileChange",
      changes: [{
        path: targetPath,
        kind: { type: "add" },
        diff: rewrittenText,
      }],
      status: "completed",
    },
  });
  notify("item/agentMessage/delta", {
    threadId,
    turnId: "fake-turn-1",
    itemId: "agent-message-1",
    delta: "DONE",
  });
  notify("turn/completed", {
    threadId,
    turn: { id: "fake-turn-1", status: "completed" },
  });
}

/**
 * @param {unknown} threadId
 * @param {string} cwd
 */
function notifyRenamePatchFixture(threadId, cwd) {
  const oldPath = `${cwd}/rename-source.md`;
  const newPath = `${cwd}/rename-target.md`;
  const diff = [
    "diff --git a/rename-source.md b/rename-target.md",
    "index 3bd1f0e..34e9a43 100644",
    "--- a/rename-source.md",
    "+++ b/rename-target.md",
    "@@ -1 +1 @@",
    "-Original rename source",
    "+Renamed target content",
    `Moved to: ${newPath}`,
    "",
  ].join("\n");
  const item = {
    id: "rename-patch-1",
    type: "fileChange",
    changes: [{
      path: oldPath,
      kind: { type: "update" },
      diff,
    }],
    status: "completed",
  };

  notify("item/started", {
    threadId,
    turnId: "fake-turn-1",
    item: { ...item, status: "inProgress" },
  });
  notify("item/completed", {
    threadId,
    turnId: "fake-turn-1",
    item,
  });
  notify("turn/completed", {
    threadId,
    turn: { id: "fake-turn-1", status: "completed" },
  });
}

/**
 * @param {unknown} parentThreadId
 * @param {string} cwd
 */
function notifySubagentChildToolsFixture(parentThreadId, cwd) {
  const parentTurnId = "fake-turn-1";
  const childThreadId = "fake-child-thread-1";
  const childTurnId = "fake-child-turn-1";
  const spawnItem = {
    id: "spawn-child-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: parentThreadId,
    receiverThreadIds: [childThreadId],
    prompt: "Child Probe Agent. Run a child tool visibility probe.",
    model: "fake-model",
    reasoningEffort: "none",
    agentsStates: {
      [childThreadId]: { status: "pendingInit", message: null },
    },
  };

  notify("item/started", {
    threadId: parentThreadId,
    turnId: parentTurnId,
    item: { ...spawnItem, status: "inProgress", receiverThreadIds: [], agentsStates: {} },
  });
  notify("item/completed", {
    threadId: parentThreadId,
    turnId: parentTurnId,
    item: spawnItem,
  });
  notify("thread/status/changed", {
    threadId: childThreadId,
    status: { type: "active", activeFlags: [] },
  });
  notify("turn/started", {
    threadId: childThreadId,
    turn: { id: childTurnId, items: [], status: "inProgress" },
  });
  notify("item/started", {
    threadId: childThreadId,
    turnId: childTurnId,
    item: {
      id: "child-command-1",
      type: "commandExecution",
      status: "inProgress",
      command: "/bin/zsh -lc 'echo subagent-child-ok'",
      cwd,
      aggregatedOutput: null,
      commandActions: [],
    },
  });
  notify("item/commandExecution/outputDelta", {
    threadId: childThreadId,
    turnId: childTurnId,
    itemId: "child-command-1",
    delta: "subagent-child-ok\n",
  });
  notify("item/completed", {
    threadId: childThreadId,
    turnId: childTurnId,
    item: {
      id: "child-command-1",
      type: "commandExecution",
      status: "completed",
      command: "/bin/zsh -lc 'echo subagent-child-ok'",
      cwd,
      aggregatedOutput: "subagent-child-ok\n",
      exitCode: 0,
      commandActions: [],
    },
  });
  notify("turn/completed", {
    threadId: childThreadId,
    turn: { id: childTurnId, status: "completed" },
  });
  notify("item/started", {
    threadId: parentThreadId,
    turnId: parentTurnId,
    item: {
      id: "close-child-1",
      type: "collabAgentToolCall",
      tool: "closeAgent",
      status: "inProgress",
      senderThreadId: parentThreadId,
      receiverThreadIds: [childThreadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {},
    },
  });
  notify("item/completed", {
    threadId: parentThreadId,
    turnId: parentTurnId,
    item: {
      id: "close-child-1",
      type: "collabAgentToolCall",
      tool: "closeAgent",
      status: "completed",
      senderThreadId: parentThreadId,
      receiverThreadIds: [childThreadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
      agentsStates: {
        [childThreadId]: {
          status: "completed",
          message: "Child final result.",
        },
      },
    },
  });
  notify("item/agentMessage/delta", {
    threadId: parentThreadId,
    turnId: parentTurnId,
    itemId: "agent-message-1",
    delta: "Parent result.",
  });
  notify("turn/completed", {
    threadId: parentThreadId,
    turn: { id: parentTurnId, status: "completed" },
  });
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
      respond(id, { requiresOpenaiAuth: false, account: fakeAccount });
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
        reasoningEffort: fakeReasoningEffort,
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
        reasoningEffort: fakeReasoningEffort,
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
          defaultReasoningEffort: fakeReasoningEffort,
          supportedReasoningEfforts: fakeSupportedReasoningEfforts,
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
      } else if (firstTextInput(params.input) === "empty-reasoning") {
        notify("item/started", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "reasoning-empty-1",
            type: "reasoning",
            summary: [],
            content: [],
          },
        });
        notify("item/completed", {
          threadId: params.threadId,
          turnId: "fake-turn-1",
          item: {
            id: "reasoning-empty-1",
            type: "reasoning",
            summary: [],
            content: [],
          },
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
      } else if (firstTextInput(params.input) === "delete add rewrite fixture") {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : currentThreadCwd;
        notifyDeleteAddRewriteFixture(params.threadId, cwd);
      } else if (firstTextInput(params.input) === "create then delete add rewrite fixture") {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : currentThreadCwd;
        notifyCreateThenDeleteAddRewriteFixture(params.threadId, cwd);
      } else if (firstTextInput(params.input) === "rename patch fixture") {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : currentThreadCwd;
        notifyRenamePatchFixture(params.threadId, cwd);
      } else if (firstTextInput(params.input) === "subagent child tools") {
        const cwd = typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : currentThreadCwd;
        notifySubagentChildToolsFixture(params.threadId, cwd);
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

const stdin = fs.createReadStream(null, { fd: 0, autoClose: false });

stdin.on("data", (chunk) => {
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
