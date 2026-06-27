import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createAgentSessionPersistence } from "../conversation/session-persistence.js";

describe("Agent Session persistence", () => {
  it("translates legacy harness storage methods into Session vocabulary", async () => {
    /** @type {unknown[]} */
    const calls = [];
    const persistence = createAgentSessionPersistence({
      saveHarnessSession: async (channelId, session) => {
        calls.push(["save", channelId, session]);
      },
      archiveHarnessSession: async (channelId, options) => {
        calls.push(["archive", channelId, options]);
        return { id: "archived-session", kind: "codex", cleared_at: "2026-06-27T00:00:00.000Z", title: "Old work" };
      },
      getHarnessSessionHistory: async (channelId) => {
        calls.push(["history", channelId]);
        return [{ id: "archived-session", kind: "codex", cleared_at: "2026-06-27T00:00:00.000Z", title: null }];
      },
      restoreHarnessSession: async (channelId, indexOrId) => {
        calls.push(["restore", channelId, indexOrId]);
        return { id: "archived-session", kind: "codex", cleared_at: "2026-06-27T00:00:00.000Z", title: null };
      },
      pushHarnessForkStack: async (channelId, entry) => {
        calls.push(["pushFork", channelId, entry]);
      },
      popHarnessForkStack: async (channelId) => {
        calls.push(["popFork", channelId]);
        return { id: "fork-session", kind: "codex", label: "fork" };
      },
    });

    assert.deepEqual(Object.keys(persistence).sort(), [
      "archiveActiveSession",
      "getArchivedSessions",
      "popForkedSession",
      "pushForkedSession",
      "restoreArchivedSession",
      "saveActiveSession",
    ]);

    await persistence.saveActiveSession("channel-1", { id: "session-1", kind: "codex" });
    assert.equal((await persistence.getArchivedSessions("channel-1")).length, 1);
    assert.equal((await persistence.archiveActiveSession("channel-1", { title: "Old work" }))?.id, "archived-session");
    assert.equal((await persistence.restoreArchivedSession("channel-1", 0))?.id, "archived-session");
    await persistence.pushForkedSession("channel-1", { id: "fork-session", kind: "codex", label: "fork" });
    assert.equal((await persistence.popForkedSession("channel-1"))?.id, "fork-session");

    assert.deepEqual(calls, [
      ["save", "channel-1", { id: "session-1", kind: "codex" }],
      ["history", "channel-1"],
      ["archive", "channel-1", { title: "Old work" }],
      ["restore", "channel-1", 0],
      ["pushFork", "channel-1", { id: "fork-session", kind: "codex", label: "fork" }],
      ["popFork", "channel-1"],
    ]);
  });
});
