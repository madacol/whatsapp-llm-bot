import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexApprovalsReviewerOptions,
  extractCodexApprovalsReviewerOptionsFromTypescript,
  extractCodexApprovalPolicyOptions,
  extractCodexApprovalPolicyOptionsFromHelp,
  extractCodexSandboxModeOptions,
  extractCodexSandboxModeOptionsFromHelp,
} from "../harnesses/codex-config.js";

describe("codex config", () => {
  it("extracts string approval policy options from app-server requirements", () => {
    assert.deepEqual(extractCodexApprovalPolicyOptions({
      requirements: {
        allowedApprovalPolicies: [
          "untrusted",
          "on-failure",
          "on-request",
          { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } },
          "never",
          "future-policy",
        ],
      },
    }), ["untrusted", "on-failure", "on-request", "never"]);
  });

  it("extracts approval policy options from Codex CLI help", () => {
    assert.deepEqual(extractCodexApprovalPolicyOptionsFromHelp([
      "      --ask-for-approval <APPROVAL_POLICY>",
      "          Possible values:",
      "          - untrusted:  Only run trusted commands without asking",
      "          - on-failure: Deprecated fallback mode",
      "          - on-request: The model decides when to ask",
      "          - never:      Never ask for approval",
    ].join("\n")), ["untrusted", "on-failure", "on-request", "never"]);
  });

  it("extracts sandbox mode options from app-server requirements", () => {
    assert.deepEqual(extractCodexSandboxModeOptions({
      requirements: {
        allowedSandboxModes: ["read-only", "workspace-write", "future-mode", "danger-full-access"],
      },
    }), ["read-only", "workspace-write", "danger-full-access"]);
  });

  it("extracts sandbox mode options from Codex CLI help", () => {
    assert.deepEqual(extractCodexSandboxModeOptionsFromHelp([
      "  -s, --sandbox <SANDBOX_MODE>",
      "          [possible values: read-only, workspace-write, danger-full-access]",
    ].join("\n")), ["read-only", "workspace-write", "danger-full-access"]);
  });

  it("extracts approval reviewer options from app-server requirements when present", () => {
    assert.deepEqual(extractCodexApprovalsReviewerOptions({
      requirements: {
        allowedApprovalsReviewers: ["user", "auto_review"],
      },
    }), ["user", "auto_review"]);
  });

  it("extracts approval reviewer options from generated Codex protocol types", () => {
    assert.deepEqual(extractCodexApprovalsReviewerOptionsFromTypescript(
      'export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";',
    ), ["user", "auto_review", "guardian_subagent"]);
  });
});
