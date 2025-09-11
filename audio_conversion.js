
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

/**
 *
 * @param {string} base64Data - Base64 encoded audio data
 * @returns {string}
 */
export function convertAudioToMp3(base64Data) {
  // Create temporary file paths
  const tempDir = tmpdir();
    const inputFile = path.join(tempDir, `input_${Date.now()}.tmp`);
    const outputFile = path.join(tempDir, `output_${Date.now()}.mp3`);

    try {
        // Convert base64 to buffer and write to temporary file
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(inputFile, buffer);

        // Execute ffmpeg command to convert to mp3
        const command = `ffmpeg -i "${inputFile}" -acodec mp3 -ab 128k "${outputFile}"`;
        execSync(command);

        // Read the output file and convert to base64
        const outputBuffer = fs.readFileSync(outputFile);
        const outputBase64 = outputBuffer.toString('base64');

        // Clean up temporary files
        fs.unlinkSync(inputFile);
        fs.unlinkSync(outputFile);

        // Return the result
        return outputBase64

    } catch (error) {
        // Clean up files in case of error
        if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
        if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

        throw error;
    }
}
