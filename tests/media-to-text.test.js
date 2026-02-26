import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, createMockLlmServer, withModelsCache } from "./helpers.js";
import { createLlmClient } from "../llm.js";

/** @type {PGlite} */
let db;

before(async () => {
  db = await createTestDb();
});

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
    /** @type {import("openai").default} */
    let llmClient;

    before(async () => {
      mockServer = await createMockLlmServer();
      llmClient = createLlmClient({
        apiKey: "test-key",
        baseURL: mockServer.url,
      });
      const { ensureMediaToTextSchema } = await import(
        "../media-to-text.js"
      );
      await ensureMediaToTextSchema(db);
    });

    after(async () => {
      await mockServer.close();
    });

    afterEach(async () => {
      await db.sql`DELETE FROM media_to_text_cache`;
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
        assert.ok(content[1].text.includes("A photo of a sunset over mountains."));
        assert.ok(content[1].text.includes("[Image description:"));
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
          },
        ];

        const result1 = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );
        assert.ok(result1.messages[0].message_data.content[0].text.includes("Cached image description"));

        // Second call — should use cached value, no new LLM call
        const result2 = await convertUnsupportedMedia(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );
        assert.ok(result2.messages[0].message_data.content[0].text.includes("Cached image description"));
      });
    });

    it("skips unsupported content when no media-to-text model is configured", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );
      const config = (await import("../config.js")).default;

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
          assert.ok(content[1].text.includes("[Unsupported"));

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
        assert.equal(content[0].text, "check this video");
        assert.equal(content[1].type, "text");
        assert.ok(
          content[1].text.includes("A short video showing a person waving"),
          `Should contain translation, got: ${content[1].text}`,
        );
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
        mockServer.addResponses("The receipt shows milk at €1.50");

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
          },
          {
            message_id: 3,
            chat_id: "test",
            sender_id: "user1",
            message_data: {
              role: "user",
              content: [
                { type: "text", text: "how much did I spend on milk?" },
                {
                  type: "image",
                  encoding: "base64",
                  mime_type: "image/png",
                  data: "receiptdata",
                },
              ],
            },
            timestamp: new Date(),
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
        const translationRequest = mockServer.getRequests()[requestsBefore];
        const reqMessages = translationRequest.messages;

        // Should have context messages before the translation prompt
        assert.ok(reqMessages.length > 1, `Should include context, got ${reqMessages.length} messages`);

        // Prior conversation should appear as context
        const allText = JSON.stringify(reqMessages);
        assert.ok(allText.includes("hola que tal"), "Should include prior user message");
        assert.ok(allText.includes("how much did I spend on milk"), "Should include current user text");
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

    it("uses global config.media_to_text_model as fallback", async () => {
      const { convertUnsupportedMedia } = await import(
        "../media-to-text.js"
      );

      // Temporarily set config.media_to_text_model
      const config = (await import("../config.js")).default;
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

          assert.ok(result.messages[0].message_data.content[0].text.includes("Fallback translation"));
        });
      } finally {
        config.media_to_text_model = origContentModel;
      }
    });
  });
});
