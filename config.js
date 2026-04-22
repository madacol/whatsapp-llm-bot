import dotenv from "dotenv";
dotenv.config();

const system_prompt = `You are Madabot, a helpful AI assistant.`;

export default {
  get MASTER_IDs() { return process.env.MASTER_ID?.split(',').map(s => s.trim()).filter(Boolean) ?? []; },
  set MASTER_IDs(v) { process.env.MASTER_ID = v.join(','); },

  get model() { return process.env.MODEL || "gpt-4.1"; },
  get llm_api_key() { return process.env.LLM_API_KEY; },
  get base_url() { return process.env.BASE_URL; },
  get system_prompt() { return process.env.SYSTEM_PROMPT || system_prompt; },

  get brave_api_key() { return process.env.BRAVE_API_KEY; },
  set brave_api_key(v) { if (v) process.env.BRAVE_API_KEY = v; else delete process.env.BRAVE_API_KEY; },

  get media_to_text_model() { return process.env.MEDIA_TO_TEXT_MODEL || ""; },
  set media_to_text_model(v) { if (v) process.env.MEDIA_TO_TEXT_MODEL = v; else delete process.env.MEDIA_TO_TEXT_MODEL; },

  get image_to_text_model() { return process.env.IMAGE_TO_TEXT_MODEL || ""; },
  set image_to_text_model(v) { if (v) process.env.IMAGE_TO_TEXT_MODEL = v; else delete process.env.IMAGE_TO_TEXT_MODEL; },

  get audio_to_text_model() { return process.env.AUDIO_TO_TEXT_MODEL || ""; },

  get video_to_text_model() { return process.env.VIDEO_TO_TEXT_MODEL || ""; },
  set video_to_text_model(v) { if (v) process.env.VIDEO_TO_TEXT_MODEL = v; else delete process.env.VIDEO_TO_TEXT_MODEL; },

  get embedding_model() { return process.env.EMBEDDING_MODEL || ""; },
  get image_model() { return process.env.IMAGE_MODEL || "google/gemini-3-pro-image-preview"; },
  get coding_model() { return process.env.CODING_MODEL || ""; },
  get smart_model() { return process.env.SMART_MODEL || ""; },
  get fast_model() { return process.env.FAST_MODEL || ""; },
  get gemini_api_key() { return process.env.GEMINI_API_KEY; },
  get fal_api_key() { return process.env.FAL_KEY; },
  get video_model() { return process.env.VIDEO_MODEL || "fal-ai/kling-video/v3/standard"; },
  get memory_threshold() { return parseFloat(process.env.MEMORY_THRESHOLD || "") || 0.68; },
  get html_server_port() { return parseInt(process.env.HTML_SERVER_PORT || "3100", 10); },
  get html_server_base_url() { return process.env.HTML_SERVER_BASE_URL || ""; },

  get smtp_host() { return process.env.SMTP_HOST || ""; },
  get smtp_port() { return parseInt(process.env.SMTP_PORT || "587", 10); },
  get smtp_user() { return process.env.SMTP_USER || ""; },
  get smtp_pass() { return process.env.SMTP_PASS || ""; },
  get alert_email() { return process.env.ALERT_EMAIL || ""; },

  get workspaces_dir() { return process.env.WORKSPACES_DIR || ""; },
};
