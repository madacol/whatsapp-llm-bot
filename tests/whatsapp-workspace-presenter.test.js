import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentEvent } from "../outbound-events.js";
import { createWhatsAppWorkspacePresenter } from "../whatsapp/workspace-presenter.js";

describe("WhatsAppWorkspacePresenter", () => {
  it("provisions a workspace surface as a named group and promotes requesters", async () => {
    /** @type {Array<{ subject: string, participants: string[] }>} */
    const created = [];
    /** @type {Array<{ chatId: string, participants: string[] }>} */
    const promoted = [];
    const presenter = createWhatsAppWorkspacePresenter({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createGroup: async (subject, participants) => {
          created.push({ subject, participants });
          return { chatId: "workspace-chat", subject };
        },
        promoteParticipants: async (chatId, participants) => {
          promoted.push({ chatId, participants });
        },
      },
    });

    const surface = await presenter.provisionWorkspaceSurface({
      workspaceName: "payments",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(created, [{
      subject: "[payments] Original Group",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.deepEqual(promoted, [{
      chatId: "workspace-chat",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "[payments] Original Group",
    });
  });

  it("delivers semantic workspace events through the adapter transport", async () => {
    /** @type {Array<{ chatId: string, event: OutboundEvent }>} */
    const sentEvents = [];
    /** @type {MessageHandle} */
    const handle = {
      keyId: "workspace-msg-1",
      isImage: false,
      update: async () => {},
      setInspect: () => {},
    };
    const presenter = createWhatsAppWorkspacePresenter({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {
          assert.fail("sendText should not be used when sendEvent is available");
        },
        sendEvent: async (chatId, event) => {
          sentEvents.push({ chatId, event });
          return handle;
        },
      },
    });

    const returned = await presenter.sendWorkspaceEvent({
      surfaceId: "workspace-chat",
      event: contentEvent("llm", [{ type: "text", text: "Thinking..." }]),
    });

    assert.equal(returned, handle);
    assert.deepEqual(sentEvents, [{
      chatId: "workspace-chat",
      event: contentEvent("llm", [{ type: "text", text: "Thinking..." }]),
    }]);
  });

  it("delivers bootstrap and seed prompt text through semantic content events", async () => {
    /** @type {Array<{ chatId: string, text: string }>} */
    const sentTexts = [];
    /** @type {Array<{ chatId: string, event: OutboundEvent }>} */
    const sentEvents = [];
    const presenter = createWhatsAppWorkspacePresenter({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async (chatId, text) => {
          sentTexts.push({ chatId, text });
        },
        sendEvent: async (chatId, event) => {
          sentEvents.push({ chatId, event });
          return undefined;
        },
      },
    });

    await presenter.presentWorkspaceBootstrap({
      surfaceId: "workspace-chat",
      statusText: "Workspace: payments",
    });
    await presenter.presentSeedPrompt({
      surfaceId: "workspace-chat",
      promptText: "Prompt: investigate duplicate charges",
    });

    assert.deepEqual(sentTexts, []);
    assert.deepEqual(sentEvents, [
      {
        chatId: "workspace-chat",
        event: contentEvent("plain", [{ type: "text", text: "Workspace: payments" }]),
      },
      {
        chatId: "workspace-chat",
        event: contentEvent("plain", [{ type: "text", text: "Prompt: investigate duplicate charges" }]),
      },
    ]);
  });
});
