
import { spawn } from "node:child_process";

/**
 * @param {string} base64Data - Base64 encoded audio data
 * @returns {Promise<string>}
 */
export async function convertAudioToMp3Base64(base64Data) {
  const inputBuffer = Buffer.from(base64Data, "base64");
  const outputBuffer = await convertAudioBufferToMp3(inputBuffer);
  return outputBuffer.toString("base64");
}

/**
 * Convert arbitrary audio bytes to MP3 without writing temporary files.
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
function convertAudioBufferToMp3(inputBuffer) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-acodec",
      "libmp3lame",
      "-ab",
      "128k",
      "-f",
      "mp3",
      "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    /** @type {Buffer[]} */
    const stdout = [];
    /** @type {Buffer[]} */
    const stderr = [];

    ffmpeg.stdout.on("data", (chunk) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    ffmpeg.stderr.on("data", (chunk) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const details = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`ffmpeg audio conversion failed with code ${code}${details ? `: ${details}` : ""}`));
    });

    ffmpeg.stdin.end(inputBuffer);
  });
}
