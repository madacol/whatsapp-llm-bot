import OpenAI from "openai";
import config from "./config.js";
import { resolveModel } from "./model-roles.js";
import { convertAudioToMp3Base64 } from "./audio_conversion.js";
import { registerMedia, isMediaBlock } from "./message-formatting.js";
import { createLogger } from "./logger.js";

const log = createLogger("llm");

/**
 * Create a new OpenAI-compatible LLM client.
 * @param {{apiKey?: string, baseURL?: string}} [options]
 * @returns {LlmClient}
 */
export function createLlmClient(options = {}) {
  return /** @type {LlmClient} */ (/** @type {unknown} */ (new OpenAI({
    apiKey: options.apiKey || config.llm_api_key,
    baseURL: options.baseURL || config.base_url,
  })));
}

/**
 * Unwrap the opaque LlmClient to the underlying OpenAI instance.
 * @param {LlmClient} client
 * @returns {OpenAI}
 */
function unwrap(client) {
  return /** @type {OpenAI} */ (/** @type {unknown} */ (client));
}

/**
 * Generate an embedding vector.
 * @param {LlmClient} llmClient
 * @param {string} model
 * @param {string} input
 * @returns {Promise<number[]>}
 */
export async function createEmbedding(llmClient, model, input) {
  const response = await unwrap(llmClient).embeddings.create({ model, input });
  return response.data[0].embedding;
}

/**
 * Convert a CallLlmPrompt (string or ContentBlock[]) into the format OpenAI expects.
 * @param {CallLlmPrompt} prompt
 * @returns {string | OpenAI.ChatCompletionContentPart[]}
 */
export function convertPromptToOpenAI(prompt) {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt.map(block => {
    switch (block.type) {
      case "text":
        return { type: /** @type {const} */ ("text"), text: block.text };
      case "image":
        return { type: /** @type {const} */ ("image_url"), image_url: { url: `data:${block.mime_type};base64,${block.data}` } };
      case "audio":
        return { type: /** @type {const} */ ("input_audio"), input_audio: { data: block.data, format: /** @type {const} */ ("mp3") } };
      case "video":
        return /** @type {*} */ ({ type: "video_url", video_url: { url: `data:${block.mime_type};base64,${block.data}` } });
      default:
        return { type: /** @type {const} */ ("text"), text: `[Unsupported content type: ${/** @type {{type: string}} */ (block).type}]` };
    }
  });
}

/**
 * Convert a CallLlmMessage into OpenAI message format.
 * @param {CallLlmMessage} msg
 * @returns {OpenAI.ChatCompletionMessageParam}
 */
export function convertMessageToOpenAI(msg) {
  return /** @type {OpenAI.ChatCompletionMessageParam} */ ({
    role: msg.role,
    content: msg.content === null ? null
      : typeof msg.content === "string" ? msg.content
      : convertPromptToOpenAI(msg.content),
    ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
    ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
  });
}

/**
 * Normalize an OpenAI ChatCompletion into LlmChatResponse.
 * @param {OpenAI.Chat.Completions.ChatCompletion} completion
 * @param {number | undefined} nativeCost
 * @returns {LlmChatResponse}
 */
function normalizeChatCompletion(completion, nativeCost) {
  const message = completion.choices[0].message;
  /** @type {LlmChatResponse} */
  const result = {
    content: message.content,
    toolCalls: (message.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    })),
  };
  if (completion.usage) {
    result.usage = {
      promptTokens: completion.usage.prompt_tokens,
      completionTokens: completion.usage.completion_tokens,
      cachedTokens: completion.usage.prompt_tokens_details?.cached_tokens ?? 0,
      cost: nativeCost,
    };
  }
  return result;
}

// ── Internal Message[] → OpenAI conversion helpers ──

/**
 * Register a media block in the registry and append a `[media:N]` text marker.
 * @param {Array<OpenAI.ChatCompletionContentPart>} parts
 * @param {MediaRegistry} registry
 * @param {IncomingContentBlock} originalBlock
 * @returns {number} The assigned media ID
 */
function tagMedia(parts, registry, originalBlock) {
  const id = registerMedia(registry, originalBlock);
  parts.push({ type: "text", text: `[media:${id}]` });
  return id;
}

/**
 * Format a user message's content blocks into OpenAI content parts.
 * @param {UserMessage} message
 * @param {MediaRegistry} registry
 * @returns {Promise<Array<OpenAI.ChatCompletionContentPart>>}
 */
