import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runScenario } from "./scenario-runner.js";
import { RAW_LID_POLL_FIXTURE } from "./poll-vote-fixtures.js";
import {
  rawLidPollIdentity,
  rawLidPollVoteMessage,
  replayWhatsAppInboundSmokeCapture,
  waitForPollSent,
  whatsappTextMessage,
  whatsappSelectManyModule,
} from "./whatsapp-transport-scenario-modules.js";

describe("WhatsApp transport scenarios", () => {
  it("proves the scenario runner with captured-shape raw LID selectMany poll votes", async () => {
    const selectedOption = "⚪ Show pinned tool status";
    const pollOptions = [
      { id: "pinned_tool_status", label: selectedOption },
      { id: "hide_thinking", label: "🟢 Hide thinking" },
      { id: "hide_file_changes", label: "🟢 Hide file changes" },
      { id: "hide_sub_agent_output", label: "🟢 Hide sub-agent output" },
      { id: "hide_all_extras", label: "⚪ Hide all extras" },
    ];

    await runScenario([
      whatsappSelectManyModule({
        identity: rawLidPollIdentity(RAW_LID_POLL_FIXTURE),
        pollMessageId: RAW_LID_POLL_FIXTURE.pollMsgId,
        prompt: "Choose which extra agent progress outputs are shown in chat.",
        options: pollOptions,
        deleteOnSelect: true,
        replyWithSelectionJson: true,
      }),

      replayWhatsAppInboundSmokeCapture({
        type: "notify",
        messages: [
          whatsappTextMessage({
            chatId: RAW_LID_POLL_FIXTURE.chatId,
            text: "choose",
            senderId: "poll-user",
          }),
        ],
      }),

      waitForPollSent(),

      replayWhatsAppInboundSmokeCapture({
        type: "notify",
        messages: [
          rawLidPollVoteMessage({
            fixture: RAW_LID_POLL_FIXTURE,
            id: "VOTE-LID-CAPTURED-SHAPE-1",
            selectedOption,
          }),
        ],
      }),

      async (ctx) => {
        assert.deepEqual(await ctx.result("selectMany"), {
          kind: "selected",
          ids: ["pinned_tool_status"],
        });

        assert.ok(
          ctx.sentMessages.some((entry) => {
            const message = /** @type {{ delete?: { id?: string } }} */ (entry.message);
            return message.delete?.id === RAW_LID_POLL_FIXTURE.pollMsgId;
          }),
          `Expected poll delete settlement, got ${JSON.stringify(ctx.sentMessages)}`,
        );
        assert.ok(
          ctx.sentMessages.some((entry) =>
            typeof entry.message.text === "string"
            && entry.message.text.includes("pinned_tool_status")),
          `Expected selected reply, got ${JSON.stringify(ctx.sentMessages)}`,
        );
      },
    ]);
  });
});
