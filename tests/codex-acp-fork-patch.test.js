import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { codexAcpEntryPoint } from "./codex-acp-patch-fixture.js";

describe("patched codex-acp session fork", () => {
  it("advertises ACP fork and forwards session/fork to Codex thread/fork", async () => {
    const source = await fs.readFile(codexAcpEntryPoint, "utf8");

    assert.match(
      source,
      /sessionCapabilities: \{[\s\S]*resume: \{\},[\s\S]*list: \{\},[\s\S]*fork: \{\},[\s\S]*steer: \{\}[\s\S]*\}/,
    );
    assert.match(
      source,
      /async forkSession\(request\) \{[\s\S]*this\.codexClient\.threadFork\(\{[\s\S]*threadId: request\.sessionId[\s\S]*sessionId: response\.thread\.id[\s\S]*thread: response\.thread[\s\S]*\}/,
    );
    assert.match(
      source,
      /async unstable_forkSession\(params\) \{[\s\S]*this\.getForkedSessionWithHistory\(params\)[\s\S]*return \{[\s\S]*sessionId,[\s\S]*models: modelState,[\s\S]*modes: modeState,[\s\S]*configOptions[\s\S]*\}/,
    );
    assert.match(
      source,
      /async threadFork\(params\) \{[\s\S]*method: "thread\/fork"[\s\S]*\}/,
    );
  });
});
