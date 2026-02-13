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
