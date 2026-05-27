#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

/** @type {string | null} */
let sessionId = null;
let nextRequestId = 1000;
/** @type {Map<number, (value: unknown) => void>} */
const pendingRequests = new Map();
/** @type {Record<string, string>} */
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
  ];
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
          _meta: {
            madabot: {
              sessionCapabilities: {
                read: {},
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
    sessionId = "mock-session-1";
    send({ id: message.id, result: { sessionId, configOptions: buildConfigOptions() } });
    return;
  }
  if (message.method === "session/load") {
    sessionId = message.params?.sessionId ?? "mock-session-1";
    send({ id: message.id, result: { sessionId, configOptions: buildConfigOptions() } });
    return;
  }
  if (message.method === "session/resume") {
    sessionId = message.params?.sessionId ?? "mock-session-1";
    send({ id: message.id, result: { sessionId, configOptions: buildConfigOptions() } });
    return;
  }
  if (message.method === "session/set_config_option") {
    configSelections[message.params?.configId] = message.params?.value;
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "session/fork") {
    sessionId = "mock-session-fork";
    send({ id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === "session/read") {
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params?.sessionId,
          preview: "Mock thread",
          turns: [{ status: "completed", items: [] }],
        },
      },
    });
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

/**
 * @param {Record<string, unknown>} message
 * @returns {Promise<void>}
 */
async function handlePrompt(message) {
  const prompt = Array.isArray(message.params?.prompt)
    ? message.params.prompt.map((block) => block?.text).filter(Boolean).join("\n")
    : "";
  if (prompt.includes("permission")) {
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
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: JSON.stringify(permission) },
      },
    });
    send({ id: message.id, result: { sessionId, stopReason: "end_turn" } });
    return;
  }
  if (prompt.includes("terminal")) {
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
      notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: output.output ?? "" },
        },
      });
    }
    send({ id: message.id, result: { sessionId, stopReason: "end_turn" } });
    return;
  }
  if (prompt.includes("fs write")) {
    const filePath = `${process.cwd()}/acp-fs-write.txt`;
    await request("fs/write_text_file", {
      sessionId,
      path: filePath,
      content: "written through acp fs",
    });
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fs write done" },
      },
    });
    send({ id: message.id, result: { sessionId, stopReason: "end_turn" } });
    return;
  }
  if (prompt.includes("direct write")) {
    await import("node:fs/promises").then((fs) => fs.writeFile(`${process.cwd()}/direct-write.txt`, "direct write", "utf8"));
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "direct write done" },
      },
    });
    send({ id: message.id, result: { sessionId, stopReason: "end_turn" } });
    return;
  }
  if (prompt.includes("config")) {
    notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `model=${configSelections.model ?? "default"} effort=${configSelections["reasoning-effort"] ?? "medium"}`,
        },
      },
    });
    send({ id: message.id, result: { sessionId, stopReason: "end_turn" } });
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

for await (const line of rl) {
  if (!line.trim()) {
    continue;
  }
  const message = JSON.parse(line);
  void handleMessage(message);
}
