import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideTurnRoute } from "../conversation/turn-routing.js";

const enabledChat = Object.freeze({ is_enabled: true });
const disabledChat = Object.freeze({ is_enabled: false });
const readyBinding = Object.freeze({ kind: "project" });
const archivedWorkspaceBinding = Object.freeze({
  kind: "workspace",
  workspace: { status: "archived" },
});

describe("decideTurnRoute", () => {
  it("routes bang commands before archived workspace coding rejection", () => {
    assert.deepEqual(
      decideTurnRoute({
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
      decideTurnRoute({
        chatInfo: enabledChat,
        resolvedBinding: archivedWorkspaceBinding,
        firstText: "fix the checkout bug",
        hasPendingRun: false,
        shouldRespond: true,
      }),
      { type: "archived-workspace-error" },
    );
  });

  it("turns disabled slash commands into an explicit route", () => {
    assert.deepEqual(
      decideTurnRoute({
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
      decideTurnRoute({
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
      decideTurnRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "not addressed to bot",
        hasPendingRun: false,
        shouldRespond: false,
      }),
      { type: "persist-only" },
    );
  });

  it("routes unhandled slash commands through the harness path", () => {
    assert.deepEqual(
      decideTurnRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "/unknown",
        hasPendingRun: false,
        shouldRespond: false,
      }),
      { type: "slash-command" },
    );
  });

  it("routes normal responding messages through the harness path", () => {
    assert.deepEqual(
      decideTurnRoute({
        chatInfo: enabledChat,
        resolvedBinding: readyBinding,
        firstText: "please investigate",
        hasPendingRun: false,
        shouldRespond: true,
      }),
      { type: "harness-run" },
    );
  });
});
