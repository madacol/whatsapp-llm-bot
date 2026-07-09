# Output Visibility Vertical Coverage

## Status

Done.

## Goal

Verify every output-visibility category at the WhatsApp transport boundary with tests that prove visible settings produce user-visible messages and hidden/off settings suppress the corresponding messages.

## User Evidence

User correction on 2026-07-09:

> Verify that all settings truly work ... especially ... off or hidden settings ... assert that they produce the messages with the other settings, but when it is hidden, it does not produce anything.

Media: `/home/mada/whatsapp-llm-bot/.media/9c6a73fad2d373fa7212a2cc4f9933d48597ec2aac3ea4ee385a3f68869858cb.ogg`

## Test Seam

Primary seam: full WhatsApp adapter or hook-plus-WhatsApp transport path, observing rendered outbound WhatsApp messages from `createMockBaileysSocket`.

Lower-level hook tests are useful support, but they are not enough for this task because the reported failure is about messages that should not reach the user.

## Coverage Matrix

- `reasoning`: visible output is asserted by the ACP runtime visibility probe; hidden output is suppressed by the same probe under `reasoning: hidden`.
- `tools`: visible runtime tool output is asserted by existing ACP runtime tests and the visibility probe; hidden tool/command output is suppressed by the visibility probe under `tools: hidden`.
- `plans`: visible plan output is asserted by existing ACP runtime tests and the visibility probe; hidden plan output is suppressed by the visibility probe under `plans: hidden`.
- `fileChanges`: visible explicit file changes are asserted by existing ACP file-change tests; hidden explicit file changes are asserted with `diff only add` under `fileChanges: hidden`.
- `snapshots`: visible snapshot changes are asserted by existing ACP file-change tests; hidden snapshot changes are asserted with `direct delete` under `snapshots: off`.
- `subagents`: visible subagent output is asserted by existing ACP runtime tests and the visibility probe; hidden subagent output is suppressed by the visibility probe under `subagents: hidden`.
- `usage`: visible usage output is asserted by existing ACP runtime tests and the visibility probe; hidden usage output is suppressed by the visibility probe under `usage: hidden`; pinned usage remains covered in `sendBlocks`.
- `transcription`: visible transcription status is asserted by the audio adapter test; hidden transcription status is asserted by the audio adapter test under `transcription: hidden`.
- `middleAssistantMessages`: mid-turn assistant chunks are asserted through hook-plus-WhatsApp vertical coverage under `middleAssistantMessages: on` and suppressed under `middleAssistantMessages: off`, while full adapter tests still verify the final answer is preserved.

## Acceptance Criteria

- Each category has a vertical test that observes a visible/presenting setting producing the expected WhatsApp output.
- Each category has a vertical test that observes the hidden/off setting suppressing that category's output.
- Any leak found by the tests is fixed in the owning visibility layer.
- Targeted vertical tests and type checks pass.

## Completion Notes

Added an ACP `visibility probe` fixture that emits reasoning, plan, runtime command/tool activity, subagent output, explicit file change, assistant text, and usage in one turn. The full WhatsApp adapter tests now assert both visible output and suppression for the hidden/off category settings.

Added separate vertical tests for explicit file changes, snapshot-derived file changes, transcription status, and middle assistant messages.

The tests exposed a real leak: `tools: hidden` could still allow new runtime tool/command messages through `send-content.js`. The runtime renderer now suppresses new tool/command lifecycle messages when `tools` is hidden, while preserving already-started standalone action messages for mid-item live setting changes.

## Verification

- `pnpm test tests/vertical/whatsapp-adapter-e2e.test.js --test-name-pattern "visibility|audio transcription status"`
- `pnpm test tests/acp-read-presentation-vertical.test.js`
- `pnpm test tests/build-agent-io-hooks.test.js`
- `pnpm test tests/sendBlocks.test.js --test-name-pattern "live visibility|runtime command|runtime tool progress|pinned status|hidden"`
- `pnpm type-check`
- `pnpm type-check:tests`
- `git diff --check`
