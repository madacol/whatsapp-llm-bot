#!/usr/bin/env node

import { ACTION_REQUESTS_ENV_VAR, writeQueuedActionRequest } from "../action-request-runtime.js";

/**
 * @typedef {"generate-image" | "generate-video"} ActionCommand
 */

/**
 * @typedef {{
 *   kind: "whatsapp-action-request",
 *   action: string,
 *   arguments: Record<string, unknown>,
 *   cwd?: string,
 * }} QueuedActionRequest
 */

/**
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
async function main(argv) {
  const [command, ...args] = argv;
  if (!isActionCommand(command)) {
    throw new Error("Usage: enqueue-action-request.js <generate-image|generate-video> [options]");
  }

  const requestsDir = process.env[ACTION_REQUESTS_ENV_VAR];
  if (!requestsDir) {
    throw new Error(`${ACTION_REQUESTS_ENV_VAR} must be set.`);
  }

  const request = buildQueuedActionRequest(command, args, process.cwd());
  await writeQueuedActionRequest(requestsDir, request);
}

/**
 * @param {string | undefined} command
 * @returns {command is ActionCommand}
 */
function isActionCommand(command) {
  return command === "generate-image" || command === "generate-video";
}

/**
 * @param {ActionCommand} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {QueuedActionRequest}
 */
function buildQueuedActionRequest(command, args, cwd) {
  const options = parseOptions(args);

  if (command === "generate-image") {
    const prompt = requireStringOption(options, "prompt");
    const imagePaths = readStringOptions(options, "image-path");
    return {
      kind: "whatsapp-action-request",
      action: "generate_image",
      arguments: {
        prompt,
        ...(imagePaths.length > 0 ? { image_paths: imagePaths } : {}),
      },
      cwd,
    };
  }

  const prompt = requireStringOption(options, "prompt");
  const imagePath = readOptionalStringOption(options, "image-path");
  const aspectRatio = readOptionalStringOption(options, "aspect-ratio");
  const negativePrompt = readOptionalStringOption(options, "negative-prompt");
  const durationSeconds = readOptionalNumberOption(options, "duration-seconds");

  return {
    kind: "whatsapp-action-request",
    action: "generate_video",
    arguments: {
      prompt,
      ...(imagePath ? { image_path: imagePath } : {}),
      ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
    },
    cwd,
  };
}

/**
 * @param {string[]} args
 * @returns {Map<string, string[]>}
 */
function parseOptions(args) {
  /** @type {Map<string, string[]>} */
  const options = new Map();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (!key) {
      throw new Error("Option names must not be empty.");
    }
    const value = args[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    const existing = options.get(key);
    if (existing) {
      existing.push(value);
    } else {
      options.set(key, [value]);
    }
    index += 1;
  }

  return options;
}

/**
 * @param {Map<string, string[]>} options
 * @param {string} key
 * @returns {string}
 */
function requireStringOption(options, key) {
  const value = readOptionalStringOption(options, key);
  if (!value) {
    throw new Error(`--${key} is required.`);
  }
  return value;
}

/**
 * @param {Map<string, string[]>} options
 * @param {string} key
 * @returns {string | null}
 */
function readOptionalStringOption(options, key) {
  const values = options.get(key);
  if (!values || values.length === 0) {
    return null;
  }
  const [value] = values;
  return value.trim() ? value : null;
}

/**
 * @param {Map<string, string[]>} options
 * @param {string} key
 * @returns {string[]}
 */
function readStringOptions(options, key) {
  const values = options.get(key) ?? [];
  return values.filter((value) => value.trim().length > 0);
}

/**
 * @param {Map<string, string[]>} options
 * @param {string} key
 * @returns {number | null}
 */
function readOptionalNumberOption(options, key) {
  const value = readOptionalStringOption(options, key);
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${key} must be a number.`);
  }
  return parsed;
}

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
