import fs from "node:fs/promises";
import path from "node:path";

import { isValidMediaPath, mediaPathToMimeType } from "../../../attachment-paths.js";
import config from "../../../config.js";
import {
  createImageBlockFromPath,
  readBlockBase64,
  readBlockBuffer,
} from "../../../media-store.js";
import { actionsToToolDefinitions } from "../../../message-formatting.js";
import { checkAssertion } from "../../../tests/prompt-regressions/assertions.js";

/** @typedef {import("../../../tests/prompt-regressions/assertions.js").TestAssertion} TestAssertion */

const VALID_ASSERTION_TYPES = /** @type {const} */ ([
  "tool_call",
  "no_tool_call",
  "contains",
  "not_contains",
  "llm_judge",
]);

const regressionsDir = path.resolve(
  process.cwd(),
  "tests",
  "prompt-regressions",
);
const fixturesDir = path.join(regressionsDir, "fixtures");

/**
 * Parse and validate the assertion JSON.
 * @param {string} assertionJson
 * @returns {{ assertion: TestAssertion } | { error: string }}
 */
function parseAssertion(assertionJson) {
  /** @type {Record<string, unknown>} */
  let parsed;
  try {
    parsed = JSON.parse(assertionJson);
  } catch (e) {
    return { error: `Invalid assertion JSON: ${e instanceof Error ? e.message : e}` };
  }

  const type = parsed.type;
  if (typeof type !== "string" || !VALID_ASSERTION_TYPES.includes(/** @type {typeof VALID_ASSERTION_TYPES[number]} */ (type))) {
    return {
      error: `Invalid assertion type "${type}". Must be one of: ${VALID_ASSERTION_TYPES.join(", ")}`,
    };
  }

  if ((type === "tool_call" || type === "no_tool_call") && typeof parsed.tool_name !== "string") {
    return { error: `Assertion type "${type}" requires a "tool_name" string field` };
  }
  if ((type === "contains" || type === "not_contains") && typeof parsed.value !== "string") {
    return { error: `Assertion type "${type}" requires a "value" string field` };
  }
  if (type === "llm_judge" && typeof parsed.criteria !== "string") {
    return { error: `Assertion type "llm_judge" requires a "criteria" string field` };
  }

  return { assertion: /** @type {TestAssertion} */ (parsed) };
}

/**
 * Parse and validate the messages JSON.
 * @param {string} messagesJson
 * @returns {{ messages: ChatMessage[] } | { error: string }}
 */
function parseMessages(messagesJson) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(messagesJson);
  } catch (e) {
    return { error: `Invalid messages JSON: ${e instanceof Error ? e.message : e}` };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "messages must be a non-empty JSON array" };
  }

  for (let i = 0; i < parsed.length; i++) {
    const msg = parsed[i];
    if (typeof msg !== "object" || msg === null || !("role" in msg) || !("content" in msg)) {
      return { error: `messages[${i}] must have "role" and "content" fields` };
    }
  }

  return { messages: /** @type {ChatMessage[]} */ (parsed) };
}

/**
 * @param {unknown} block
 * @returns {block is { type: "image" | "audio" | "video", path: string, mime_type?: string }}
 */
function isPathMediaBlock(block) {
  return !!block
    && typeof block === "object"
    && "type" in block
    && "path" in block
    && (block.type === "image" || block.type === "audio" || block.type === "video")
    && typeof block.path === "string"
    && isValidMediaPath(block.path);
}

/**
 * @param {{ type: "image" | "audio" | "video", path: string, mime_type?: string }} block
 * @returns {ImageContentBlock | VideoContentBlock | AudioContentBlock}
 */
function createStoredMediaBlock(block) {
  if (block.type === "image") {
    return createImageBlockFromPath(block.path);
  }
  if (block.type === "video") {
    return {
      type: "video",
      path: block.path,
      mime_type: mediaPathToMimeType(block.path, block.mime_type),
    };
  }
  return {
    type: "audio",
    path: block.path,
    mime_type: mediaPathToMimeType(block.path, block.mime_type),
  };
}

/**
 * @param {ChatMessage[]} messages
 * @returns {boolean}
 */
function hasPathMedia(messages) {
  return messages.some((msg) =>
    Array.isArray(msg.content) && msg.content.some((block) => isPathMediaBlock(block))
  );
}

/**
 * Build messages for inline LLM verification using base64 data from media paths.
 * @param {ChatMessage[]} originalMessages
 * @returns {Promise<ChatMessage[]>}
 */
