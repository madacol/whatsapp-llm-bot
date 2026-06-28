import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLlmClient } from "../llm.js";
import { augmentLatestUserMessageForTextHarness } from "../harnesses/prompt-media.js";
import { createMockLlmServer, createTestDb } from "./helpers.js";

/** @type {ChatDb} */
let db;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;
/** @type {LlmClient} */
let llmClient;

before(async () => {
  db = await createTestDb();
  mockServer = await createMockLlmServer();
  llmClient = createLlmClient({
    apiKey: "test-key",
    baseURL: mockServer.url,
  });
});

after(async () => {
  await mockServer.close();
});

afterEach(async () => {
  mockServer.clearRequests();
  await db.sql`DELETE FROM media_to_text_cache`.catch(() => {});
});

describe("prompt media augmentation", () => {
  it("keeps media-to-text context after /clear and drops earlier history", async () => {
    mockServer.addResponses("Audio about the markdown table renderer.");

    /** @type {Message[]} */
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Old context about .git-local and purchase-manager." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "/clear" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Session cleared. Next message starts fresh." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "New context about markdown table image chunks." }],
      },
      {
        role: "user",
        content: [
          {
            type: "audio",
            encoding: "base64",
            mime_type: "audio/mp3",
            data: Buffer.from("audio bytes").toString("base64"),
          },
        ],
      },
    ];

    const augmented = await augmentLatestUserMessageForTextHarness(messages, {
      llmClient,
      mediaToTextModels: { audio: "audio/model" },
    }, db);

    const latest = augmented[augmented.length - 1];
    assert.equal(latest.content.length, 2);
    assert.equal(latest.content[1].type, "text");
    assert.equal(latest.content[1].text, "Audio transcript:\nAudio about the markdown table renderer.");
    assert.equal(latest.content[1].text.includes("[Audio description:"), false);

    const [request] = mockServer.getRequests();
    if (!request || typeof request !== "object" || !("messages" in request)) {
      assert.fail("expected captured LLM request with messages");
    }
    const allText = JSON.stringify(request.messages);
    assert.ok(allText.includes("New context about markdown table image chunks."), "Should keep context after /clear");
    assert.ok(!allText.includes(".git-local"), "Should drop context before /clear");
    assert.ok(!allText.includes("purchase-manager"), "Should drop old context before /clear");
  });
});
