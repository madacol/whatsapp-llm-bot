import { describe, it } from "node:test";
import {
  acpSessionUpdatesToBaileys,
  expectSentMessage,
  replayFixture,
  textEquals,
  textIncludes,
  whatsappInboundToBaileys,
} from "./vertical-slice-scenarios.js";
import { assistantOutputEvent } from "../outbound-events.js";

describe("declarative vertical-slice scenarios", () => {
  it("replays captured ACP payloads through WhatsApp presentation", async () => {
    await replayFixture({
      fixture: "vertical/acp-read-tool.json",
      pipeline: acpSessionUpdatesToBaileys(),
      expect: [
        expectSentMessage(0, { text: textEquals("🔧 *Read*  `src/app.js`") }),
        expectSentMessage(1, { text: textIncludes("✅ *Read*") }),
        expectSentMessage(1, { text: textIncludes("*10-12*") }),
      ],
    });
  });

  it("replays captured WhatsApp inbound events through final Baileys send", async () => {
    await replayFixture({
      fixture: "vertical/whatsapp-text-upsert.json",
      pipeline: whatsappInboundToBaileys({
        async handleTurn(turn) {
          const text = turn.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(" ");
          await turn.io.reply(assistantOutputEvent([{ type: "markdown", text: `received: ${text}` }]));
        },
      }),
      expect: [
        expectSentMessage(0, { text: textEquals("🤖 received: hello vertical slice") }),
      ],
    });
  });
});
