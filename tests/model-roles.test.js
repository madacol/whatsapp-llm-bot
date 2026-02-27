import { describe, it } from "node:test";
import assert from "node:assert/strict";
import config from "../config.js";
import { resolveModel, ROLE_NAMES } from "../model-roles.js";

describe("model-roles", () => {
  describe("resolveModel", () => {
    it("returns config.model for 'chat' when no chatRow", () => {
      assert.equal(resolveModel("chat"), config.model);
    });

    it("returns chatRow.model for 'chat' when chatRow has model set", () => {
      const chatRow = /** @type {any} */ ({ model: "custom/chat-model" });
      assert.equal(resolveModel("chat", chatRow), "custom/chat-model");
    });

    it("falls back to config.model for 'chat' when chatRow.model is null", () => {
      const chatRow = /** @type {any} */ ({ model: null });
      assert.equal(resolveModel("chat", chatRow), config.model);
    });

    it("returns config.image_model for 'image_generation' when no chatRow", () => {
      assert.equal(resolveModel("image_generation"), config.image_model);
    });

    it("returns per-chat override for 'image_generation' from model_roles", () => {
      const chatRow = /** @type {any} */ ({
        model_roles: { image_generation: "dalle-3" },
      });
      assert.equal(resolveModel("image_generation", chatRow), "dalle-3");
    });

    it("returns config.embedding_model for 'embedding' when no chatRow", () => {
      assert.equal(resolveModel("embedding"), config.embedding_model);
    });

    it("returns empty string for 'coding' (empty default)", () => {
      assert.equal(resolveModel("coding"), config.coding_model);
    });

    it("returns per-chat override for 'coding' from model_roles", () => {
      const chatRow = /** @type {any} */ ({
        model_roles: { coding: "deepseek/deepseek-coder" },
      });
      assert.equal(resolveModel("coding", chatRow), "deepseek/deepseek-coder");
    });

    it("falls back to config default when chatRow.model_roles is empty", () => {
      const chatRow = /** @type {any} */ ({ model_roles: {} });
      assert.equal(resolveModel("image_generation", chatRow), config.image_model);
    });

    it("resolves media_to_text from chatRow.media_to_text_models", () => {
      const chatRow = /** @type {any} */ ({
        media_to_text_models: { general: "gpt-4o" },
      });
      assert.equal(resolveModel("media_to_text", chatRow), "gpt-4o");
    });

    it("resolves image_to_text from chatRow.media_to_text_models", () => {
      const chatRow = /** @type {any} */ ({
        media_to_text_models: { image: "gpt-4o-vision" },
      });
      assert.equal(resolveModel("image_to_text", chatRow), "gpt-4o-vision");
    });

    it("throws for nonexistent role", () => {
      assert.throws(() => resolveModel("nonexistent"), {
        message: /Unknown model role.*nonexistent/,
      });
    });
  });

  describe("ROLE_NAMES", () => {
    it("includes all expected roles", () => {
      const expected = [
        "chat", "image_generation", "embedding",
        "media_to_text", "image_to_text", "audio_to_text", "video_to_text",
        "coding", "smart", "fast",
      ];
      for (const role of expected) {
        assert.ok(ROLE_NAMES.includes(role), `ROLE_NAMES should include '${role}'`);
      }
    });

    it("is a frozen array", () => {
      assert.ok(Object.isFrozen(ROLE_NAMES));
    });
  });
});
