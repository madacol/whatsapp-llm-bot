const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-audio-mini";
const DEFAULT_VOICE = "marin";
const DEFAULT_FORMAT = "mp3";

/** @type {Record<string, string>} */
const FORMAT_TO_MIME = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg; codecs=opus",
  aac: "audio/aac",
  flac: "audio/flac",
  pcm: "audio/L16",
  pcm16: "audio/L16",
};

/**
 * @typedef {{
 *   text: string;
 * }} SpeechSynthesisInput
 *
 * @typedef {{
 *   buffer: Buffer;
 *   mimeType: string;
 * }} SpeechSynthesisResult
 */

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function env(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value : fallback;
}

/**
 * @param {string} provider
 * @returns {string}
 */
function apiKey(provider) {
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OPENAI_API_KEY is not set");
    }
    return key;
  }

  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  return key;
}

/**
 * @param {string} provider
 * @returns {Record<string, string>}
 */
function requestHeaders(provider) {
  /** @type {Record<string, string>} */
  const headers = {
    authorization: `Bearer ${apiKey(provider)}`,
    "content-type": "application/json",
  };
  if (provider === "openrouter") {
    headers["http-referer"] = env("OPENROUTER_HTTP_REFERER", "http://localhost/whatsapp-llm-bot");
    headers["x-title"] = env("OPENROUTER_APP_TITLE", "whatsapp-llm-bot");
  }
  return headers;
}

/**
 * @param {string} responseFormat
 * @returns {string}
 */
function speechResponseFormat(responseFormat) {
  return responseFormat === "pcm16" ? "pcm" : responseFormat;
}

/**
 * @param {string} responseFormat
 * @param {string | null} contentType
 * @returns {string}
 */
function resolveMimeType(responseFormat, contentType) {
  if (contentType && !contentType.includes("application/json")) {
    return contentType.split(";").map((part) => part.trim()).filter(Boolean).join("; ");
  }
  return FORMAT_TO_MIME[responseFormat] || "application/octet-stream";
}

/**
 * @param {Response} response
 * @param {string} label
 * @returns {Promise<void>}
 */
async function assertOk(response, label) {
  if (response.ok) {
    return;
  }
  const body = await response.text().catch(() => "");
  throw new Error(`${label} failed with HTTP ${response.status}: ${body}`);
}

/**
 * @param {string} text
 * @param {{
 *   provider: string,
 *   model: string,
 *   voice: string,
 *   responseFormat: string,
 *   speed: number,
 *   instructions: string,
 * }} options
 * @returns {Promise<SpeechSynthesisResult>}
 */
async function synthesizeViaSpeechEndpoint(text, options) {
  const provider = options.provider;
  /** @type {{
   *   model: string,
   *   input: string,
   *   voice: string,
   *   response_format: string,
   *   speed: number,
   *   instructions?: string,
   * }}
   */
  const payload = {
    model: options.model,
    input: text,
    voice: options.voice,
    response_format: speechResponseFormat(options.responseFormat),
    speed: options.speed,
  };
  if (provider === "openai" && options.instructions) {
    payload.instructions = options.instructions;
  }
  const url = provider === "openai"
    ? env("OPENAI_SPEECH_URL", OPENAI_SPEECH_URL)
    : env("OPENROUTER_SPEECH_URL", OPENROUTER_SPEECH_URL);
  const response = await fetch(url, {
    method: "POST",
    headers: requestHeaders(provider),
    body: JSON.stringify(payload),
  });
  await assertOk(response, provider === "openai" ? "OpenAI speech" : "OpenRouter speech");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error(`${provider} speech returned empty audio`);
  }
  return {
    buffer,
    mimeType: resolveMimeType(options.responseFormat, response.headers.get("content-type")),
  };
}

/**
 * @param {string} text
 * @param {{
 *   model: string,
 *   voice: string,
 *   responseFormat: string,
 * }} options
 * @returns {Promise<SpeechSynthesisResult>}
 */
async function synthesizeViaOpenRouterChat(text, options) {
  const payload = {
    model: options.model,
    modalities: ["text", "audio"],
    audio: {
      voice: options.voice,
      format: options.responseFormat,
    },
    stream: true,
    messages: [
      {
        role: "system",
        content: "You are a text-to-speech renderer. Speak exactly the user-provided text and add no extra words.",
      },
      { role: "user", content: text },
    ],
  };
  const response = await fetch(env("OPENROUTER_CHAT_URL", OPENROUTER_CHAT_URL), {
    method: "POST",
    headers: requestHeaders("openrouter"),
    body: JSON.stringify(payload),
  });
  await assertOk(response, "OpenRouter audio chat");
  const raw = await response.text();
  /** @type {Buffer[]} */
  const chunks = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const data = trimmed.replace(/^data:\s*/, "");
    if (!data || data === "[DONE]") {
      continue;
    }
    const event = JSON.parse(data);
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const delta = choices[0]?.delta;
    const audio = delta && typeof delta === "object" ? delta.audio : null;
    if (audio && typeof audio.data === "string") {
      chunks.push(Buffer.from(audio.data, "base64"));
    }
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.byteLength === 0) {
    throw new Error("OpenRouter audio chat returned empty audio");
  }
  return {
    buffer,
    mimeType: resolveMimeType(options.responseFormat, null),
  };
}

/**
 * Provider-backed text-to-speech for HTTP API audio clients.
 *
 * @param {SpeechSynthesisInput} input
 * @returns {Promise<SpeechSynthesisResult>}
 */
export async function synthesizeSpeechForHttpApi(input) {
  const text = input.text.trim();
  if (!text) {
    throw new Error("text is empty");
  }
  const provider = env("TTS_PROVIDER", DEFAULT_PROVIDER);
  if (provider !== "openai" && provider !== "openrouter") {
    throw new Error(`unsupported TTS_PROVIDER: ${provider}`);
  }
  const responseFormat = env("TTS_RESPONSE_FORMAT", DEFAULT_FORMAT);
  const modelDefault = provider === "openai" ? DEFAULT_OPENAI_MODEL : DEFAULT_OPENROUTER_MODEL;
  const model = env("TTS_MODEL", modelDefault);
  const voice = env("TTS_VOICE", DEFAULT_VOICE);
  const speed = Number.parseFloat(env("TTS_SPEED", "1")) || 1;
  const instructions = env("TTS_INSTRUCTIONS", "");
  const route = env("TTS_ROUTE", provider === "openai" ? "speech" : "chat");

  if (route === "speech") {
    return synthesizeViaSpeechEndpoint(text, {
      provider,
      model,
      voice,
      responseFormat,
      speed,
      instructions,
    });
  }
  if (provider === "openrouter" && route === "chat") {
    return synthesizeViaOpenRouterChat(text, {
      model,
      voice,
      responseFormat,
    });
  }
  throw new Error(`unsupported TTS route/provider combination: ${provider}/${route}`);
}
