import OpenAI from "openai";
import config from "./config.js";

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
 * Create a CallLlm function backed by a real OpenAI client.
 * @param {OpenAI} llmClient
 * @param {string} [defaultModel]
 * @returns {CallLlm}
 */
export function createCallLlm(llmClient, defaultModel = config.model) {
  return async (prompt, options = {}) => {
    const content = convertPromptToOpenAI(prompt);
    const response = await llmClient.chat.completions.create({
      model: options.model || defaultModel,
      messages: [{ role: "user", content }],
    });
    return response.choices[0].message.content;
  };
}
