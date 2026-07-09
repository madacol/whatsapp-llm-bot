import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  getChatConfigPath,
  migrateChatConfigOutputVisibility,
  readChatConfig,
} from "../chat-config.js";

describe("chat config output visibility migration", () => {
  it("rewrites legacy output visibility flags into the new show contract", async () => {
    const chatId = `legacy-output-visibility-${Date.now()}`;
    const filePath = getChatConfigPath(chatId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify({
      chat_id: chatId,
      is_enabled: true,
      output_visibility: {
        thinking: false,
        toolStatus: true,
        changes: false,
        usage: false,
        subagents: false,
      },
    }, null, 2)}\n`);

    const result = await migrateChatConfigOutputVisibility(chatId);

    assert.deepEqual(result, {
      migrated: true,
      outputVisibility: {
        reasoning: "hidden",
        tools: "pinnedIndicator",
        fileChanges: "hidden",
        subagents: "hidden",
        usage: "hidden",
      },
    });
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(raw.output_visibility, result.outputVisibility);
    assert.equal("thinking" in raw.output_visibility, false);
    assert.equal("toolStatus" in raw.output_visibility, false);
    assert.equal("changes" in raw.output_visibility, false);

    const normalized = await readChatConfig(chatId);
    assert.deepEqual(normalized?.output_visibility, result.outputVisibility);
  });
});
