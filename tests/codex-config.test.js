import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCodexApprovalPolicyOptions,
  extractCodexApprovalPolicyOptionsFromHelp,
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
});
