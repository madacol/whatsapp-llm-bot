import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestDb, createMockLlmServer, withModelsCache } from "./helpers.js";
import { createLlmClient } from "../llm.js";
import config from "../config.js";

/** @typedef {import("../store.js").MessageRow} MessageRow */
/** @typedef {{ model?: string, messages: unknown[] }} MockLlmRequest */

/** @type {import("../sqlite-db.js").SqliteDb} */
let db;

before(async () => {
  db = await createTestDb();
});

/**
 * @param {readonly unknown[]} content
 * @param {number} index
 * @returns {TextContentBlock}
 */
function textBlockAt(content, index) {
  const block = content[index];
  assert.ok(block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string", `Expected text block at index ${index}`);
  return /** @type {TextContentBlock} */ (block);
}

/**
 * @param {readonly unknown[]} content
 * @param {number} index
 * @returns {QuoteContentBlock}
 */
function quoteBlockAt(content, index) {
  const block = content[index];
  assert.ok(block && typeof block === "object" && "type" in block && block.type === "quote" && "content" in block && Array.isArray(block.content), `Expected quote block at index ${index}`);
  return /** @type {QuoteContentBlock} */ (block);
}

/**
 * @param {Awaited<ReturnType<typeof createMockLlmServer>>} mockServer
 * @param {number} index
 * @returns {MockLlmRequest}
 */
function mockRequestAt(mockServer, index) {
  const request = mockServer.getRequests()[index];
  assert.ok(request && typeof request === "object", `Expected mock LLM request at index ${index}`);
  assert.ok("messages" in request && Array.isArray(request.messages), `Expected mock LLM request ${index} to include messages`);
  return /** @type {MockLlmRequest} */ (request);
}

describe("media-to-text", () => {
  describe("ensureMediaToTextSchema", () => {
    it("creates the media_to_text_cache table", async () => {
      const { ensureMediaToTextSchema } = await import(
        "../media-to-text.js"
      );
      await ensureMediaToTextSchema(db);

      // Inserting and querying should work
      await db.sql`INSERT INTO media_to_text_cache (content_hash, model_id, translation)
        VALUES ('abc123', 'test/model', 'A test translation')`;
      const {
        rows: [row],
      } = await db.sql`SELECT * FROM media_to_text_cache WHERE content_hash = 'abc123'`;
      assert.equal(row.content_hash, "abc123");
      assert.equal(row.model_id, "test/model");
      assert.equal(row.translation, "A test translation");
    });

    it("is idempotent", async () => {
      const { ensureMediaToTextSchema } = await import(
        "../media-to-text.js"
      );
      await ensureMediaToTextSchema(db);
      await ensureMediaToTextSchema(db);
      // No error thrown
    });
  });

  describe("convertUnsupportedMedia", () => {
    /** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
    let mockServer;
    /** @type {LlmClient} */
    let llmClient;

    before(async () => {
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
      await db.sql`DELETE FROM media_to_text_cache`.catch(() => {});
    });

    it("returns messages unchanged when model supports all modalities", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image", "audio"] },
        },
      ], async () => {
        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "Hello" },
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "abc123",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result = await convertUnsupportedMedia(
          messages,
          "openai/gpt-4o",
          {},
          llmClient,
          db,
        );

        // Should be the exact same reference (no cloning needed)
        assert.equal(result.messages, messages);
        assert.deepEqual(result.skippedTypes, new Set());
      });
    });

    it("translates image content when model only supports text", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "deepseek/deepseek-r1",
          name: "DeepSeek R1",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        mockServer.addResponses("A photo of a sunset over mountains.");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "What is this?" },
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "abc123imagedata",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result = await convertUnsupportedMedia(
          messages,
          "deepseek/deepseek-r1",
          { image: "openai/gpt-4o" },
          llmClient,
          db,
        );

        // Should not be the same reference
        assert.notEqual(result.messages, messages);
        // Original should be untouched
        assert.equal(messages[0].message_data.content[1].type, "image");
        // Translated content has no skipped types
        assert.deepEqual(result.skippedTypes, new Set());

        // Translated message should have text replacement
        const translated = result.messages[0];
        const content = translated.message_data.content;
        assert.equal(content.length, 2);
        assert.equal(content[0].type, "text");
        assert.equal(content[0].text, "What is this?");
        assert.equal(content[1].type, "text");
        assert.equal(content[1].text, "Image description:\nA photo of a sunset over mountains.");
        assert.equal(content[1].text.includes("[Image description:"), false);
      });
    });

    it("sends audio and current user text to the media-to-text model", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "audio/model",
          name: "Audio Model",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "audio"] },
        },
      ], async () => {
        mockServer.addResponses("What time is it?");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "Please inspect this voice note" },
                {
                  type: "audio",
                  encoding: "base64",
                  mime_type: "audio/mp3",
                  data: "abc123audiodata",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const requestsBefore = mockServer.getRequests().length;
        const result = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { audio: "audio/model" },
          llmClient,
          db,
        );

        const translatedAudio = textBlockAt(result.messages[0].message_data.content, 1);
        assert.equal(translatedAudio.text, "Audio transcript:\nWhat time is it?");
        assert.equal(translatedAudio.text.includes("[Audio description:"), false);

        const translationRequest = mockRequestAt(mockServer, requestsBefore);
        const requestText = JSON.stringify(translationRequest.messages);
        assert.ok(requestText.includes("User's message: Please inspect this voice note"));
        assert.ok(requestText.includes("cleaned transcript"));
        assert.ok(requestText.includes("speaker's own words"));
        assert.ok(requestText.includes("Do not rewrite the speech into third-person narration"));
        assert.ok(!requestText.includes("relevant disfluencies"));
        assert.ok(!requestText.includes("nonverbal cues"));
      });
    });

    it("uses cached translation on second call", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      const models = [
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "vision/model",
          name: "Vision",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ];

      await withModelsCache(models, async () => {
        // Only one response in queue — second call must use cache
        mockServer.addResponses("Cached image description");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "samedata",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result1 = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );
        assert.ok(textBlockAt(result1.messages[0].message_data.content, 0).text.includes("Cached image description"));

        // Second call — should use cached value, no new LLM call
        const result2 = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );
        assert.ok(textBlockAt(result2.messages[0].message_data.content, 0).text.includes("Cached image description"));
      });
    });

    it("does not reuse cache entries from the pre-boundary prompt namespace", async () => {
      const { convertUnsupportedMedia, ensureMediaToTextSchema } = await import(
        "../media-to-text.js"
      );

      const models = [
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "vision/model",
          name: "Vision",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ];

      await withModelsCache(models, async () => {
        const imageData = Buffer.from("old-cache-image-data").toString("base64");
        const oldContentHash = createHash("sha256").update(Buffer.from(imageData, "base64")).digest("hex").slice(0, 16);
        await ensureMediaToTextSchema(db);
        await db.sql`INSERT INTO media_to_text_cache (content_hash, model_id, translation)
          VALUES (${oldContentHash}, ${"vision/model"}, ${"Stale pre-boundary description"})`;

        mockServer.addResponses("Fresh post-boundary description");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: imageData,
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );

        const text = textBlockAt(result.messages[0].message_data.content, 0).text;
        assert.ok(text.includes("Fresh post-boundary description"), `Should bypass stale cache entry, got: ${text}`);
        assert.ok(!text.includes("Stale pre-boundary description"));
      });
    });

    it("skips unsupported content when no media-to-text model is configured", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );


      const origContentModel = config.media_to_text_model;
      config.media_to_text_model = "";

      try {
        await withModelsCache([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
        ], async () => {
          /** @type {MessageRow[]} */
          const messages = [
            {
              message_id: 1,
              chat_id: "test",
              sender_id: "user1",
              message_data: {
                role: "user",
                content: [
                  { type: "text", text: "check this" },
                  {
                    type: "image",
                    encoding: "base64",
                    mime_type: "image/png",
                    data: "nomodeldata",
                  },
                ],
              },
              timestamp: new Date(),
              display_key: null,
            },
          ];

          // No media-to-text model configured, no global fallback
          const result = await convertUnsupportedMedia(
            messages,
            "text-only/model",
            {},
            llmClient,
            db,
          );

          // Image block should be replaced with a placeholder
          const content = result.messages[0].message_data.content;
          assert.equal(content.length, 2);
          assert.equal(content[1].type, "text");
          assert.ok(textBlockAt(content, 1).text.includes("[Unsupported"));

          // Should report skipped content types
          assert.deepEqual(result.skippedTypes, new Set(["image"]));
        });
      } finally {
        config.media_to_text_model = origContentModel;
      }
    });

    it("converts video to text description when media-to-text model is configured", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "video-capable/model",
          name: "Video Model",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "video"] },
        },
      ], async () => {
        mockServer.addResponses("A short video showing a person waving");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "check this video" },
                {
                  type: "video",
                  encoding: "base64",
                  mime_type: "video/mp4",
                  data: "fakevideo",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { video: "video-capable/model" },
          llmClient,
          db,
        );

        const content = result.messages[0].message_data.content;
        assert.equal(content.length, 2);
        assert.equal(textBlockAt(content, 0).text, "check this video");
        assert.equal(content[1].type, "text");
        assert.equal(textBlockAt(content, 1).text, "Video description:\nA short video showing a person waving");
        assert.equal(textBlockAt(content, 1).text.includes("[Video description:"), false);
        assert.deepEqual(result.skippedTypes, new Set());
      });
    });

    it("includes conversation context in media-to-text prompt", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "vision/model",
          name: "Vision",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        mockServer.addResponses("The label shows milk at €1.50");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [{ type: "text", text: "hola que tal" }],
            },
            timestamp: new Date(),
            display_key: null,
          },
          {
            message_id: 2,
            chat_id: "test",
            sender_id: "assistant",
            message_data: {
              role: "assistant",
              content: [{ type: "text", text: "Hola! Todo bien, y tu?" }],
            },
            timestamp: new Date(),
            display_key: null,
          },
          {
            message_id: 3,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "what does the label say about milk?" },
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "labeldata",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const requestsBefore = mockServer.getRequests().length;
        await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );

        // Check the LLM request included conversation context
        const translationRequest = mockRequestAt(mockServer, requestsBefore);
        const reqMessages = translationRequest.messages;

        // Should have context messages before the translation prompt
        assert.ok(reqMessages.length > 1, `Should include context, got ${reqMessages.length} messages`);

        // Prior conversation should appear as context
        const allText = JSON.stringify(reqMessages);
        assert.ok(allText.includes("hola que tal"), "Should include prior user message");
        assert.ok(allText.includes("what does the label say about milk"), "Should include current user text");
      });
    });

    it("does not include media-to-text context before a clear command", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "vision/model",
          name: "Vision",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        mockServer.addResponses("Fresh table screenshot description");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [{ type: "text", text: "Old context about .git-local and purchase-manager." }],
            },
            timestamp: new Date(),
            display_key: null,
          },
          {
            message_id: 2,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [{ type: "text", text: "/clear" }],
            },
            timestamp: new Date(),
            display_key: null,
          },
          {
            message_id: 3,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [{ type: "text", text: "New context about markdown table rendering." }],
            },
            timestamp: new Date(),
            display_key: null,
          },
          {
            message_id: 4,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "What does this screenshot show?" },
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "table-screenshot-data",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const requestsBefore = mockServer.getRequests().length;
        await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );

        const translationRequest = mockRequestAt(mockServer, requestsBefore);
        const allText = JSON.stringify(translationRequest.messages);
        assert.ok(allText.includes("New context about markdown table rendering."), "Should keep context after /clear");
        assert.ok(allText.includes("What does this screenshot show?"), "Should include current user text");
        assert.ok(!allText.includes(".git-local"), "Should drop context before /clear");
        assert.ok(!allText.includes("purchase-manager"), "Should drop old context before /clear");
      });
    });

    it("leaves assistant and tool messages untouched", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
      ], async () => {
        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "assistant",
              content: [{ type: "text", text: "I am an assistant" }],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          {},
          llmClient,
          db,
        );

        assert.equal(result.messages, messages);
      });
    });

    it("uses general chat media-to-text model when no per-type model is set", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "vision/model",
          name: "Vision",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        mockServer.addResponses("General model translation");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "generalmodeldata",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        // No per-type model, only general
        const result = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { general: "vision/model" },
          llmClient,
          db,
        );

        assert.ok(textBlockAt(result.messages[0].message_data.content, 0).text.includes("General model translation"));
        assert.deepEqual(result.skippedTypes, new Set());
      });
    });

    it("per-type model takes priority over general chat model", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "text-only/model",
          name: "Text Only",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "general/model",
          name: "General",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
        {
          id: "specific/model",
          name: "Specific",
          context_length: 4096,
          pricing: { prompt: "0.000001", completion: "0.000001" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        mockServer.addResponses("Specific model translation");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "prioritydata",
                },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const requestsBefore = mockServer.getRequests().length;
        const result = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { general: "general/model", image: "specific/model" },
          llmClient,
          db,
        );

        assert.ok(textBlockAt(result.messages[0].message_data.content, 0).text.includes("Specific model translation"));

        // Verify the LLM request used the specific model
        const translationRequest = mockRequestAt(mockServer, requestsBefore);
        assert.equal(translationRequest.model, "specific/model");
      });
    });

    it("uses per-type env var when no chat setting is set", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );


      const origImageModel = config.image_to_text_model;
      const origMediaModel = config.media_to_text_model;
      config.image_to_text_model = "env-image/model";
      config.media_to_text_model = "";

      try {
        await withModelsCache([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
          {
            id: "env-image/model",
            name: "Env Image",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text", "image"] },
          },
        ], async () => {
          mockServer.addResponses("Env image model translation");

          /** @type {MessageRow[]} */
          const messages = [
            {
              message_id: 1,
              chat_id: "test",
              sender_id: "user1",
              message_data: {
                role: "user",
                content: [
                  {
                    type: "image",
                    encoding: "base64",
                    mime_type: "image/png",
                    data: "envimagedata",
                  },
                ],
              },
              timestamp: new Date(),
              display_key: null,
            },
          ];

          const result = await convertUnsupportedMedia(
            messages,
            "text-only/model",
            {},
            llmClient,
            db,
          );

          assert.ok(textBlockAt(result.messages[0].message_data.content, 0).text.includes("Env image model translation"));
        });
      } finally {
        config.image_to_text_model = origImageModel;
        config.media_to_text_model = origMediaModel;
      }
    });

    it("per-type env var takes priority over general env var", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );


      const origImageModel = config.image_to_text_model;
      const origMediaModel = config.media_to_text_model;
      config.image_to_text_model = "env-image/model";
      config.media_to_text_model = "general-env/model";

      try {
        await withModelsCache([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
          {
            id: "env-image/model",
            name: "Env Image",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text", "image"] },
          },
          {
            id: "general-env/model",
            name: "General Env",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text", "image"] },
          },
        ], async () => {
          mockServer.addResponses("Env image specific translation");

          /** @type {MessageRow[]} */
          const messages = [
            {
              message_id: 1,
              chat_id: "test",
              sender_id: "user1",
              message_data: {
                role: "user",
                content: [
                  {
                    type: "image",
                    encoding: "base64",
                    mime_type: "image/png",
                    data: "envprioritydata",
                  },
                ],
              },
              timestamp: new Date(),
              display_key: null,
            },
          ];

          const requestsBefore = mockServer.getRequests().length;
          const result = await convertUnsupportedMedia(
            messages,
            "text-only/model",
            {},
            llmClient,
            db,
          );

          assert.ok(textBlockAt(result.messages[0].message_data.content, 0).text.includes("Env image specific translation"));

          // Verify the LLM request used the per-type env var model
          const translationRequest = mockRequestAt(mockServer, requestsBefore);
          assert.equal(translationRequest.model, "env-image/model");
        });
      } finally {
        config.image_to_text_model = origImageModel;
        config.media_to_text_model = origMediaModel;
      }
    });

    it("uses global config.media_to_text_model as fallback", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      // Temporarily set config.media_to_text_model

      const origContentModel = config.media_to_text_model;
      config.media_to_text_model = "fallback/model";

      try {
        await withModelsCache([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
          {
            id: "fallback/model",
            name: "Fallback",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text", "image"] },
          },
        ], async () => {
          mockServer.addResponses("Fallback translation");

          /** @type {MessageRow[]} */
          const messages = [
            {
              message_id: 1,
              chat_id: "test",
              sender_id: "user1",
              message_data: {
                role: "user",
                content: [
                  {
                    type: "image",
                    encoding: "base64",
                    mime_type: "image/png",
                    data: "fallbackdata",
                  },
                ],
              },
              timestamp: new Date(),
              display_key: null,
            },
          ];

          // No per-chat media_to_text_models, but global fallback is set
          const result = await convertUnsupportedMedia(
            messages,
            "text-only/model",
            {},
            llmClient,
            db,
          );

          assert.ok(textBlockAt(result.messages[0].message_data.content, 0).text.includes("Fallback translation"));
        });
      } finally {
        config.media_to_text_model = origContentModel;
      }
    });

    it("translates images nested inside quote blocks", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      await withModelsCache([
        {
          id: "deepseek/deepseek-r1",
          name: "DeepSeek R1",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text"] },
        },
        {
          id: "openai/gpt-4o",
          name: "GPT-4o",
          context_length: 128000,
          pricing: { prompt: "0.000005", completion: "0.000015" },
          architecture: { input_modalities: ["text", "image"] },
        },
      ], async () => {
        mockServer.addResponses("A screenshot of code showing echo commands.");

        /** @type {MessageRow[]} */
        const messages = [
          {
            message_id: 1,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                {
                  type: "quote",
                  quotedSenderId: "bot123",
                  content: [
                    { type: "text", text: "Edit tool-display.js" },
                    {
                      type: "image",
                      encoding: "base64",
                      mime_type: "image/png",
                      data: "quotedImageData123",
                    },
                  ],
                },
                { type: "text", text: "can u see this image?" },
              ],
            },
            timestamp: new Date(),
            display_key: null,
          },
        ];

        const result = await convertUnsupportedMedia(
          messages,
          "deepseek/deepseek-r1",
          { image: "openai/gpt-4o" },
          llmClient,
          db,
        );

        // Should not be the same reference
        assert.notEqual(result.messages, messages);
        // Original quote should still have the image block
        assert.equal(quoteBlockAt(messages[0].message_data.content, 0).content[1].type, "image");

        // Translated message should have text replacement inside the quote
        const translated = result.messages[0];
        const quoteBlock = quoteBlockAt(translated.message_data.content, 0);
        assert.equal(quoteBlock.content.length, 2);
        assert.equal(quoteBlock.content[0].type, "text");
        assert.equal(textBlockAt(quoteBlock.content, 0).text, "Edit tool-display.js");
        assert.equal(quoteBlock.content[1].type, "text");
        assert.equal(textBlockAt(quoteBlock.content, 1).text, "Image description:\nA screenshot of code showing echo commands.");
        assert.equal(textBlockAt(quoteBlock.content, 1).text.includes("[Image description:"), false);

        // The text after the quote should be untouched
        assert.equal(translated.message_data.content[1].type, "text");
        assert.equal(textBlockAt(translated.message_data.content, 1).text, "can u see this image?");
      });
    });
  });
});
