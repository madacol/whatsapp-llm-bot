#!/usr/bin/env node
process.stdin.resume();
const keepAlive = setInterval(() => {}, 1 << 30);

const minimalCapabilities = process.argv.includes("--minimal-capabilities");
const modelStateOnly = process.argv.includes("--model-state-only");

/** @type {string | null} */
let sessionId = null;
/** @type {string | null} */
let lastSessionOpenMethod = null;
let nextRequestId = 1000;
/** @type {Map<number, (value: unknown) => void>} */
const pendingRequests = new Map();
/** @type {Record<string, string | boolean>} */
const configSelections = {};

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

/**
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<unknown>}
 */
function request(method, params) {
  const id = nextRequestId;
  nextRequestId += 1;
  send({ id, method, params });
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve);
  });
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
function resolvePendingResponse(message) {
  if (!message || typeof message !== "object" || !("id" in message)) {
    return false;
  }
  const record = /** @type {Record<string, unknown>} */ (message);
  if (typeof record.id !== "number" || "method" in record) {
    return false;
  }
  const resolve = pendingRequests.get(record.id);
  if (!resolve) {
    return false;
  }
  pendingRequests.delete(record.id);
  resolve("result" in record ? record.result : record.error);
  return true;
}

/**
 * @returns {Record<string, unknown>[]}
 */
