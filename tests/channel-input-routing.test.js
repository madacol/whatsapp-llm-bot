import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideChannelInputRoute } from "../conversation/channel-input-routing.js";

const enabledChat = Object.freeze({ is_enabled: true });
const disabledChat = Object.freeze({ is_enabled: false });
const readyBinding = Object.freeze({ kind: "project" });
const archivedWorkspaceBinding = Object.freeze({
  kind: "workspace",
  workspace: { status: "archived" },
});

describe("decideChannelInputRoute", () => {
  it("routes bang commands before archived workspace coding rejection", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: enabledChat,
        resolvedBinding: archivedWorkspaceBinding,
        firstText: "!status",
        hasPendingRun: false,
        shouldRespond: false,
      }),
      { type: "bang-command" },
    );
  });

  it("rejects normal coding requests in archived workspaces", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: enabledChat,
        resolvedBinding: archivedWorkspaceBinding,
        firstText: "fix the checkout bug",
        hasPendingRun: false,
        shouldRespond: true,
      }),
      { type: "archived-workspace-error" },
    );
  });

  it("routes disabled slash commands into an explicit route", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: disabledChat,
        resolvedBinding: readyBinding,
        firstText: "/status",
        hasPendingRun: false,
        shouldRespond: false,
      }),
      { type: "disabled-slash-command" },
    );
  });

  it("keeps pending follow-up persistence separate from response policy", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "background context",
        hasPendingRun: true,
        shouldRespond: false,
      }),
      { type: "pending-followup", shouldRespond: false },
    );
  });

  it("routes normal ignored messages as persist-only", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "not addressed to bot",
        hasPendingRun: false,
        shouldRespond: false,
      }),
      { type: "persist-only" },
    );
  });

  it("routes unhandled slash commands through the slash-command path", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "/unknown",
        hasPendingRun: false,
        shouldRespond: false,
      }),
      { type: "slash-command" },
    );
  });

  it("routes normal responding messages into an agent invocation", () => {
    assert.deepEqual(
      decideChannelInputRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "please investigate",
        hasPendingRun: false,
        shouldRespond: true,
      }),
      { type: "agent-invocation" },
    );
  });
});
