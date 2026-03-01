import config from "./config.js";

/**
 * @typedef {{
 *   envVar: string;
 *   configKey: keyof typeof config;
 *   defaultValue: string;
 *   description: string;
 * }} RoleDefinition
 */

/**
 * Map of role name → how to resolve its model ID.
 *
 * Resolution chain for each role:
 *   1. Per-chat override (chatRow.model, chatRow.media_to_text_models, or chatRow.model_roles)
 *   2. Env var / config default
 *   3. Hardcoded default (in config.js)
 *
 * @type {Record<string, RoleDefinition>}
 */
export const ROLE_DEFINITIONS = {
  // ── existing roles ──
  chat: {
    envVar: "MODEL",
    configKey: "model",
    defaultValue: "gpt-4.1",
    description: "Primary chat model",
  },
  image_generation: {
    envVar: "IMAGE_MODEL",
    configKey: "image_model",
    defaultValue: "google/gemini-3-pro-image-preview",
    description: "Image generation model",
  },
  embedding: {
    envVar: "EMBEDDING_MODEL",
    configKey: "embedding_model",
    defaultValue: "google/gemini-embedding-001",
    description: "Text embedding model",
  },
  media_to_text: {
    envVar: "MEDIA_TO_TEXT_MODEL",
    configKey: "media_to_text_model",
    defaultValue: "",
    description: "General media-to-text conversion model",
  },
  image_to_text: {
    envVar: "IMAGE_TO_TEXT_MODEL",
    configKey: "image_to_text_model",
    defaultValue: "",
    description: "Image-to-text conversion model",
  },
  audio_to_text: {
    envVar: "AUDIO_TO_TEXT_MODEL",
    configKey: "audio_to_text_model",
    defaultValue: "",
    description: "Audio-to-text conversion model",
  },
  video_to_text: {
    envVar: "VIDEO_TO_TEXT_MODEL",
    configKey: "video_to_text_model",
    defaultValue: "",
    description: "Video-to-text conversion model",
  },

  // ── new roles ──
  coding: {
    envVar: "CODING_MODEL",
    configKey: "coding_model",
    defaultValue: "",
    description: "Best model for code tasks",
  },
  smart: {
    envVar: "SMART_MODEL",
    configKey: "smart_model",
    defaultValue: "",
    description: "Highest-quality reasoning model",
  },
  fast: {
    envVar: "FAST_MODEL",
    configKey: "fast_model",
    defaultValue: "",
    description: "Cheap/fast model for simple tasks",
  },
};

/** @type {readonly string[]} */
export const ROLE_NAMES = Object.freeze(Object.keys(ROLE_DEFINITIONS));

/**
 * Mapping from *_to_text role names to their media_to_text_models key.
 * @type {Record<string, string>}
 */
const MEDIA_TO_TEXT_ROLE_KEYS = {
  media_to_text: "general",
  image_to_text: "image",
  audio_to_text: "audio",
  video_to_text: "video",
};

/** @type {Record<string, string>} */
const MEDIA_TO_TEXT_FALLBACK = {
  image_to_text: "media_to_text",
  audio_to_text: "media_to_text",
  video_to_text: "media_to_text",
  media_to_text: "chat",
};

/**
 * Resolve a model ID for the given role.
 *
 * Resolution chain:
 *   1. Per-chat override (chatRow)
 *   2. Config/env default
 *   3. For *_to_text roles: media_to_text → chat fallback
 *
 * Per-chat storage:
 *   - `chat` role → chatRow.model
 *   - `*_to_text` roles → chatRow.media_to_text_models[key]
 *   - All other roles → chatRow.model_roles[role]
 *
 * @param {string} role
 * @param {import("./store.js").ChatRow} [chatRow]
 * @returns {string}
 */
export function resolveModel(role, chatRow) {
  const definition = ROLE_DEFINITIONS[role];
  if (!definition) {
    throw new Error(`Unknown model role: "${role}"`);
  }

  // 1. Per-chat override
  if (chatRow) {
    /** @type {string | undefined | null} */
    let override;

    if (role === "chat") {
      override = chatRow.model;
    } else if (role in MEDIA_TO_TEXT_ROLE_KEYS) {
      const key = MEDIA_TO_TEXT_ROLE_KEYS[role];
      const models = chatRow.media_to_text_models ?? {};
      override = models[/** @type {"image"|"audio"|"video"|"general"} */ (key)];
    } else {
      const roles = chatRow.model_roles ?? {};
      override = roles[role];
    }

    if (override) return override;
  }

  // 2. Config/env default
  const resolved = /** @type {string} */ (config[definition.configKey]);
  if (resolved) return resolved;

  // 3. Fallback chain for *_to_text roles: specific → media_to_text → chat
  const fallbackRole = MEDIA_TO_TEXT_FALLBACK[role];
  if (fallbackRole) return resolveModel(fallbackRole, chatRow);

  return resolved;
}