async function buildVerificationMessages(originalMessages) {
  return Promise.all(originalMessages.map(async (msg) => {
    if (!Array.isArray(msg.content)) return msg;

    /** @type {ContentBlock[]} */
    const content = await Promise.all(msg.content.map(async (block) => {
      if (isPathMediaBlock(block)) {
        if (block.type === "image") {
          const imageBlock = createImageBlockFromPath(block.path);
          return {
            type: "image",
            encoding: "base64",
            mime_type: imageBlock.mime_type,
            data: await readBlockBase64(imageBlock),
          };
        }
        if (block.type === "video") {
          const videoBlock = /** @type {VideoContentBlock} */ ({
            type: "video",
            path: block.path,
            mime_type: mediaPathToMimeType(block.path, block.mime_type),
          });
          return {
            type: "video",
            encoding: "base64",
            mime_type: videoBlock.mime_type,
            data: await readBlockBase64(videoBlock),
          };
        }
        const audioBlock = /** @type {AudioContentBlock} */ ({
          type: "audio",
          path: block.path,
          mime_type: mediaPathToMimeType(block.path, block.mime_type),
        });
        return {
          type: "audio",
          encoding: "base64",
          mime_type: audioBlock.mime_type,
          data: await readBlockBase64(audioBlock),
        };
      }
      return /** @type {ContentBlock} */ (block);
    }));

    return /** @type {ChatMessage} */ ({ ...msg, content });
  }));
}

/**
 * Format a human-readable description of an assertion.
 * @param {TestAssertion} assertion
 * @returns {string}
 */
function formatAssertionDesc(assertion) {
  switch (assertion.type) {
    case "tool_call":
      return `bot must call ${assertion.tool_name}`;
    case "no_tool_call":
      return `bot must NOT call ${assertion.tool_name}`;
    case "contains":
      return `response must contain "${assertion.value}"`;
    case "not_contains":
      return `response must NOT contain "${assertion.value}"`;
    case "llm_judge":
      return `LLM judge: ${assertion.criteria}`;
    default: {
      const _exhaustive = /** @type {never} */ (assertion);
      throw new Error(`Unknown assertion type: ${/** @type {{type:string}} */ (_exhaustive).type}`);
    }
  }
}

/**
 * Build the fixture-ref messages for the JSON file (with fixture references instead of media paths).
 * @param {ChatMessage[]} originalMessages
 * @returns {Promise<{ messages: Array<Record<string, unknown>>, fixtures: Array<{path: string, data: Buffer}>, warnings: string[] }>}
 */
async function buildTestCaseMessages(originalMessages) {
  /** @type {Array<{path: string, data: Buffer}>} */
  const fixtures = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Set<string>} */
  const seenFixtures = new Set();

  const messages = await Promise.all(originalMessages.map(async (msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const content = await Promise.all(msg.content.map(async (block) => {
      if (isPathMediaBlock(block)) {
        const storedBlock = createStoredMediaBlock(block);
        const fixtureName = block.path;
        if (!seenFixtures.has(fixtureName)) {
          fixtures.push({
            path: path.join(fixturesDir, fixtureName),
            data: await readBlockBuffer(storedBlock),
          });
          seenFixtures.add(fixtureName);
        }
        return { type: block.type, fixture: fixtureName, mime_type: storedBlock.mime_type };
      }
      return block;
    }));

    return { ...msg, content };
  }));

  return { messages, fixtures, warnings };
}

