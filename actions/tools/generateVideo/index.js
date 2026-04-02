import config from "../../../config.js";
import { createLogger } from "../../../logger.js";
import { readBlockBase64, writeMedia } from "../../../media-store.js";

const log = createLogger("generateVideo");

// ── fal.ai helpers (mutable object for test mocking) ──

/**
 * @typedef {{ statusUrl: string, responseUrl: string }} SubmitResult
 * @typedef {{ url: string, content_type: string }} FalVideo
 * @typedef {{ video: FalVideo }} FalResult
 */

/** Mutable API surface — tests replace individual methods to mock fal.ai calls. */
export const falApi = {
  /** @type {number} */
  pollIntervalMs: 10_000,

  /** @type {number} */
  maxPollAttempts: 60,

  /**
   * Submit a job to fal.ai queue.
   * @param {string} endpoint
   * @param {Record<string, unknown>} input
   * @param {string} apiKey
   * @returns {Promise<SubmitResult>}
   */
  submitJob: async (endpoint, input, apiKey) => {
    const res = await fetch(`https://queue.fal.run/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fal.ai submit failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    return { statusUrl: data.status_url, responseUrl: data.response_url };
  },

  /**
   * Poll a fal.ai job until COMPLETED or timeout.
   * @param {string} statusUrl
   * @param {string} apiKey
   * @returns {Promise<void>}
   */
  pollJob: async (statusUrl, apiKey) => {
    for (let i = 0; i < falApi.maxPollAttempts; i++) {
      if (falApi.pollIntervalMs > 0) {
        await new Promise((r) => setTimeout(r, falApi.pollIntervalMs));
      }
      const res = await fetch(statusUrl, {
        headers: { Authorization: `Key ${apiKey}` },
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`fal.ai poll failed (${res.status}): ${text}`);
      }
      const data = await res.json();
      if (data.status === "COMPLETED") return;
      if (data.status !== "IN_QUEUE" && data.status !== "IN_PROGRESS") {
        throw new Error(`fal.ai unexpected status: ${data.status}`);
      }
    }
    throw new Error("Video generation timed out after polling.");
  },

  /**
   * Get result from a completed fal.ai job.
   * @param {string} responseUrl
   * @param {string} apiKey
   * @returns {Promise<FalResult>}
   */
  getResult: async (responseUrl, apiKey) => {
    const res = await fetch(responseUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`fal.ai result fetch failed (${res.status}): ${text}`);
    }
    return res.json();
  },

  /**
   * Upload an image to fal.ai CDN for image-to-video.
   * @param {string} base64Data
   * @param {string} mimeType
   * @param {string} apiKey
   * @returns {Promise<string>}
   */
  uploadImage: async (base64Data, mimeType, apiKey) => {
    const ext = mimeType.split("/")[1] || "bin";
    const initRes = await fetch(
      "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3",
      {
        method: "POST",
        headers: {
          Authorization: `Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content_type: mimeType, file_name: `input.${ext}` }),
      },
    );
    if (!initRes.ok) {
      const text = await initRes.text();
      throw new Error(`fal.ai upload initiate failed (${initRes.status}): ${text}`);
    }
    const { file_url, upload_url } = await initRes.json();

    const buf = Buffer.from(base64Data, "base64");
    const putRes = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: buf,
    });
    if (!putRes.ok) {
      const text = await putRes.text();
      throw new Error(`fal.ai upload PUT failed (${putRes.status}): ${text}`);
    }

    return file_url;
  },
};

export default /** @type {defineAction} */ ((x) => x)({
  name: "generate_video",
  description:
    "Generate a video from a text prompt using AI (fal.ai, configurable model). Optionally include a reference image for image-to-video generation. Supports aspect ratio, duration, and negative prompt parameters.",
  sharedSkill: {
    name: "generate-video",
    description: "Generate a video artifact and return it to the chat.",
    instructions: `Use this skill when the user needs a generated video artifact.
- Provide a clear prompt describing the video.
- Include a reference image when the request is image-to-video.
- Use aspect ratio, duration, and negative prompt fields when they matter to the request.
- The generated result should be returned as a video attachment to the chat.`,
  },
  parameters: {
    type: "object",
    properties: {
      image: {
        type: "image",
        description: "Optional reference image for image-to-video generation",
      },
      prompt: {
        type: "string",
        description: "Text description of the video to generate",
      },
      aspect_ratio: {
        type: "string",
        description: "Aspect ratio (e.g. '16:9', '9:16'). Defaults to '16:9'",
      },
      duration_seconds: {
        type: "number",
        description: "Duration in seconds (5 or 10). Defaults to 5",
      },
      negative_prompt: {
        type: "string",
        description: "Things to avoid in the generated video",
      },
    },
    required: ["prompt"],
  },
  formatToolCall: ({ prompt }) => {
    const maxLen = 60;
    const label = "Generating video";
    if (!prompt) return label;
    const short = prompt.length > maxLen ? prompt.slice(0, maxLen) + "…" : prompt;
    return `${label}: "${short}"`;
  },
  permissions: {
    autoExecute: true,
    autoContinue: true,
  },
  /**
   * @param {ActionContext} _context
   * @param {{ image?: ImageContentBlock | null, prompt: string, aspect_ratio?: string, duration_seconds?: number, negative_prompt?: string }} params
   */
  action_fn: async function (_context, params) {
    const apiKey = config.fal_api_key;
    if (!apiKey) {
      return "Error: FAL_KEY must be configured to generate videos.";
    }

    const model = config.video_model;
    const image = params.image ?? undefined;

    // Build endpoint and input
    /** @type {Record<string, unknown>} */
    const input = { prompt: params.prompt };
    if (params.duration_seconds) input.duration = String(params.duration_seconds);
    if (params.aspect_ratio) input.aspect_ratio = params.aspect_ratio;
    if (params.negative_prompt) input.negative_prompt = params.negative_prompt;

    /** @type {string} */
    let endpoint;

    try {
      if (image) {
        const fileUrl = await falApi.uploadImage(await readBlockBase64(image), image.mime_type, apiKey);
        input.start_image_url = fileUrl;
        endpoint = `${model}/image-to-video`;
      } else {
        endpoint = `${model}/text-to-video`;
      }

      const { statusUrl, responseUrl } = await falApi.submitJob(endpoint, input, apiKey);
      await falApi.pollJob(statusUrl, apiKey);
      const result = await falApi.getResult(responseUrl, apiKey);

      if (!result.video?.url) {
        log.warn("fal.ai returned no video. Full response:", JSON.stringify(result, null, 2));
        return "Error: no video was returned by the model. Check logs for details.";
      }

      // Download video from CDN URL
      const downloadRes = await fetch(result.video.url);
      if (!downloadRes.ok) {
        return `Error: Failed to download video (status ${downloadRes.status}).`;
      }

      const arrayBuffer = await downloadRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const caption = `Generated video: ${params.prompt}`;
      /** @type {ToolContentBlock[]} */
      const contentBlocks = [
        { type: "text", text: caption },
        { type: "video", path: await writeMedia(buffer, "video/mp4", "video"), mime_type: "video/mp4" },
      ];

      return { result: contentBlocks };
    } catch (/** @type {unknown} */ err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Video generation failed:", message);
      return `Error: ${message}`;
    }
  },
});