async function formatUserContent(message, registry) {
  /** @type {Array<OpenAI.ChatCompletionContentPart>} */
  const parts = [];

  for (const contentBlock of message.content) {
    switch (contentBlock.type) {
      case "quote": {
        for (const quoteBlock of contentBlock.content) {
          switch (quoteBlock.type) {
            case "text":
              parts.push({ type: "text", text: `> ${quoteBlock.text.trim().replace(/\n/g, '\n> ')}` });
              break;
            case "image": {
              const dataUrl = `data:${quoteBlock.mime_type};base64,${quoteBlock.data}`;
              parts.push({ type: "image_url", image_url: { url: dataUrl } });
              tagMedia(parts, registry, quoteBlock);
              break;
            }
          }
        }
        break;
      }
      case "text":
        parts.push(contentBlock);
        break;
      case "image": {
        const dataUrl = `data:${contentBlock.mime_type};base64,${contentBlock.data}`;
        parts.push({ type: "image_url", image_url: { url: dataUrl } });
        tagMedia(parts, registry, contentBlock);
        break;
      }
      case "audio": {
        /** @type {"wav" | "mp3"} */
        let format = "mp3";
        let data;
        const audioFormat = contentBlock.mime_type?.split("audio/")[1]?.split(";")[0];
        if (audioFormat === "wav" || audioFormat === "mp3") {
          format = audioFormat;
          data = contentBlock.data;
        } else {
          log.warn(`Unsupported audio format: ${contentBlock.mime_type}`);
          data = await convertAudioToMp3Base64(contentBlock.data);
        }
        parts.push({
          type: "input_audio",
          input_audio: { data, format },
        });
        tagMedia(parts, registry, contentBlock);
        break;
      }
      case "video": {
        const videoUrl = `data:${contentBlock.mime_type};base64,${contentBlock.data}`;
        parts.push(/** @type {*} */ ({
          type: "video_url",
          video_url: { url: videoUrl },
        }));
        tagMedia(parts, registry, contentBlock);
        break;
      }
    }
  }

  return parts;
}

/**
 * Format an assistant message into an OpenAI ChatCompletionMessageParam.
 * @param {AssistantMessage} message
 * @returns {OpenAI.ChatCompletionMessageParam}
 */
function formatAssistantContent(message) {
  /** @type {OpenAI.ChatCompletionMessageToolCall[]} */
  const toolCalls = [];
  const content = message.content
    .map(contentBlock => {
      switch (contentBlock.type) {
        case "text":
          return contentBlock;
        case "tool":
          toolCalls.push({
            type: "function",
            id: contentBlock.tool_id,
            function: {
              name: contentBlock.name,
              arguments: contentBlock.arguments,
            },
          });
      }
    })
    .filter(x => x !== undefined);

  return {
    role: "assistant",
    content,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Format a tool message into OpenAI ChatCompletionMessageParam(s).
 * @param {ToolMessage} message
 * @param {MediaRegistry} registry
 * @returns {Array<OpenAI.ChatCompletionMessageParam>}
 */
function formatToolContent(message, registry) {
  const hasMedia = message.content.some(isMediaBlock);

  if (!hasMedia) {
    /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
    const results = [];
    for (const block of message.content) {
      if (block.type === "text") {
        results.push({
          role: /** @type {const} */ ("tool"),
          tool_call_id: message.tool_id,
          content: block.text,
        });
      }
    }
    return results;
  }

  // Multipart: combine text + images/video into a single tool message
  /** @type {Array<OpenAI.ChatCompletionContentPart>} */
  const parts = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: /** @type {const} */ ("text"), text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: /** @type {const} */ ("image_url"),
        image_url: { url: `data:${block.mime_type};base64,${block.data}` },
      });
      tagMedia(parts, registry, block);
    } else if (block.type === "video") {
      parts.push(/** @type {*} */ ({
        type: "video_url",
        video_url: { url: `data:${block.mime_type};base64,${block.data}` },
      }));
      tagMedia(parts, registry, block);
    }
  }
  return [/** @type {OpenAI.ChatCompletionMessageParam} */ (
    { role: "tool", tool_call_id: message.tool_id, content: parts }
  )];
}

/**
 * Convert internal Message[] to OpenAI ChatCompletionMessageParam[].
 * @param {Message[]} messages
 * @param {MediaRegistry} registry
 * @returns {Promise<Array<OpenAI.ChatCompletionMessageParam>>}
 */
async function convertMessagesToOpenAI(messages, registry) {
  /** @type {Array<OpenAI.ChatCompletionMessageParam>} */
  const formatted = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        formatted.push({
          role: "user",
          content: await formatUserContent(msg, registry),
        });
        break;
      case "assistant":
        formatted.push(formatAssistantContent(msg));
        break;
      case "tool":
        formatted.push(...formatToolContent(msg, registry));
        break;
    }
  }

  return formatted;
}

