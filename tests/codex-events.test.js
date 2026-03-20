import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexSessionId,
  extractCodexText,
  normalizeCodexEvent,
} from "../harnesses/codex-events.js";

describe("codex events", () => {
  it("extracts session ids from thread and session fields", () => {
    assert.equal(extractCodexSessionId({ thread_id: "thread-1" }), "thread-1");
    assert.equal(extractCodexSessionId({ session_id: "session-1" }), "session-1");
    assert.equal(extractCodexSessionId({ item: { thread: { id: "thread-2" } } }), "thread-2");
  });

  it("extracts nested text from event payloads", () => {
    assert.equal(extractCodexText({ content: [{ text: "hello" }, { text: "world" }] }), "hello\nworld");
    assert.equal(extractCodexText({ steps: [{ text: "first" }, { text: "second" }] }), "first\nsecond");
  });

  it("normalizes command events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "pnpm test",
        stdout: "ok",
      },
    }), {
      sessionId: null,
      commandEvent: {
        command: "pnpm test",
        status: "completed",
        output: "ok",
      },
    });
  });

  it("normalizes plan and file events", () => {
    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "plan_update",
        content: [{ text: "step 1" }, { text: "step 2" }],
      },
    }), {
      sessionId: null,
      planText: "step 1\nstep 2",
    });

    assert.deepEqual(normalizeCodexEvent({
      type: "item.completed",
      item: {
        type: "file_patch",
        path: "src/app.js",
        summary: "updated app",
      },
    }), {
      sessionId: null,
      fileChange: {
        path: "src/app.js",
        summary: "updated app",
      },
    });
  });
});
