import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { buildLiveInputText } from "../conversation/live-input-text.js";
import { createTestDb } from "./helpers.js";

describe("buildLiveInputText", () => {
  afterEach(async () => {
    const db = await createTestDb();
    await db.sql`DELETE FROM media_to_text_cache`.catch(() => {});
  });

  it("uses the shared media-to-text label for audio transcripts", async () => {
    const db = await createTestDb();
    /** @type {unknown[]} */
    const requests = [];
    const llmClient = /** @type {LlmClient} */ (/** @type {unknown} */ ({
      chat: {
        completions: {
          /** @param {unknown} request */
          create: async (request) => {
            requests.push(request);
            return {
              choices: [{ message: { content: "What's the deployment status?" } }],
            };
          },
        },
      },
    }));

    const text = await buildLiveInputText({
      content: [
        { type: "text", text: "Please inspect this voice note" },
        {
          type: "audio",
          encoding: "base64",
          mime_type: "audio/mp3",
          data: "abc123audiodata",
        },
      ],
      llmClient,
      mediaToTextModels: { audio: "audio/model" },
      db,
    });

    assert.equal(requests.length, 1);
    assert.match(
      text,
      /^Please inspect this voice note\nAudio transcript:\nWhat's the deployment status\?/,
    );
  });

  it("passes supplied user and assistant context to audio transcription", async () => {
    const db = await createTestDb();
    /** @type {unknown[]} */
    const requests = [];
    const llmClient = /** @type {LlmClient} */ (/** @type {unknown} */ ({
      chat: {
        completions: {
          /** @param {unknown} request */
          create: async (request) => {
            requests.push(request);
            return {
              choices: [{ message: { content: "Context-aware transcript." } }],
            };
          },
        },
      },
    }));

    await buildLiveInputText({
      contextMessages: [
        { role: "user", content: [{ type: "text", text: "User asked about deployment timing." }] },
        { role: "assistant", content: [{ type: "text", text: "Assistant said staging was still building." }] },
      ],
      content: [
        { type: "text", text: "This voice note says what happened next" },
        {
          type: "audio",
          encoding: "base64",
          mime_type: "audio/mp3",
          data: "abc123contextaudio",
        },
      ],
      llmClient,
      mediaToTextModels: { audio: "audio/model" },
      db,
    });

    assert.equal(requests.length, 1);
    const serialized = JSON.stringify(requests[0]);
    assert.ok(serialized.includes("User asked about deployment timing."), serialized);
    assert.ok(serialized.includes("Assistant said staging was still building."), serialized);
    assert.ok(serialized.includes("User's message: This voice note says what happened next"), serialized);
  });
});