/**
 * Convert a ToolContentBlock[] result into OpenAI content parts, tagging media in the registry.
 * @param {ToolContentBlock[]} blocks
 * @param {MediaRegistry} registry
 * @returns {{ parts: Array<OpenAI.ChatCompletionContentPart>, mediaIds: Map<ToolContentBlock, number> }}
 */
export function convertToolResultToOpenAI(blocks, registry) {
  /** @type {Array<OpenAI.ChatCompletionContentPart>} */
  const parts = [];
  /** @type {Map<ToolContentBlock, number>} */
  const mediaIds = new Map();

  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: /** @type {const} */ ("text"), text: block.text });
    } else if (block.type === "image") {
      parts.push({
        type: /** @type {const} */ ("image_url"),
        image_url: { url: `data:${block.mime_type};base64,${block.data}` },
      });
      const id = tagMedia(parts, registry, block);
      mediaIds.set(block, id);
    } else if (block.type === "video") {
      parts.push(/** @type {*} */ ({
        type: "video_url",
        video_url: { url: `data:${block.mime_type};base64,${block.data}` },
      }));
      const id = tagMedia(parts, registry, block);
      mediaIds.set(block, id);
    }
  }

  return { parts, mediaIds };
}


/**
 * Send a chat completion using internal Message[], returning normalized LlmChatResponse.
 * Handles system prompt with cache_control, media tagging, and tool definitions.
 * @param {LlmClient} llmClient
 * @param {{
 *   model: string,
 *   systemPrompt: string,
 *   messages: Message[],
 *   tools: ToolDefinition[],
 *   mediaRegistry: MediaRegistry,
 * }} options
 * @returns {Promise<LlmChatResponse>}
 */
export async function sendChatCompletion(llmClient, { model, systemPrompt, messages, tools, mediaRegistry }) {
  const openaiMessages = await convertMessagesToOpenAI(messages, mediaRegistry);

  const completion = await unwrap(llmClient).chat.completions.create({
    model,
    messages: [
      { role: "system", content: /** @type {Array<{type: "text", text: string, cache_control: {type: "ephemeral"}}>} */ ([{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]) },
      ...openaiMessages,
    ],
    tools: /** @type {OpenAI.ChatCompletionTool[]} */ (tools),
    tool_choice: "auto",
  });

  const nativeCost = /** @type {{ cost?: number } & typeof completion.usage} */ (completion.usage)?.cost;
  return normalizeChatCompletion(completion, nativeCost);
}

/**
 * Send a simple chat completion for media-to-text conversion.
 * @param {LlmClient} llmClient
 * @param {string} model
 * @param {CallLlmMessage[]} messages
 * @returns {Promise<string | null>}
 */
export async function sendSimpleChatCompletion(llmClient, model, messages) {
  const response = await unwrap(llmClient).chat.completions.create({
    model,
    messages: messages.map(convertMessageToOpenAI),
  });
  return response.choices[0].message.content;
}

/**
 * Create a CallLlm function backed by a real OpenAI client.
 * @param {LlmClient} llmClient
 * @param {string} [defaultModel]
 * @returns {CallLlm}
 */
export function createCallLlm(llmClient, defaultModel = resolveModel("chat")) {
  const client = unwrap(llmClient);
  /** @type {CallLlm} */
  const callLlm = /** @type {CallLlm} */ (async (/** @type {CallLlmPrompt | CallLlmChatOptions} */ promptOrOpts, /** @type {CallLlmOptions} */ options = {}) => {
    if (typeof promptOrOpts === "object" && !Array.isArray(promptOrOpts) && "messages" in promptOrOpts) {
      // Chat mode — normalize response to LlmChatResponse
      const completion = await client.chat.completions.create({
        model: promptOrOpts.model || defaultModel,
        messages: promptOrOpts.messages.map(convertMessageToOpenAI),
        ...(promptOrOpts.tools && { tools: /** @type {OpenAI.ChatCompletionTool[]} */ (promptOrOpts.tools) }),
        ...(promptOrOpts.tool_choice && { tool_choice: promptOrOpts.tool_choice }),
      });
      const nativeCost = /** @type {{ cost?: number } & typeof completion.usage} */ (completion.usage)?.cost;
      return normalizeChatCompletion(completion, nativeCost);
    }
    // Simple mode
    const content = convertPromptToOpenAI(promptOrOpts);
    const response = await client.chat.completions.create({
      model: options.model || defaultModel,
      messages: [{ role: "user", content }],
    });
    return response.choices[0].message.content;
  });
  return callLlm;
}
