import { describe, it } from "node:test";
import assert from "node:assert/strict";
import config from "../config.js";
import { resolveModel, ROLE_NAMES } from "../model-roles.js";

describe("resolveModel", () => {
  it("returns config defaults when no chatRow is provided", () => {
    assert.equal(resolveModel("chat"), config.model);
    assert.equal(resolveModel("image_generation"), config.image_model);
    assert.equal(resolveModel("embedding"), config.embedding_model);
    // coding_model is empty by default → falls back to chat model
    assert.equal(resolveModel("coding"), config.coding_model || config.model);
  });

  it("returns per-chat override and falls back to config when empty", () => {
    // chat role uses chatRow.model
    assert.equal(
      resolveModel("chat", /** @type {import("../model-roles.js").ModelChatConfig} */ ({ model: "custom/model" })),
      "custom/model",
    );
    assert.equal(
      resolveModel("chat", /** @type {import("../model-roles.js").ModelChatConfig} */ ({ model: null })),
      config.model,
    );

    // other roles use chatRow.model_roles
    assert.equal(
      resolveModel("image_generation", /** @type {import("../model-roles.js").ModelChatConfig} */ ({ model_roles: { image_generation: "dalle-3" } })),
      "dalle-3",
    );
    assert.equal(
      resolveModel("image_generation", /** @type {import("../model-roles.js").ModelChatConfig} */ ({ model_roles: {} })),
      config.image_model,
    );
  });

  it("resolves media_to_text roles from chatRow.media_to_text_models", () => {
    const chatRow = /** @type {import("../model-roles.js").ModelChatConfig} */ ({
      media_to_text_models: { general: "gpt-4o", image: "gpt-4o-vision" },
    });
    assert.equal(resolveModel("media_to_text", chatRow), "gpt-4o");
    assert.equal(resolveModel("image_to_text", chatRow), "gpt-4o-vision");
  });

  it("falls back from specific *_to_text to media_to_text to chat", () => {
    const origImage = config.image_to_text_model;
    const origMedia = config.media_to_text_model;
    try {
      // image_to_text empty, media_to_text set → uses media_to_text
      config.image_to_text_model = "";
      config.media_to_text_model = "vision-model";
      assert.equal(resolveModel("image_to_text"), "vision-model");

      // both empty → falls back to chat
      config.media_to_text_model = "";
      assert.equal(resolveModel("image_to_text"), config.model);

      // image_to_text set → uses it directly
      config.image_to_text_model = "specific-vision";
      assert.equal(resolveModel("image_to_text"), "specific-vision");
    } finally {
      config.image_to_text_model = origImage;
      config.media_to_text_model = origMedia;
    }
  });

  it("throws for nonexistent role", () => {
    assert.throws(() => resolveModel("nonexistent"), {
      message: /Unknown model role.*nonexistent/,
    });
  });

  it("never returns empty string — falls back to chat model", () => {
    const orig = process.env.CODING_MODEL;
    try {
      process.env.CODING_MODEL = "";
      // "coding" has no fallback chain, but config default is empty.
      // Should still return a non-empty string (the chat model).
      const result = resolveModel("coding");
      assert.ok(result.length > 0, `resolveModel("coding") returned empty string`);
    } finally {
      if (orig === undefined) delete process.env.CODING_MODEL;
      else process.env.CODING_MODEL = orig;
    }
  });
});

describe("ROLE_NAMES", () => {
  it("is a frozen array containing all defined roles", () => {
    assert.ok(Object.isFrozen(ROLE_NAMES));
    for (const role of ["chat", "image_generation", "embedding", "media_to_text",
      "image_to_text", "audio_to_text", "video_to_text", "coding", "smart", "fast"]) {
      assert.ok(ROLE_NAMES.includes(role), `missing '${role}'`);
    }
  });
});
