import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentEvent } from "../outbound-events.js";
import { createWhatsAppWorkspacePresenter } from "../whatsapp/workspace-presenter.js";

describe("WhatsAppWorkspacePresenter", () => {
  it("ensures a workspace surface as a named group, persists the mapping, and promotes requesters", async () => {
    /** @type {Array<{ subject: string, participants: string[] }>} */
    const created = [];
    /** @type {Array<{ chatId: string, participants: string[] }>} */
    const promoted = [];
    /** @type {Array<{
     *   repoId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {Array<{
     *   repoId: string,
     *   topologyKind?: WhatsAppRepoTopologyKind,
     *   communityChatId?: string | null,
     *   mainWorkspaceId?: string | null,
     * }>} */
    const storedRepos = [];
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppRepoPresentation: async () => null,
        getWhatsAppWorkspacePresentation: async () => null,
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppRepoPresentation: async (input) => {
          storedRepos.push(input);
        },
      },
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

    const surface = await presenter.ensureWorkspaceVisible({
      repoId: "repo-1",
      workspaceId: "ws-1",
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
    assert.deepEqual(storedPresentations, [{
      repoId: "repo-1",
      workspaceId: "ws-1",
      workspaceChatId: "workspace-chat",
      workspaceChatSubject: "[payments] Original Group",
    }]);
    assert.deepEqual(storedRepos, [{
      repoId: "repo-1",
      topologyKind: "groups",
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "[payments] Original Group",
    });
  });

  it("reuses an existing workspace surface and refreshes its metadata", async () => {
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamed = [];
    /** @type {Array<{ chatId: string, enabled: boolean }>} */
    const announcementChanges = [];
    /** @type {Array<{ chatId: string, participants: string[] }>} */
    const promoted = [];
    /** @type {Array<{
     *   repoId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppRepoPresentation: async () => null,
        getWhatsAppWorkspacePresentation: async () => ({
          workspace_id: "ws-1",
          repo_id: "repo-1",
          workspace_chat_id: "workspace-chat",
          workspace_chat_subject: "[payments] Old Name",
          role: "workspace",
          linked_community_chat_id: null,
          timestamp: new Date().toISOString(),
        }),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppRepoPresentation: async () => {},
      },
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
        promoteParticipants: async (chatId, participants) => {
          promoted.push({ chatId, participants });
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      repoId: "repo-1",
      workspaceId: "ws-1",
      workspaceName: "payments",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(renamed, [{
      chatId: "workspace-chat",
      subject: "[payments] Original Group",
    }]);
    assert.deepEqual(announcementChanges, [{
      chatId: "workspace-chat",
      enabled: false,
    }]);
    assert.deepEqual(promoted, [{
      chatId: "workspace-chat",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.deepEqual(storedPresentations, [{
      repoId: "repo-1",
      workspaceId: "ws-1",
      workspaceChatId: "workspace-chat",
      workspaceChatSubject: "[payments] Original Group",
      role: "workspace",
      linkedCommunityChatId: null,
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "[payments] Original Group",
    });
  });

  it("resolves a workspace surface from the persisted WhatsApp mapping", async () => {
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppRepoPresentation: async () => null,
        getWhatsAppWorkspacePresentation: async (workspaceId) => {
          assert.equal(workspaceId, "ws-1");
          return {
            workspace_id: "ws-1",
            repo_id: "repo-1",
            workspace_chat_id: "workspace-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          };
        },
        saveWhatsAppWorkspacePresentation: async () => {
          throw new Error("should not write when only resolving a surface");
        },
        upsertWhatsAppRepoPresentation: async () => {
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
      surfaceName: "[payments] Original Group",
    });
  });

  it("delivers semantic workspace events through the adapter transport using workspace identity", async () => {
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
      store: {
        getWhatsAppRepoPresentation: async () => null,
        getWhatsAppWorkspacePresentation: async (workspaceId) => {
          assert.equal(workspaceId, "ws-1");
          return {
            workspace_id: "ws-1",
            repo_id: "repo-1",
            workspace_chat_id: "workspace-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          };
        },
        saveWhatsAppWorkspacePresentation: async () => {},
        upsertWhatsAppRepoPresentation: async () => {},
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
        getWhatsAppRepoPresentation: async () => null,
        getWhatsAppWorkspacePresentation: async () => ({
          workspace_id: "ws-1",
          repo_id: "repo-1",
          workspace_chat_id: "workspace-chat",
          workspace_chat_subject: "[payments] Original Group",
          role: "workspace",
          linked_community_chat_id: null,
          timestamp: new Date().toISOString(),
        }),
        saveWhatsAppWorkspacePresentation: async () => {},
        upsertWhatsAppRepoPresentation: async () => {},
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
        event: contentEvent("plain", [{ type: "text", text: "Workspace: payments" }]),
      },
      {
        chatId: "workspace-chat",
        event: contentEvent("plain", [{ type: "text", text: "Prompt: investigate duplicate charges" }]),
      },
    ]);
  });
});
