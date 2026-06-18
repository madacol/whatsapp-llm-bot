import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentEvent } from "../outbound-events.js";
import { createWhatsAppWorkspacePresenter } from "../whatsapp/workspace-presenter.js";

/**
 * @param {{
 *   existingPresentation?: WhatsAppWorkspacePresentationRow | null,
 * }} [options]
 */
function createStore(options = {}) {
  /** @type {Array<{
   *   projectId: string,
   *   workspaceId: string,
   *   workspaceChatId: string,
   *   workspaceChatSubject: string,
   *   role?: WhatsAppWorkspacePresentationRole,
   *   linkedCommunityChatId?: string | null,
   * }>} */
  const storedPresentations = [];
  return {
    storedPresentations,
    store: {
      getWhatsAppWorkspacePresentation: async () => options.existingPresentation ?? null,
      saveWhatsAppWorkspacePresentation: async (input) => {
        storedPresentations.push(input);
      },
    },
  };
}

describe("WhatsAppWorkspacePresenter", () => {
  it("creates standalone workspace groups with project-qualified titles", async () => {
    /** @type {Array<{ subject: string, participants: string[] }>} */
    const createdGroups = [];
    /** @type {Array<{ chatId: string, participants: string[] }>} */
    const promoted = [];
    const storeState = createStore();
    const presenter = createWhatsAppWorkspacePresenter({
      store: storeState.store,
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createGroup: async (subject, participants) => {
          createdGroups.push({ subject, participants });
          return { chatId: "workspace-chat", subject };
        },
        createCommunity: async () => {
          assert.fail("workspace creation should not create WhatsApp communities");
        },
        createCommunityGroup: async () => {
          assert.fail("standalone source chats should create standalone groups");
        },
        getGroupLinkedParent: async () => null,
        promoteParticipants: async (chatId, participants) => {
          promoted.push({ chatId, participants });
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "project-1",
      projectName: "Checkout",
      workspaceId: "ws-1",
      workspaceName: "payments",
      sourceChatId: "source-chat",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdGroups, [{
      subject: "Checkout - payments",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.deepEqual(promoted, [{
      chatId: "workspace-chat",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.deepEqual(storeState.storedPresentations, [{
      projectId: "project-1",
      workspaceId: "ws-1",
      workspaceChatId: "workspace-chat",
      workspaceChatSubject: "Checkout - payments",
      role: "workspace",
      linkedCommunityChatId: null,
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "Checkout - payments",
    });
  });

  it("creates new workspaces inside the source chat community when one exists", async () => {
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    const storeState = createStore();
    const presenter = createWhatsAppWorkspacePresenter({
      store: storeState.store,
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createGroup: async () => {
          assert.fail("linked source chats should create community groups");
        },
        createCommunity: async () => {
          assert.fail("workspace creation should not create WhatsApp communities");
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return { chatId: "workspace-chat", subject };
        },
        getGroupLinkedParent: async (chatId) => {
          assert.equal(chatId, "source-chat");
          return "community-chat";
        },
        linkExistingGroupToCommunity: async () => {
          assert.fail("workspace creation should not link existing groups into communities");
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "project-1",
      projectName: "Checkout",
      workspaceId: "ws-2",
      workspaceName: "fraud-fix",
      sourceChatId: "source-chat",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunityGroups, [{
      subject: "Checkout - fraud-fix",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(storeState.storedPresentations, [{
      projectId: "project-1",
      workspaceId: "ws-2",
      workspaceChatId: "workspace-chat",
      workspaceChatSubject: "Checkout - fraud-fix",
      role: "workspace",
      linkedCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "Checkout - fraud-fix",
    });
  });

  it("creates community workspace groups with source chat participants", async () => {
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    const storeState = createStore();
    const presenter = createWhatsAppWorkspacePresenter({
      store: storeState.store,
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return { chatId: "workspace-chat", subject };
        },
        getGroupLinkedParent: async () => "community-chat",
        getGroupParticipants: async (chatId) => {
          assert.equal(chatId, "source-chat");
          return [
            "teammate@s.whatsapp.net",
            "user@s.whatsapp.net",
            "teammate@s.whatsapp.net",
          ];
        },
      },
    });

    await presenter.ensureWorkspaceVisible({
      projectId: "project-1",
      projectName: "Checkout",
      workspaceId: "ws-participants",
      workspaceName: "fraud-fix",
      sourceChatId: "source-chat",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunityGroups, [{
      subject: "Checkout - fraud-fix",
      participants: [
        "teammate@s.whatsapp.net",
        "user@s.whatsapp.net",
      ],
      parentCommunityChatId: "community-chat",
    }]);
  });

  it("ignores unrelated workspace community state when the source chat is standalone", async () => {
    /** @type {Array<{ subject: string, participants: string[] }>} */
    const createdGroups = [];
    const storeState = createStore();

    const presenter = createWhatsAppWorkspacePresenter({
      store: storeState.store,
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createGroup: async (subject, participants) => {
          createdGroups.push({ subject, participants });
          return { chatId: "workspace-chat", subject };
        },
        createCommunity: async () => {
          assert.fail("unrelated community state should not create a replacement community");
        },
        createCommunityGroup: async () => {
          assert.fail("source chat live state is standalone, so this must be a normal group");
        },
        getGroupLinkedParent: async (chatId) => {
          assert.equal(chatId, "source-chat");
          return null;
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "project-1",
      projectName: "Checkout",
      workspaceId: "ws-3",
      workspaceName: "bugfix",
      sourceChatId: "source-chat",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdGroups, [{
      subject: "Checkout - bugfix",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.deepEqual(storeState.storedPresentations, [{
      projectId: "project-1",
      workspaceId: "ws-3",
      workspaceChatId: "workspace-chat",
      workspaceChatSubject: "Checkout - bugfix",
      role: "workspace",
      linkedCommunityChatId: null,
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "Checkout - bugfix",
    });
  });

  it("uses only the project name for main workspace surfaces", async () => {
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamed = [];
    /** @type {Array<{ chatId: string, enabled: boolean }>} */
    const announcementChanges = [];
    const storeState = createStore({
      existingPresentation: {
        workspace_id: "ws-main",
        project_id: "project-1",
        workspace_chat_id: "main-chat",
        workspace_chat_subject: "main",
        role: "main",
        linked_community_chat_id: null,
        timestamp: new Date().toISOString(),
      },
    });
    const presenter = createWhatsAppWorkspacePresenter({
      store: storeState.store,
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        renameGroup: async (chatId, subject) => {
          renamed.push({ chatId, subject });
        },
        setAnnouncementOnly: async (chatId, enabled) => {
          announcementChanges.push({ chatId, enabled });
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "project-1",
      projectName: "Checkout",
      workspaceId: "ws-main",
      workspaceName: "main",
      requesterJids: [],
    });

    assert.deepEqual(renamed, [{
      chatId: "main-chat",
      subject: "Checkout",
    }]);
    assert.deepEqual(announcementChanges, [{
      chatId: "main-chat",
      enabled: false,
    }]);
    assert.deepEqual(storeState.storedPresentations, [{
      projectId: "project-1",
      workspaceId: "ws-main",
      workspaceChatId: "main-chat",
      workspaceChatSubject: "Checkout",
      role: "main",
      linkedCommunityChatId: null,
    }]);
    assert.deepEqual(surface, {
      surfaceId: "main-chat",
      surfaceName: "Checkout",
    });
  });

  it("resolves a workspace surface from the persisted WhatsApp mapping", async () => {
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppWorkspacePresentation: async (workspaceId) => {
          assert.equal(workspaceId, "ws-1");
          return {
            workspace_id: "ws-1",
            project_id: "project-1",
            workspace_chat_id: "workspace-chat",
            workspace_chat_subject: "Checkout - payments",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          };
        },
        saveWhatsAppWorkspacePresentation: async () => {
          throw new Error("should not write when only resolving a surface");
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
      },
    });

    const surface = await presenter.getWorkspaceSurface({ workspaceId: "ws-1" });

    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "Checkout - payments",
    });
  });

  it("delivers semantic workspace events through the adapter transport using workspace identity", async () => {
    /** @type {Array<{ chatId: string, event: OutboundEvent }>} */
    const sentEvents = [];
    /** @type {MessageHandle} */
    const handle = {
      transportHandleId: "workspace-msg-1",
      update: async () => {},
      setInspect: () => {},
    };
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppWorkspacePresentation: async (workspaceId) => {
          assert.equal(workspaceId, "ws-1");
          return {
            workspace_id: "ws-1",
            project_id: "project-1",
            workspace_chat_id: "workspace-chat",
            workspace_chat_subject: "Checkout - payments",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          };
        },
        saveWhatsAppWorkspacePresentation: async () => {},
      },
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
      workspaceId: "ws-1",
      event: contentEvent("llm", [{ type: "text", text: "Thinking..." }]),
    });

    assert.equal(returned, handle);
    assert.deepEqual(sentEvents, [{
      chatId: "workspace-chat",
      event: contentEvent("llm", [{ type: "text", text: "Thinking..." }]),
    }]);
  });

  it("delivers bootstrap and seed prompt text through semantic content events using workspace identity", async () => {
    /** @type {Array<{ chatId: string, text: string }>} */
    const sentTexts = [];
    /** @type {Array<{ chatId: string, event: OutboundEvent }>} */
    const sentEvents = [];
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppWorkspacePresentation: async () => ({
          workspace_id: "ws-1",
          project_id: "project-1",
          workspace_chat_id: "workspace-chat",
          workspace_chat_subject: "Checkout - payments",
          role: "workspace",
          linked_community_chat_id: null,
          timestamp: new Date().toISOString(),
        }),
        saveWhatsAppWorkspacePresentation: async () => {},
      },
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
      workspaceId: "ws-1",
      statusText: "Workspace: payments",
    });
    await presenter.presentSeedPrompt({
      workspaceId: "ws-1",
      promptText: "Prompt: investigate duplicate charges",
    });

    assert.deepEqual(sentTexts, []);
    assert.deepEqual(sentEvents, [
      {
        chatId: "workspace-chat",
        event: {
          kind: "app_message",
          role: "plain",
          content: [{ type: "text", text: "Workspace: payments" }],
        },
      },
      {
        chatId: "workspace-chat",
        event: {
          kind: "app_message",
          role: "plain",
          content: [{ type: "text", text: "Prompt: investigate duplicate charges" }],
        },
      },
    ]);
  });
});
