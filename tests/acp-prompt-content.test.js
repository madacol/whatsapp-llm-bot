import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildAcpPromptContent } from "../harnesses/acp-runner.js";

describe("buildAcpPromptContent", () => {
  it("keeps text prompt and appends semantic image and resource-link blocks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-prompt-content-"));
    const imagePath = path.join(tempDir, "input.png");
    const documentPath = path.join(tempDir, "notes.txt");
    await fs.writeFile(imagePath, Buffer.from("image-bytes"));
    await fs.writeFile(documentPath, "document text", "utf8");

    try {
      const prompt = await buildAcpPromptContent("Read these inputs", [
        { type: "image", path: imagePath, mime_type: "image/png" },
        { type: "file", path: documentPath, mime_type: "text/plain", file_name: "notes.txt" },
      ]);

      assert.deepEqual(prompt.map((block) => block.type), ["text", "image", "resource_link"]);
      assert.deepEqual(prompt[0], { type: "text", text: "Read these inputs" });
      assert.deepEqual(prompt[1], {
        type: "image",
        data: Buffer.from("image-bytes").toString("base64"),
        mimeType: "image/png",
        uri: pathToFileURL(imagePath).href,
      });
      assert.deepEqual(prompt[2], {
        type: "resource_link",
        uri: pathToFileURL(documentPath).href,
        name: "notes.txt",
        mimeType: "text/plain",
        size: Buffer.byteLength("document text"),
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not add extra blocks for slash-command text without attachments", async () => {
    assert.deepEqual(await buildAcpPromptContent("/status", []), [{ type: "text", text: "/status" }]);
  });

  it("resolves relative resource links from the ACP workdir", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-prompt-content-workdir-"));
    await fs.writeFile(path.join(tempDir, "notes.txt"), "from workdir", "utf8");

    try {
      const prompt = await buildAcpPromptContent("Read this", [
        { type: "file", path: "notes.txt", mime_type: "text/plain" },
      ], tempDir);

      assert.deepEqual(prompt[1], {
        type: "resource_link",
        uri: pathToFileURL(path.join(tempDir, "notes.txt")).href,
        name: "notes.txt",
        mimeType: "text/plain",
        size: Buffer.byteLength("from workdir"),
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
