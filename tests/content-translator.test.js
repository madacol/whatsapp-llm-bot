import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, createMockLlmServer } from "./helpers.js";
import { createLlmClient } from "../llm.js";

/** @type {PGlite} */
let db;

before(async () => {
  db = await createTestDb();
});

describe("content-translator", () => {
  describe("ensureTranslationSchema", () => {
    it("creates the content_translations table", async () => {
      const { ensureTranslationSchema } = await import(
        "../content-translator.js"
      );
      await ensureTranslationSchema(db);

      // Inserting and querying should work
      await db.sql`INSERT INTO content_translations (content_hash, model_id, translation)
        VALUES ('abc123', 'test/model', 'A test translation')`;
      const {
        rows: [row],
      } = await db.sql`SELECT * FROM content_translations WHERE content_hash = 'abc123'`;
      assert.equal(row.content_hash, "abc123");
      assert.equal(row.model_id, "test/model");
      assert.equal(row.translation, "A test translation");
    });

    it("is idempotent", async () => {
      const { ensureTranslationSchema } = await import(
        "../content-translator.js"
      );
      await ensureTranslationSchema(db);
      await ensureTranslationSchema(db);
      // No error thrown
    });
  });

  describe("translateUnsupportedContent", () => {
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
      const { ensureTranslationSchema } = await import(
        "../content-translator.js"
      );
      await ensureTranslationSchema(db);
    });

    after(async () => {
      await mockServer.close();
    });

    afterEach(async () => {
      await db.sql`DELETE FROM content_translations`;
    });

    it("returns messages unchanged when model supports all modalities", async () => {
      const { translateUnsupportedContent } = await import(
        "../content-translator.js"
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            context_length: 128000,
            pricing: { prompt: "0.000005", completion: "0.000015" },
            architecture: { input_modalities: ["text", "image", "audio"] },
          },
        ]),
      );

      try {
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

        const result = await translateUnsupportedContent(
          messages,
          "openai/gpt-4o",
          {},
          llmClient,
          db,
        );

        // Should be the exact same reference (no cloning needed)
        assert.equal(result, messages);
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    });

    it("translates image content when model only supports text", async () => {
      const { translateUnsupportedContent } = await import(
        "../content-translator.js"
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
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
        ]),
      );

      mockServer.addResponses("A photo of a sunset over mountains.");

      try {
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

        const result = await translateUnsupportedContent(
          messages,
          "deepseek/deepseek-r1",
          { image: "openai/gpt-4o" },
          llmClient,
          db,
        );

        // Should not be the same reference
        assert.notEqual(result, messages);
        // Original should be untouched
        assert.equal(messages[0].message_data.content[1].type, "image");

        // Translated message should have text replacement
        const translated = result[0];
        const content = translated.message_data.content;
        assert.equal(content.length, 2);
        assert.equal(content[0].type, "text");
        assert.equal(content[0].text, "What is this?");
        assert.equal(content[1].type, "text");
        assert.ok(content[1].text.includes("A photo of a sunset over mountains."));
        assert.ok(content[1].text.includes("[Image description:"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    });

    it("uses cached translation on second call", async () => {
      const { translateUnsupportedContent } = await import(
        "../content-translator.js"
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
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
        ]),
      );

      // Only one response in queue — second call must use cache
      mockServer.addResponses("Cached image description");

      try {
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

        const result1 = await translateUnsupportedContent(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );
        assert.ok(result1[0].message_data.content[0].text.includes("Cached image description"));

        // Second call — should use cached value, no new LLM call
        const result2 = await translateUnsupportedContent(
          messages,
          "text-only/model",
          { image: "vision/model" },
          llmClient,
          db,
        );
        assert.ok(result2[0].message_data.content[0].text.includes("Cached image description"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    });

    it("skips unsupported content when no translation model is configured", async () => {
      const { translateUnsupportedContent } = await import(
        "../content-translator.js"
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
        ]),
      );

      try {
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

        // No translation model configured, no global fallback
        const result = await translateUnsupportedContent(
          messages,
          "text-only/model",
          {},
          llmClient,
          db,
        );

        // Image block should be replaced with a placeholder
        const content = result[0].message_data.content;
        assert.equal(content.length, 2);
        assert.equal(content[1].type, "text");
        assert.ok(content[1].text.includes("[Unsupported"));
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    });

    it("leaves assistant and tool messages untouched", async () => {
      const { translateUnsupportedContent } = await import(
        "../content-translator.js"
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
          {
            id: "text-only/model",
            name: "Text Only",
            context_length: 4096,
            pricing: { prompt: "0.000001", completion: "0.000001" },
            architecture: { input_modalities: ["text"] },
          },
        ]),
      );

      try {
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

        const result = await translateUnsupportedContent(
          messages,
          "text-only/model",
          {},
          llmClient,
          db,
        );

        assert.equal(result, messages);
      } finally {
        await fs.rm(cachePath, { force: true });
      }
    });

    it("uses global config.content_model as fallback", async () => {
      const { translateUnsupportedContent } = await import(
        "../content-translator.js"
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const cachePath = path.resolve("data/models.json");
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify([
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
        ]),
      );

      // Temporarily set config.content_model
      const config = (await import("../config.js")).default;
      const origContentModel = config.content_model;
      config.content_model = "fallback/model";

      mockServer.addResponses("Fallback translation");

      try {
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

        // No per-chat content_models, but global fallback is set
        const result = await translateUnsupportedContent(
          messages,
          "text-only/model",
          {},
          llmClient,
          db,
        );

        assert.ok(result[0].message_data.content[0].text.includes("Fallback translation"));
      } finally {
        config.content_model = origContentModel;
        await fs.rm(cachePath, { force: true });
      }
    });
  });
});
