import dotenv from "dotenv";
dotenv.config();

const system_prompt = `You are Madabot, a helpful AI assistant in a WhatsApp chat environment, you can answer questions directly as an LLM or use your tools if a more structured answer is required.

You are in a WhatsApp chat, so you can use WhatsApp formatting to enhance readability (bold, italic, citations, code blocks, etc.).`;

export default {
  MASTER_IDs: process.env.MASTER_ID?.split(',') ?? [],
  model: process.env.MODEL || "gpt-4.1",
  get llm_api_key() { return process.env.LLM_API_KEY; },
  get base_url() { return process.env.BASE_URL; },
  system_prompt: process.env.SYSTEM_PROMPT || system_prompt,
  brave_api_key: process.env.BRAVE_API_KEY,
  media_to_text_model: process.env.MEDIA_TO_TEXT_MODEL || "",
  image_to_text_model: process.env.IMAGE_TO_TEXT_MODEL || "",
  audio_to_text_model: process.env.AUDIO_TO_TEXT_MODEL || "",
  video_to_text_model: process.env.VIDEO_TO_TEXT_MODEL || "",
  embedding_model: process.env.EMBEDDING_MODEL || "google/gemini-embedding-001",
  image_model: process.env.IMAGE_MODEL || "google/gemini-3-pro-image-preview",
  get gemini_api_key() { return process.env.GEMINI_API_KEY; },
  memory_threshold: parseFloat(process.env.MEMORY_THRESHOLD || "") || 0.3,
  html_server_port: parseInt(process.env.HTML_SERVER_PORT || "3100", 10),
  get html_server_base_url() { return process.env.HTML_SERVER_BASE_URL || ""; },
};