function buildConfigOptions() {
  if (modelStateOnly) {
    return [];
  }
  return [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: configSelections.model ?? "default",
      options: [
        { value: "default", name: "Default" },
        { value: "model-a", name: "Model A" },
      ],
    },
    {
      type: "select",
      id: "reasoning-effort",
      name: "Reasoning Effort",
      category: "thought_level",
      currentValue: configSelections["reasoning-effort"] ?? "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    {
      type: "boolean",
      id: "fast-mode",
      name: "Fast Mode",
      currentValue: configSelections["fast-mode"] ?? false,
    },
    {
      type: "select",
      id: "mode",
      name: "Mode",
      category: "mode",
      currentValue: configSelections.mode ?? "code",
      options: [
        { value: "code", name: "Code" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}

/**
 * @returns {{ currentModelId: string, availableModels: Array<{ modelId: string, name: string, description: string }> }}
 */
function buildModelState() {
  return {
    currentModelId: configSelections.model && configSelections["reasoning-effort"]
      ? `${configSelections.model}[${configSelections["reasoning-effort"]}]`
      : "model-a[medium]",
    availableModels: [
      { modelId: "model-a[low]", name: "Model A (low)", description: "Model A low effort" },
      { modelId: "model-a[medium]", name: "Model A (medium)", description: "Model A medium effort" },
      { modelId: "model-a[high]", name: "Model A (high)", description: "Model A high effort" },
      { modelId: "model-b[medium]", name: "Model B (medium)", description: "Model B medium effort" },
    ],
  };
}

/**
 * @returns {Record<string, unknown>}
 */
function buildSessionOpenResult() {
  return {
    sessionId,
    configOptions: buildConfigOptions(),
    ...(modelStateOnly ? { models: buildModelState() } : {}),
  };
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleMessage(message) {
  if (resolvePendingResponse(message)) {
    return;
  }
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: minimalCapabilities
          ? {
              loadSession: true,
              sessionCapabilities: {
                list: {},
                close: {},
              },
            }
          : {
              loadSession: true,
              sessionCapabilities: {
                resume: {},
                fork: {},
                steer: {},
              },
              session: {
                fork: {},
              },
              _meta: {
                madabot: {
                  sessionCapabilities: {
                    rollback: {},
                  },
                },
              },
            },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    lastSessionOpenMethod = "session/new";
    sessionId = "mock-session-1";
    send({ id: message.id, result: buildSessionOpenResult() });
    return;
  }
  if (message.method === "session/load") {
    lastSessionOpenMethod = "session/load";
    sessionId = message.params?.sessionId ?? "mock-session-1";
    send({ id: message.id, result: buildSessionOpenResult() });
    return;
  }
  if (message.method === "session/resume") {
    lastSessionOpenMethod = "session/resume";
    sessionId = message.params?.sessionId ?? "mock-session-1";
    send({ id: message.id, result: buildSessionOpenResult() });
    return;
  }
  if (message.method === "session/set_config_option") {
    configSelections[message.params?.configId] = message.params?.value;
    send({ id: message.id, result: { configOptions: buildConfigOptions() } });
    return;
  }
  if (message.method === "session/fork") {
    sessionId = "mock-session-fork";
    send({ id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/rollback") {
    send({ id: message.id, result: { sessionId: message.params?.sessionId, rolledBackTurns: message.params?.numTurns } });
    return;
  }
  if (message.method === "session/prompt") {
    await handlePrompt(message);
    return;
  }
  send({ id: message.id, result: {} });
}

const promptScenarios = [
  { match: "all statuses", handle: handleAllStatusesPrompt },
  { match: "action focused pinned status", handle: handleActionFocusedPinnedStatusPrompt },
  { match: "runtime error status", handle: handleRuntimeErrorStatusPrompt },
  { match: "permission", handle: handlePermissionPrompt },
  { match: "elicitation", handle: handleElicitationPrompt },
  { match: "unknown extension", handle: handleUnknownExtensionPrompt },
  { match: "terminal", handle: handleTerminalPrompt },
  { match: "fs write", handle: handleFsWritePrompt },
  { match: "fs update", handle: handleFsUpdatePrompt },
  { match: "direct write", handle: handleDirectWritePrompt },
  { match: "direct rename", handle: handleDirectRenamePrompt },
  { match: "many snapshot files", handle: handleManySnapshotFilesPrompt },
  { match: "direct delete", handle: handleDirectDeletePrompt },
  { match: "diff only update", handle: handleDiffOnlyUpdatePrompt },
  { match: "diff only add", handle: handleDiffOnlyAddPrompt },
  { match: "diff only delete", handle: handleDiffOnlyDeletePrompt },
  { match: "ignored file change", handle: handleIgnoredFileChangePrompt },
  { match: "mislabel existing add", handle: handleMislabelExistingAddPrompt },
  { match: "old new no diff", handle: handleOldNewNoDiffPrompt },
  { match: "config", handle: handleConfigPrompt },
  { match: "session method", handle: handleSessionMethodPrompt },
];

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleAllStatusesPrompt(message) {
  const sid = sessionId ?? "mock-session-1";
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Inspecting status inputs" },
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "plan",
      entries: [{ content: "Wire pinned status categories", status: "in_progress" }],
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "noise-read-1",
      title: "Read file",
      kind: "read",
      status: "in_progress",
      locations: [{ path: `${process.cwd()}/src/noise.js` }],
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "noise-read-1",
      status: "completed",
      rawOutput: {
        formatted_output: "    1→const ignored = true;",
        exit_code: 0,
      },
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "noise-list-1",
      title: "List files in 'src'",
      kind: "read",
      status: "in_progress",
      locations: [{ path: `${process.cwd()}/src` }],
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "noise-list-1",
      status: "completed",
      rawOutput: {
        formatted_output: "src/noise.js",
        exit_code: 0,
      },
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "model_rerouted",
      fromModel: "model-a",
      toModel: "model-b",
      reason: "capacity",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "config_warning",
      summary: "Config fallback active",
      details: "mock config warning",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "runtime_warning",
      message: "Runtime warning sample",
      details: "mock runtime warning",
    },
  });

  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "perm-all-statuses",
      title: "Run status command",
      status: "pending",
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
    ],
  });
  notifyText(JSON.stringify(permission));

  const response = await request("elicitation/create", {
    sessionId,
    mode: "form",
    message: "Choose a status strategy",
    requestedSchema: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          title: "Status Strategy",
          oneOf: [
            { const: "compact", title: "Compact" },
            { const: "complete", title: "Complete" },
          ],
          default: "complete",
        },
      },
      required: ["strategy"],
    },
  });
  notifyText(JSON.stringify(response));

  const created = /** @type {{ terminalId?: string }} */ (await request("terminal/create", {
    sessionId,
    command: process.execPath,
    args: ["-e", "process.stdout.write('status command ok')"],
    cwd: process.cwd(),
    outputByteLimit: 10000,
  }));
  if (created.terminalId) {
    await request("terminal/wait_for_exit", { sessionId, terminalId: created.terminalId });
    await request("terminal/output", { sessionId, terminalId: created.terminalId });
    await request("terminal/release", { sessionId, terminalId: created.terminalId });
  }

  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "toolu-status-review",
      title: "Review status code",
      kind: "think",
      rawInput: { subagent_type: "reviewer", prompt: "Check the status bar" },
      status: "in_progress",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Status reviewer result." },
      _meta: {
        madabot: {
          subagent: {
            threadId: "toolu-status-review",
            agentNickname: "Reviewer",
          },
        },
      },
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "status-edit-1",
      title: "Edited status.txt",
      status: "completed",
      content: [{ type: "diff", path: "status.txt", oldText: "old", newText: "new" }],
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "usage_update",
      used: 64,
      size: 2048,
      cost: { amount: 0.004, currency: "USD" },
    },
  });
  notifyText("All statuses done.");
  send({
    id: message.id,
    result: {
      sessionId: sid,
      stopReason: "end_turn",
      usage: {
        total_tokens: 64,
        input_tokens: 40,
        output_tokens: 20,
        thought_tokens: 4,
        cached_read_tokens: 6,
        cached_write_tokens: 2,
      },
    },
  });
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleActionFocusedPinnedStatusPrompt(message) {
  const sid = sessionId ?? "mock-session-1";
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "status-search-1",
      title: "Search package.json",
      kind: "search",
      rawInput: { pattern: "smoke|e2e|baileys|whatsapp|pin|pinned|ACP", path: "package.json" },
      status: "in_progress",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "status-search-1",
      status: "completed",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "status-smoke-failed-1",
      title: "Shell",
      rawInput: { command: "pnpm exec node scripts/acp-adapter-smoke.js codex --prompt" },
      status: "in_progress",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "status-smoke-failed-1",
      status: "failed",
      rawOutput: { exit_code: 1, formatted_output: "ACP connection closed" },
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "status-smoke-success-1",
      title: "Shell",
      rawInput: { command: "/bin/zsh -lc 'pnpm exec node scripts/acp-adapter-smoke.js codex --prompt'" },
      status: "in_progress",
    },
  });
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "status-smoke-success-1",
      status: "completed",
      rawOutput: { exit_code: 0, formatted_output: "ok" },
    },
  });
  notifyText("Action-focused status done.");
  send({
    id: message.id,
    result: {
      sessionId: sid,
      stopReason: "end_turn",
      usage: {
        total_tokens: 24,
        input_tokens: 12,
        output_tokens: 8,
        thought_tokens: 4,
      },
    },
  });
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleRuntimeErrorStatusPrompt(message) {
  const sid = sessionId ?? "mock-session-1";
  notify("session/update", {
    sessionId: sid,
    update: {
      sessionUpdate: "runtime_error",
      message: "Runtime error sample",
      details: "mock runtime error",
    },
  });
  notifyText("Runtime error status done.");
  send({
    id: message.id,
    result: {
      sessionId: sid,
      stopReason: "end_turn",
      usage: {
        total_tokens: 12,
        input_tokens: 8,
        output_tokens: 4,
      },
    },
  });
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handlePrompt(message) {
  const prompt = Array.isArray(message.params?.prompt)
    ? message.params.prompt.map((block) => block?.text).filter(Boolean).join("\n")
    : "";
  const scenario = promptScenarios.find((entry) => prompt.includes(entry.match));
  if (scenario) {
    await scenario.handle(message);
    return;
  }
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
      _meta: {
        madabot: {
          subagent: {
            threadId: "toolu-task-1",
            agentNickname: "Reviewer",
          },
        },
      },
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
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handlePermissionPrompt(message) {
  const permission = await request("session/request_permission", {
    sessionId,
    toolCall: {
      toolCallId: "perm-1",
      title: "Sensitive mock operation",
      status: "pending",
    },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject once", kind: "reject_once" },
    ],
  });
  notifyText(JSON.stringify(permission));
  endPrompt(message);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleElicitationPrompt(message) {
  const response = await request("elicitation/create", {
    sessionId,
    mode: "form",
    message: "Choose a migration strategy",
    requestedSchema: {
      type: "object",
      properties: {
        strategy: {
          type: "string",
          title: "Migration Strategy",
          oneOf: [
            { const: "conservative", title: "Conservative" },
            { const: "complete", title: "Complete" },
          ],
          default: "complete",
        },
      },
      required: ["strategy"],
    },
  });
  notifyText(JSON.stringify(response));
  endPrompt(message);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleUnknownExtensionPrompt(message) {
  const response = await request("madabot/unknown", {
    sessionId,
    value: true,
  });
  notifyText(JSON.stringify(response));
  endPrompt(message);
}

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handleTerminalPrompt(message) {
  const created = /** @type {{ terminalId?: string }} */ (await request("terminal/create", {
    sessionId,
    command: process.execPath,
    args: ["-e", "process.stdout.write('terminal ok')"],
    cwd: process.cwd(),
    outputByteLimit: 10000,
  }));
  if (created.terminalId) {
    await request("terminal/wait_for_exit", { sessionId, terminalId: created.terminalId });
    const output = /** @type {{ output?: string }} */ (await request("terminal/output", { sessionId, terminalId: created.terminalId }));
    await request("terminal/release", { sessionId, terminalId: created.terminalId });
    notifyText(output.output ?? "");
  }
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleFsWritePrompt(message) {
  await request("fs/write_text_file", {
    sessionId,
    path: `${process.cwd()}/acp-fs-write.txt`,
    content: "written through acp fs",
  });
  notifyText("fs write done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleFsUpdatePrompt(message) {
  await request("fs/write_text_file", {
    sessionId,
    path: `${process.cwd()}/acp-fs-update.txt`,
    content: "new content through acp fs\n",
  });
  notifyText("fs update done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleDirectWritePrompt(message) {
  await import("node:fs/promises").then((fs) => fs.writeFile(`${process.cwd()}/direct-write.txt`, "direct write", "utf8"));
  notifyText("direct write done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleDirectRenamePrompt(message) {
  try {
    await import("node:fs/promises").then((fs) => fs.rename(`${process.cwd()}/before-rename.txt`, `${process.cwd()}/after-rename.txt`));
  } catch (error) {
    notifyText(`direct rename failed: ${/** @type {{ code?: string }} */ (error).code ?? "unknown"}`);
  }
  notifyText("direct rename done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleManySnapshotFilesPrompt(message) {
  const fs = await import("node:fs/promises");
  await fs.mkdir(`${process.cwd()}/snapshot-burst`, { recursive: true });
  for (let index = 0; index < 30; index += 1) {
    await fs.writeFile(`${process.cwd()}/snapshot-burst/generated-${index}.txt`, `generated ${index}\n`, "utf8");
  }
  notifyText("many snapshot files done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleDirectDeletePrompt(message) {
  await import("node:fs/promises").then((fs) => fs.unlink(`${process.cwd()}/direct-delete.txt`));
  notifyText("direct delete done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleDiffOnlyUpdatePrompt(message) {
  notifyDiff("diff-only-update", "Edited diff-only-update.js", "diff-only-update.js", [
    "--- a/diff-only-update.js",
    "+++ b/diff-only-update.js",
    "@@ -1 +1 @@",
    "-export const value = 1;",
    "+export const value = 2;",
  ].join("\n"));
  notifyText("diff only update done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleDiffOnlyAddPrompt(message) {
  notifyDiff("diff-only-add", "Added diff-only-add.js", "diff-only-add.js", [
    "--- /dev/null",
    "+++ b/diff-only-add.js",
    "@@ -0,0 +1 @@",
    "+export const value = 1;",
  ].join("\n"));
  notifyText("diff only add done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleDiffOnlyDeletePrompt(message) {
  notifyDiff("diff-only-delete", "Deleted diff-only-delete.js", "diff-only-delete.js", [
    "--- a/diff-only-delete.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const value = 1;",
  ].join("\n"));
  notifyText("diff only delete done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleIgnoredFileChangePrompt(message) {
  notifyDiff("ignored-file-change", "Updated ignored auth state", "auth_info_baileys/sender-key-test.json", [
    "--- /dev/null",
    "+++ b/auth_info_baileys/sender-key-test.json",
    "@@ -0,0 +1 @@",
    "+{}",
  ].join("\n"));
  notifyText("ignored file change done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleMislabelExistingAddPrompt(message) {
  const filePath = `${process.cwd()}/existing-mislabel.js`;
  await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "export const value = 2;\n", "utf8"));
  notifyDiff("mislabel-existing-add", `Edit ${filePath}`, filePath, undefined, {
    newText: "export const value = 2;\n",
  });
  notifyText("mislabel existing add done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleOldNewNoDiffPrompt(message) {
  const filePath = `${process.cwd()}/existing-no-diff.js`;
  await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "export const value = 2;\n", "utf8"));
  notifyDiff("old-new-no-diff", `Edit ${filePath}`, filePath, undefined, {
    oldText: "export const value = 1;\n",
    newText: "export const value = 2;\n",
  });
  notifyText("old new no diff done");
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleConfigPrompt(message) {
  notifyText(`model=${configSelections.model ?? "default"} mode=${configSelections.mode ?? "code"} effort=${configSelections["reasoning-effort"] ?? "medium"}`);
  endPrompt(message);
}

/** @param {Record<string, unknown>} message */
async function handleSessionMethodPrompt(message) {
  notifyText(lastSessionOpenMethod ?? "unknown");
  endPrompt(message);
}

/**
 * @param {string} text
 */
function notifyText(text) {
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

/**
 * @param {string} toolCallId
 * @param {string} title
 * @param {string} filePath
 * @param {string | undefined} diff
 * @param {{ oldText?: string, newText?: string }} [text]
 */
function notifyDiff(toolCallId, title, filePath, diff, text = {}) {
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      title,
      status: "completed",
      content: [{
        type: "diff",
        path: filePath,
        ...(diff ? { diff } : {}),
        ...text,
      }],
    },
  });
}

/**
 * @param {Record<string, unknown>} message
 */
function endPrompt(message) {
  send({ id: message.id, result: { sessionId, stopReason: "end_turn" } });
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  while (stdinBuffer.includes("\n")) {
    const newlineIndex = stdinBuffer.indexOf("\n");
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line.trim()) {
      continue;
    }
    const message = JSON.parse(line);
    void handleMessage(message);
  }
});

await new Promise(() => {});
