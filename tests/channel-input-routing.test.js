import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideChannelInputRoute } from "../conversation/channel-input-routing.js";

const enabledChat = Object.freeze({ is_enabled: true });
const disabledChat = Object.freeze({ is_enabled: false });
/** @type {ProjectRow} */
const project = Object.freeze({
  project_id: "project-1",
  name: "Checkout",
  root_path: "/repo",
  default_base_branch: "main",
  control_chat_id: null,
  timestamp: "2026-03-23T20:00:00.000Z",
});
/** @type {ResolvedChatBinding} */
const readyBinding = Object.freeze({ kind: "project", project });
/** @type {WorkspaceRow} */
const archivedWorkspace = Object.freeze({
  workspace_id: "workspace-1",
  project_id: "project-1",
  name: "payments",
  branch: "workspace/payments",
  base_branch: "main",
  worktree_path: "/repo-workspaces/payments",
  status: "archived",
  last_test_status: "not_run",
  last_commit_oid: null,
  conflicted_files: [],
  archived_at: "2026-03-23T20:00:00.000Z",
  timestamp: "2026-03-23T20:00:00.000Z",
});
/** @type {ResolvedChatBinding} */
const archivedWorkspaceBinding = Object.freeze({ kind: "workspace", project, workspace: archivedWorkspace });

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
