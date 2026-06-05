import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { codexAcpEntryPoint } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp search tool calls", () => {
  it("emits semantic raw input for Codex search command actions", async () => {
    const source = await fs.readFile(codexAcpEntryPoint, "utf8");

    assert.match(
      source,
      /commandAction\.type === "search"[\s\S]*kind: "search"[\s\S]*rawInput: \{[\s\S]*pattern: commandAction\.query,[\s\S]*path: commandAction\.path[\s\S]*\}/,
    );
  });
});