export default /** @type {defineAction} */ ((x) => x)({
  name: "create_prompt_test",
  description:
    "Create a prompt regression test from the current conversation. Use when user says to create a test after correcting a bot mistake. The test captures the scenario and verifies the bug exists.",
  parameters: {
    type: "object",
    properties: {
      test_name: {
        type: "string",
        description:
          "Kebab-case descriptive name for the test (e.g. 'should-call-extract-for-receipt')",
      },
      description: {
        type: "string",
        description:
          "What the test verifies: what went wrong and expected behavior",
      },
      messages: {
        type: "string",
        description:
          'JSON array of ChatMessage[]. User: {"role":"user","content":[{"type":"text","text":"..."}]}. Assistant text: {"role":"assistant","content":[{"type":"text","text":"..."}]}. Assistant tool call: {"role":"assistant","content":[{"type":"tool","tool_id":"call_1","name":"fn","arguments":"{}"}]}. Tool result: {"role":"tool","tool_id":"call_1","content":[{"type":"text","text":"result"}]}. For media: {"type":"image","path":"<sha>.<ext>"}.',
      },
      assertion: {
        type: "string",
        description:
          'JSON assertion object. Types: {"type":"tool_call","tool_name":"X"}, {"type":"no_tool_call","tool_name":"X"}, {"type":"contains","value":"text"}, {"type":"not_contains","value":"text"}, {"type":"llm_judge","criteria":"..."}',
      },
    },
    required: ["test_name", "description", "messages", "assertion"],
  },
  formatToolCall: ({ test_name }) =>
    `Creating prompt regression test: ${test_name}`,
  permissions: {
    autoExecute: true,
    autoContinue: true,
    useRootDb: true,
    useLlm: true,
    requireMaster: true,
  },
  /**
   * @param {ExtendedActionContext<{ useRootDb: true, useLlm: true, requireMaster: true, autoExecute: true, autoContinue: true }>} context
   * @param {{ test_name: string, description: string, messages: string, assertion: string }} params
   */
  action_fn: async function (context, params) {
    const { chatId, rootDb, callLlm, confirm, log } = context;

    // Step 2: Parse and validate parameters
    const assertionResult = parseAssertion(params.assertion);
    if ("error" in assertionResult) return assertionResult.error;
    const assertion = assertionResult.assertion;

    const messagesResult = parseMessages(params.messages);
    if ("error" in messagesResult) return messagesResult.error;
    let messages = messagesResult.messages;

    // Step 3: Resolve system prompt
    if (messages[0]?.role !== "system") {
      /** @type {string} */
      let systemPrompt = config.system_prompt;
      try {
        const { rows } = await rootDb.sql`
          SELECT system_prompt FROM chats WHERE chat_id = ${chatId}
        `;
        if (rows[0]?.system_prompt) {
          systemPrompt = /** @type {string} */ (rows[0].system_prompt);
        }
      } catch {
        // fall through to config default
      }
      messages = [
        { role: /** @type {const} */ ("system"), content: systemPrompt },
        ...messages,
      ];
    }

    // Step 4: Resolve media paths
    const hasMediaPaths = hasPathMedia(messages);

    /** @type {Array<{path: string, data: Buffer}>} */
    let fixtureFiles = [];
    /** @type {string[]} */
    let mediaWarnings = [];
    /** @type {ChatMessage[]} */
    let messagesForLlm = messages;
    /** @type {Array<Record<string, unknown>>} */
    let testCaseMessages = messages;

    if (hasMediaPaths) {
      // Build fixture-ref messages for the JSON file
      const testCaseResult = await buildTestCaseMessages(messages);
      testCaseMessages = testCaseResult.messages;
      fixtureFiles = testCaseResult.fixtures;
      mediaWarnings = testCaseResult.warnings;

      // Build inline media messages for inline verification
      messagesForLlm = await buildVerificationMessages(messages);
    }

    // Step 5: Get tool definitions
    const allActions = await context.getActions();
    const tools = actionsToToolDefinitions(allActions);
    const toolNames = allActions.map((a) => a.name);

    // Step 6: Run test inline to verify assertion FAILS
    await log("Running inline verification...");
    const response = await callLlm({
      messages: messagesForLlm,
      tools,
      tool_choice: "auto",
    });

    const assertionCheck = await checkAssertion(assertion, response, callLlm);

    if (assertionCheck.passed) {
      // LLM got it right — warn user
      const confirmed = await confirm(
        "The bot got it right this time (LLMs are non-deterministic). Save test anyway?\n\nReact 👍 to save or 👎 to cancel.",
      );
      if (!confirmed) {
        return "Test creation cancelled — bot didn't reproduce the bug.";
      }
    }

    // Step 7: Write test case JSON and fixtures
    await fs.mkdir(regressionsDir, { recursive: true });
    await fs.mkdir(fixturesDir, { recursive: true });

    // Write fixture files
    for (const fixture of fixtureFiles) {
      await fs.writeFile(fixture.path, fixture.data);
    }

    // System prompt is the first message (always present after step 3)
    const systemPromptContent = messages[0].role === "system" ? messages[0].content : config.system_prompt;

    const testCase = {
      name: params.test_name,
      description: params.description,
      created_at: new Date().toISOString(),
      system_prompt: systemPromptContent,
      messages: testCaseMessages.filter((m) => m.role !== "system"),
      tools: toolNames,
      assertions: [assertion],
    };

    const testPath = path.join(regressionsDir, `${params.test_name}.json`);
    await fs.writeFile(testPath, JSON.stringify(testCase, null, 2) + "\n");

    // Step 8: Return result
    const assertionDesc = formatAssertionDesc(assertion);
    const verifyStatus = assertionCheck.passed
      ? "⚠️ WARNING: passed (non-deterministic)"
      : "verified FAILING ✓";

    let result = `✅ Test created: tests/prompt-regressions/${params.test_name}.json\nAssertion: ${assertionDesc} — ${verifyStatus}`;

    if (fixtureFiles.length > 0) {
      result += `\nFixtures: ${fixtureFiles.map((f) => path.basename(f.path)).join(", ")}`;
    }

    for (const warning of mediaWarnings) {
      result += `\n⚠️ ${warning}`;
    }

    result +=
      "\n\nSuggested fix: I can save a memory to remember this pattern. Want me to do that?";

    return result;
  },
});
