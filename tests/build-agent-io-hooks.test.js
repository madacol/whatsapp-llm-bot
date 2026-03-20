import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentIoHooks } from "../conversation/build-agent-io-hooks.js";

/**
 * @returns {{
 *   hooks: AgentIOHooks,
 *   sent: Array<{ source: MessageSource, content: SendContent, kind: "send" | "reply" }>,
 * }}
 */
function createSubject() {
  /** @type {Array<{ source: MessageSource, content: SendContent, kind: "send" | "reply" }>} */
  const sent = [];
  const hooks = buildAgentIoHooks(
    {
      send: async (source, content) => {
        sent.push({ source, content, kind: "send" });
        return undefined;
      },
      reply: async (source, content) => {
        sent.push({ source, content, kind: "reply" });
        return undefined;
      },
      select: async () => "",
      confirm: async () => true,
    },
    async () => {},
    null,
  );
  return { hooks, sent };
}

describe("buildAgentIoHooks", () => {
  it("maps plan events to an llm reply", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onPlan?.("Step 1\nStep 2");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "reply");
    assert.equal(sent[0].source, "llm");
  });

  it("maps command start events to a tool-call message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onCommand?.({ command: "npm test", status: "started" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].source, "tool-call");
  });

  it("maps file changes to a tool-result message", async () => {
    const { hooks, sent } = createSubject();
    await hooks.onFileChange?.({ path: "/tmp/file.js", summary: "Updated file" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "send");
    assert.equal(sent[0].source, "tool-result");
  });
});
