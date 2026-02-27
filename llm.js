import OpenAI from "openai";
import config from "./config.js";
import { resolveModel } from "./model-roles.js";

/**
 * Create a new OpenAI-compatible LLM client
 * @param {{apiKey?: string, baseURL?: string}} [options]
 * @returns {OpenAI}
 */
export function createLlmClient(options = {}) {
  return new OpenAI({
    apiKey: options.apiKey || config.llm_api_key,
    baseURL: options.baseURL || config.base_url,
  });
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
      default:
        return { type: /** @type {const} */ ("text"), text: `[Unsupported content type: ${block.type}]` };
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
 * Create a CallLlm function backed by a real OpenAI client.
 * @param {OpenAI} llmClient
 * @param {string} [defaultModel]
 * @returns {CallLlm}
 */
export function createCallLlm(llmClient, defaultModel = resolveModel("chat")) {
  /** @type {CallLlm} */
  const callLlm = /** @type {CallLlm} */ (async (/** @type {CallLlmPrompt | CallLlmChatOptions} */ promptOrOpts, /** @type {CallLlmOptions} */ options = {}) => {
    if (typeof promptOrOpts === "object" && !Array.isArray(promptOrOpts) && "messages" in promptOrOpts) {
      // Chat mode
      return llmClient.chat.completions.create({
        model: promptOrOpts.model || defaultModel,
        messages: promptOrOpts.messages.map(convertMessageToOpenAI),
        ...(promptOrOpts.tools && { tools: promptOrOpts.tools }),
        ...(promptOrOpts.tool_choice && { tool_choice: promptOrOpts.tool_choice }),
      });
    }
    // Simple mode
    const content = convertPromptToOpenAI(promptOrOpts);
    const response = await llmClient.chat.completions.create({
      model: options.model || defaultModel,
      messages: [{ role: "user", content }],
    });
    return response.choices[0].message.content;
  });
  return callLlm;
}
