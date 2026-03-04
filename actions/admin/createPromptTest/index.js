import fs from "fs/promises";
import path from "path";

import config from "../../../config.js";
import {
  actionsToToolDefinitions,
  isMediaBlock,
  registerMedia,
} from "../../../message-formatting.js";
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
 * @returns {{ messages: CallLlmMessage[] } | { error: string }}
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

  return { messages: /** @type {CallLlmMessage[]} */ (parsed) };
}

/**
 * Reconstruct the media registry from DB messages, matching
 * how prepareMessages() counts media blocks.
 * @param {PGlite} rootDb
 * @param {string} chatId
 * @returns {Promise<MediaRegistry>}
 */
async function reconstructMediaRegistry(rootDb, chatId) {
  const { rows } = await rootDb.sql`
    SELECT message_data FROM messages
    WHERE chat_id = ${chatId} AND cleared_at IS NULL
    ORDER BY timestamp ASC
  `;

  /** @type {MediaRegistry} */
  const registry = new Map();

  for (const row of rows) {
    const msg = /** @type {Message} */ (row.message_data);
    if (!msg) continue;

    if (msg.role === "user") {
      for (const block of msg.content) {
        if (isMediaBlock(block)) {
          registerMedia(registry, block);
        } else if (block.type === "quote") {
          for (const quoteBlock of block.content) {
            if (isMediaBlock(quoteBlock)) {
              registerMedia(registry, quoteBlock);
            }
          }
        }
      }
    } else if (msg.role === "tool") {
      for (const block of msg.content) {
        if (isMediaBlock(block)) {
          registerMedia(registry, block);
        }
      }
    }
  }

  return registry;
}

/**
 * Get file extension from a MIME type.
 * @param {string} mimeType
 * @returns {string}
 */
function extFromMime(mimeType) {
  const map = /** @type {Record<string, string>} */ ({
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
  });
  return map[mimeType] || mimeType.split("/")[1] || "bin";
}

/**
 * Build messages for inline LLM verification using base64 data from the media registry.
 * @param {CallLlmMessage[]} originalMessages - Original messages with media_ref markers
 * @param {MediaRegistry} mediaRegistry
 * @returns {CallLlmMessage[]}
 */
function buildVerificationMessages(originalMessages, mediaRegistry) {
  return originalMessages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    /** @type {ContentBlock[]} */
    const content = msg.content.map((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        block.type === "image" &&
        "media_ref" in block
      ) {
        const mediaId = /** @type {number} */ (/** @type {Record<string, unknown>} */ (block).media_ref);
        const mediaBlock = mediaRegistry.get(mediaId);
        if (mediaBlock && "data" in mediaBlock && typeof mediaBlock.data === "string") {
          const mimeType =
            "mime_type" in mediaBlock && typeof mediaBlock.mime_type === "string"
              ? mediaBlock.mime_type
              : "image/jpeg";
          return /** @type {ImageContentBlock} */ ({
            type: "image",
            encoding: "base64",
            mime_type: mimeType,
            data: mediaBlock.data,
          });
        }
      }
      return /** @type {ContentBlock} */ (block);
    });

    return /** @type {CallLlmMessage} */ ({ ...msg, content });
  });
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
 * Build the fixture-ref messages for the JSON file (with fixture references instead of base64 data).
 * @param {CallLlmMessage[]} originalMessages - Messages with media_ref markers
 * @param {MediaRegistry} mediaRegistry
 * @param {string} testName
 * @returns {{ messages: Array<Record<string, unknown>>, fixtures: Array<{path: string, data: Buffer}>, warnings: string[] }}
 */
function buildTestCaseMessages(originalMessages, mediaRegistry, testName) {
  /** @type {Array<{path: string, data: Buffer}>} */
  const fixtures = [];
  /** @type {string[]} */
  const warnings = [];

  const messages = originalMessages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;

    const content = msg.content.map((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        block.type === "image" &&
        "media_ref" in block
      ) {
        const mediaId = /** @type {number} */ (/** @type {Record<string, unknown>} */ (block).media_ref);
        const mediaBlock = mediaRegistry.get(mediaId);

        if (!mediaBlock) {
          warnings.push(`Could not find [media:${mediaId}]. Add fixture manually.`);
          return block;
        }

        const mimeType =
          "mime_type" in mediaBlock && typeof mediaBlock.mime_type === "string"
            ? mediaBlock.mime_type
            : "image/jpeg";
        const ext = extFromMime(mimeType);
        const fixtureName = `${testName}-media${mediaId}.${ext}`;

        if ("data" in mediaBlock && typeof mediaBlock.data === "string") {
          fixtures.push({
            path: path.join(fixturesDir, fixtureName),
            data: Buffer.from(mediaBlock.data, "base64"),
          });
        }

        return { type: "image", fixture: fixtureName, mime_type: mimeType };
      }
      return block;
    });

    return { ...msg, content };
  });

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
          'JSON array of CallLlmMessage[] — the test scenario paraphrased from conversation. For media, use {"type":"image","media_ref":N} referencing [media:N] tags.',
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

    // Step 4: Resolve media refs
    const hasMediaRefs = JSON.stringify(messages).includes('"media_ref"');

    /** @type {Array<{path: string, data: Buffer}>} */
    let fixtureFiles = [];
    /** @type {string[]} */
    let mediaWarnings = [];
    /** @type {CallLlmMessage[]} */
    let messagesForLlm = messages;
    /** @type {Array<Record<string, unknown>>} */
    let testCaseMessages = messages;

    if (hasMediaRefs) {
      const mediaRegistry = await reconstructMediaRegistry(rootDb, chatId);

      // Build fixture-ref messages for the JSON file
      const testCaseResult = buildTestCaseMessages(messages, mediaRegistry, params.test_name);
      testCaseMessages = testCaseResult.messages;
      fixtureFiles = testCaseResult.fixtures;
      mediaWarnings = testCaseResult.warnings;

      // Build base64 messages for inline verification
      messagesForLlm = buildVerificationMessages(messages, mediaRegistry);
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
