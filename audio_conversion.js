
import { execFile } from "node:child_process";
import { writeFile, readFile, unlink, access } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

/**
 * @param {string} base64Data - Base64 encoded audio data
 * @returns {Promise<string>}
 */
export async function convertAudioToMp3Base64(base64Data) {
  const tempDir = tmpdir();
  const inputFile = path.join(tempDir, `input_${Date.now()}.tmp`);
  const outputFile = path.join(tempDir, `output_${Date.now()}.mp3`);

  try {
    const buffer = Buffer.from(base64Data, "base64");
    await writeFile(inputFile, buffer);

    await execFileAsync("ffmpeg", ["-i", inputFile, "-acodec", "mp3", "-ab", "128k", outputFile]);

    const outputBuffer = await readFile(outputFile);
    const outputBase64 = outputBuffer.toString("base64");

    await unlink(inputFile);
    await unlink(outputFile);

    return outputBase64;
  } catch (error) {
    // Clean up files in case of error
    try { await access(inputFile); await unlink(inputFile); } catch { /* file doesn't exist */ }
    try { await access(outputFile); await unlink(outputFile); } catch { /* file doesn't exist */ }

    throw error;
  }
}
