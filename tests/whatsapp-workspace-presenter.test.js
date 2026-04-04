import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentEvent } from "../outbound-events.js";
import { buildCommunityDescription } from "../whatsapp/workspace-topology.js";
import { createWhatsAppWorkspacePresenter } from "../whatsapp/workspace-presenter.js";

describe("WhatsAppWorkspacePresenter", () => {
  it("ensures a workspace surface as a named group, persists the mapping, and promotes requesters", async () => {
    /** @type {Array<{ subject: string, participants: string[] }>} */
    const created = [];
    /** @type {Array<{ chatId: string, participants: string[] }>} */
    const promoted = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {Array<{
     *   projectId: string,
     *   cachedTopologyKind?: WhatsAppProjectTopologyKind,
     *   cachedCommunityChatId?: string | null,
     *   cachedMainWorkspaceId?: string | null,
     * }>} */
    const storedProjectPresentations = [];
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => null,
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => [],
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async (input) => {
          storedProjectPresentations.push(input);
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
      projectId: "repo-1",
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
      projectId: "repo-1",
      workspaceId: "ws-1",
      workspaceChatId: "workspace-chat",
      workspaceChatSubject: "[payments] Original Group",
    }]);
    assert.deepEqual(storedProjectPresentations, [{
      projectId: "repo-1",
      cachedTopologyKind: "groups",
      cachedMainWorkspaceId: "ws-1",
    }]);
    assert.deepEqual(surface, {
      surfaceId: "workspace-chat",
      surfaceName: "[payments] Original Group",
    });
  });

  it("upgrades a project from a flat group to a community on the second workspace by adopting the original group as main", async () => {
    /** @type {Array<{ subject: string, description: string }>} */
    const createdCommunities = [];
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamedGroups = [];
    /** @type {Array<{ chatId: string, communityChatId: string }>} */
    const linkedGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {Array<{
     *   projectId: string,
     *   cachedTopologyKind?: WhatsAppProjectTopologyKind,
     *   cachedCommunityChatId?: string | null,
     *   cachedMainWorkspaceId?: string | null,
     * }>} */
    const storedProjectPresentations = [];
    /** @type {string | null} */
    let linkedParent = null;
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "groups",
          cached_community_chat_id: null,
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async (projectId) => {
          assert.equal(projectId, "repo-1");
          return [{
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "flat-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          }];
        },
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async (input) => {
          storedProjectPresentations.push(input);
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async (subject, description) => {
          createdCommunities.push({ subject, description });
          return { chatId: "community-chat", subject };
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-feature-chat",
            subject,
          };
        },
        getGroupLinkedParent: async () => linkedParent,
        renameGroup: async (chatId, subject) => {
          renamedGroups.push({ chatId, subject });
        },
        linkExistingGroupToCommunity: async (chatId, communityChatId) => {
          linkedGroups.push({ chatId, communityChatId });
          linkedParent = communityChatId;
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-2",
      workspaceName: "fraud-fix",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunities, [{
      subject: "Original Group",
      description: buildCommunityDescription("repo-1", "Original Group"),
    }]);
    assert.deepEqual(createdCommunityGroups, [
      {
        subject: "fraud-fix",
        participants: ["user@s.whatsapp.net"],
        parentCommunityChatId: "community-chat",
      },
    ]);
    assert.deepEqual(renamedGroups, [{
      chatId: "flat-chat",
      subject: "main",
    }]);
    assert.deepEqual(linkedGroups, [{
      chatId: "flat-chat",
      communityChatId: "community-chat",
    }]);
    assert.deepEqual(storedProjectPresentations, [{
      projectId: "repo-1",
      cachedTopologyKind: "community",
      cachedCommunityChatId: "community-chat",
      cachedMainWorkspaceId: "ws-1",
    }]);
    assert.deepEqual(storedPresentations, [
      {
        projectId: "repo-1",
        workspaceId: "ws-1",
        workspaceChatId: "flat-chat",
        workspaceChatSubject: "main",
        role: "main",
        linkedCommunityChatId: "community-chat",
      },
      {
        projectId: "repo-1",
        workspaceId: "ws-2",
        workspaceChatId: "community-feature-chat",
        workspaceChatSubject: "fraud-fix",
        role: "workspace",
        linkedCommunityChatId: "community-chat",
      },
    ]);
    assert.deepEqual(surface, {
      surfaceId: "community-feature-chat",
      surfaceName: "fraud-fix",
    });
  });

  it("links the existing group before renaming it to main during community adoption", async () => {
    /** @type {string[]} */
    const operations = [];
    /** @type {Array<{ chatId: string, communityChatId: string }>} */
    const linkedGroups = [];
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamedGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {string | null} */
    let linkedParent = null;
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "community",
          cached_community_chat_id: "community-chat",
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "flat-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async () => {
          assert.fail("project presentation should not be rewritten when rename fails");
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async () => {
          assert.fail("community should not be recreated for an already-community project");
        },
        createCommunityGroup: async () => {
          assert.fail("new subgroup should not be created when main-group rename fails");
        },
        getGroupLinkedParent: async () => "community-chat",
        linkExistingGroupToCommunity: async (chatId, communityChatId) => {
          operations.push("link");
          linkedGroups.push({ chatId, communityChatId });
          linkedParent = communityChatId;
        },
        renameGroup: async (chatId, subject) => {
          operations.push("rename");
          renamedGroups.push({ chatId, subject });
          throw new Error("rename failed");
        },
      },
    });

    await assert.rejects(
      presenter.ensureWorkspaceVisible({
        projectId: "repo-1",
        workspaceId: "ws-2",
        workspaceName: "fraud-fix",
        sourceChatName: "Original Group",
        requesterJids: ["user@s.whatsapp.net"],
      }),
      /rename failed/,
    );

    assert.deepEqual(operations, ["rename"]);
    assert.deepEqual(linkedGroups, []);
    assert.deepEqual(renamedGroups, [{
      chatId: "flat-chat",
      subject: "main",
    }]);
    assert.deepEqual(storedPresentations, []);
  });

  it("replaces a stale community when the persisted main group is not live-linked before adding another subgroup", async () => {
    /** @type {Array<{ subject: string, description: string }>} */
    const createdCommunities = [];
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamedGroups = [];
    /** @type {Array<{ chatId: string, communityChatId: string }>} */
    const linkedGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {Array<{
     *   projectId: string,
     *   cachedTopologyKind?: WhatsAppProjectTopologyKind,
     *   cachedCommunityChatId?: string | null,
     *   cachedMainWorkspaceId?: string | null,
     * }>} */
    const storedProjectPresentations = [];
    /** @type {string | null} */
    let linkedParent = null;
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "community",
          cached_community_chat_id: "community-chat",
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "flat-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async (input) => {
          storedProjectPresentations.push(input);
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async (subject, description) => {
          createdCommunities.push({ subject, description });
          return { chatId: "replacement-community-chat", subject };
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-bugfix-chat",
            subject,
          };
        },
        getGroupLinkedParent: async () => linkedParent,
        renameGroup: async (chatId, subject) => {
          renamedGroups.push({ chatId, subject });
        },
        linkExistingGroupToCommunity: async (chatId, communityChatId) => {
          linkedGroups.push({ chatId, communityChatId });
          linkedParent = communityChatId;
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceName: "bugfix",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunities, [{
      subject: "Original Group",
      description: buildCommunityDescription("repo-1", "Original Group"),
    }]);
    assert.deepEqual(renamedGroups, [{
      chatId: "flat-chat",
      subject: "main",
    }]);
    assert.deepEqual(linkedGroups, [{
      chatId: "flat-chat",
      communityChatId: "replacement-community-chat",
    }]);
    assert.deepEqual(createdCommunityGroups, [{
      subject: "bugfix",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "replacement-community-chat",
    }]);
    assert.deepEqual(storedProjectPresentations, [{
      projectId: "repo-1",
      cachedTopologyKind: "community",
      cachedCommunityChatId: "replacement-community-chat",
      cachedMainWorkspaceId: "ws-1",
    }]);
    assert.deepEqual(storedPresentations, [
      {
        projectId: "repo-1",
        workspaceId: "ws-1",
        workspaceChatId: "flat-chat",
        workspaceChatSubject: "main",
        role: "main",
        linkedCommunityChatId: "replacement-community-chat",
      },
      {
        projectId: "repo-1",
        workspaceId: "ws-3",
        workspaceChatId: "community-bugfix-chat",
        workspaceChatSubject: "bugfix",
        role: "workspace",
        linkedCommunityChatId: "replacement-community-chat",
      },
    ]);
    assert.deepEqual(surface, {
      surfaceId: "community-bugfix-chat",
      surfaceName: "bugfix",
    });
  });

  it("prefers the current live-unlinked chat over the persisted main workspace when replacing a stale community", async () => {
    /** @type {Array<{ subject: string, description: string }>} */
    const createdCommunities = [];
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamedGroups = [];
    /** @type {Array<{ chatId: string, communityChatId: string }>} */
    const linkedGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {Array<{
     *   projectId: string,
     *   cachedTopologyKind?: WhatsAppProjectTopologyKind,
     *   cachedCommunityChatId?: string | null,
     *   cachedMainWorkspaceId?: string | null,
     * }>} */
    const storedProjectPresentations = [];
    /** @type {Record<string, string | null>} */
    const linkedParents = {
      "old-main-chat": "community-chat",
      "current-chat": null,
    };
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "community",
          cached_community_chat_id: "community-chat",
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "old-main-chat",
            workspace_chat_subject: "main",
            role: "main",
            linked_community_chat_id: "community-chat",
            timestamp: new Date().toISOString(),
          },
          {
            workspace_id: "ws-2",
            project_id: "repo-1",
            workspace_chat_id: "current-chat",
            workspace_chat_subject: "[setup] Baby Jarvis dev",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async (input) => {
          storedProjectPresentations.push(input);
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async (subject, description) => {
          createdCommunities.push({ subject, description });
          return { chatId: "replacement-community-chat", subject };
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-qwd-chat",
            subject,
          };
        },
        getGroupLinkedParent: async (chatId) => linkedParents[chatId] ?? null,
        renameGroup: async (chatId, subject) => {
          renamedGroups.push({ chatId, subject });
        },
        linkExistingGroupToCommunity: async (chatId, communityChatId) => {
          linkedGroups.push({ chatId, communityChatId });
          linkedParents[chatId] = communityChatId;
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceName: "qwd",
      sourceChatName: "Baby Jarvis dev",
      sourceChatId: "current-chat",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunities, [{
      subject: "Baby Jarvis dev",
      description: buildCommunityDescription("repo-1", "Baby Jarvis dev"),
    }]);
    assert.deepEqual(renamedGroups, [{
      chatId: "current-chat",
      subject: "main",
    }]);
    assert.deepEqual(linkedGroups, [{
      chatId: "current-chat",
      communityChatId: "replacement-community-chat",
    }]);
    assert.deepEqual(createdCommunityGroups, [{
      subject: "qwd",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "replacement-community-chat",
    }]);
    assert.deepEqual(storedProjectPresentations, [{
      projectId: "repo-1",
      cachedTopologyKind: "community",
      cachedCommunityChatId: "replacement-community-chat",
      cachedMainWorkspaceId: "ws-2",
    }]);
    assert.deepEqual(storedPresentations, [
      {
        projectId: "repo-1",
        workspaceId: "ws-2",
        workspaceChatId: "current-chat",
        workspaceChatSubject: "main",
        role: "main",
        linkedCommunityChatId: "replacement-community-chat",
      },
      {
        projectId: "repo-1",
        workspaceId: "ws-1",
        workspaceChatId: "old-main-chat",
        workspaceChatSubject: "main",
        role: "workspace",
        linkedCommunityChatId: "community-chat",
      },
      {
        projectId: "repo-1",
        workspaceId: "ws-3",
        workspaceChatId: "community-qwd-chat",
        workspaceChatSubject: "qwd",
        role: "workspace",
        linkedCommunityChatId: "replacement-community-chat",
      },
    ]);
    assert.deepEqual(surface, {
      surfaceId: "community-qwd-chat",
      surfaceName: "qwd",
    });
  });

  it("adopts an unmapped live-standalone current chat as the main surface before replacing a stale community", async () => {
    /** @type {Array<{ subject: string, description: string }>} */
    const createdCommunities = [];
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{ chatId: string, subject: string }>} */
    const renamedGroups = [];
    /** @type {Array<{ chatId: string, communityChatId: string }>} */
    const linkedGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {Array<{
     *   projectId: string,
     *   cachedTopologyKind?: WhatsAppProjectTopologyKind,
     *   cachedCommunityChatId?: string | null,
     *   cachedMainWorkspaceId?: string | null,
     * }>} */
    const storedProjectPresentations = [];
    /** @type {Record<string, string | null>} */
    const linkedParents = {
      "old-main-chat": "community-chat",
      "current-chat": null,
    };
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "community",
          cached_community_chat_id: "community-chat",
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "old-main-chat",
            workspace_chat_subject: "main",
            role: "main",
            linked_community_chat_id: "community-chat",
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async (input) => {
          storedProjectPresentations.push(input);
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async (subject, description) => {
          createdCommunities.push({ subject, description });
          return { chatId: "replacement-community-chat", subject };
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-ddd-chat",
            subject,
          };
        },
        getGroupLinkedParent: async (chatId) => linkedParents[chatId] ?? null,
        renameGroup: async (chatId, subject) => {
          renamedGroups.push({ chatId, subject });
        },
        linkExistingGroupToCommunity: async (chatId, communityChatId) => {
          linkedGroups.push({ chatId, communityChatId });
          linkedParents[chatId] = communityChatId;
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceName: "ddd",
      sourceChatId: "current-chat",
      sourceChatName: "Baby Jarvis dev",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunities, [{
      subject: "Baby Jarvis dev",
      description: buildCommunityDescription("repo-1", "Baby Jarvis dev"),
    }]);
    assert.deepEqual(renamedGroups, [{
      chatId: "current-chat",
      subject: "main",
    }]);
    assert.deepEqual(linkedGroups, [{
      chatId: "current-chat",
      communityChatId: "replacement-community-chat",
    }]);
    assert.deepEqual(createdCommunityGroups, [{
      subject: "ddd",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "replacement-community-chat",
    }]);
    assert.deepEqual(storedProjectPresentations, [{
      projectId: "repo-1",
      cachedTopologyKind: "community",
      cachedCommunityChatId: "replacement-community-chat",
      cachedMainWorkspaceId: "ws-1",
    }]);
    assert.deepEqual(storedPresentations, [
      {
        projectId: "repo-1",
        workspaceId: "ws-1",
        workspaceChatId: "current-chat",
        workspaceChatSubject: "main",
        role: "main",
        linkedCommunityChatId: "replacement-community-chat",
      },
      {
        projectId: "repo-1",
        workspaceId: "ws-3",
        workspaceChatId: "community-ddd-chat",
        workspaceChatSubject: "ddd",
        role: "workspace",
        linkedCommunityChatId: "replacement-community-chat",
      },
    ]);
    assert.deepEqual(surface, {
      surfaceId: "community-ddd-chat",
      surfaceName: "ddd",
    });
  });

  it("uses live WhatsApp metadata to skip relinking an already-linked main group before adding another subgroup", async () => {
    /** @type {string[]} */
    const linkedParentChecks = [];
    /** @type {Array<{ chatId: string, communityChatId: string }>} */
    const linkedGroups = [];
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    /** @type {string | null} */
    let linkedParent = null;

    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "community",
          cached_community_chat_id: "community-chat",
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "main-chat",
            workspace_chat_subject: "main",
            role: "main",
            linked_community_chat_id: "community-chat",
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async () => {
          assert.fail("project presentation should not be rewritten when repairing a stale main-group link");
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async () => {
          assert.fail("community should not be recreated for an already-live-linked main group");
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-bugfix-chat",
            subject,
          };
        },
        getGroupLinkedParent: async (chatId) => {
          linkedParentChecks.push(chatId);
          return "community-chat";
        },
        linkExistingGroupToCommunity: async (chatId, communityChatId) => {
          linkedGroups.push({ chatId, communityChatId });
          linkedParent = communityChatId;
        },
        renameGroup: async () => {
          assert.fail("main group should not be renamed when it is already named main");
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceName: "bugfix",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(linkedParentChecks, ["main-chat", "main-chat", "main-chat"]);
    assert.deepEqual(linkedGroups, []);
    assert.deepEqual(createdCommunityGroups, [{
      subject: "bugfix",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(storedPresentations, [{
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceChatId: "community-bugfix-chat",
      workspaceChatSubject: "bugfix",
      role: "workspace",
      linkedCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(surface, {
      surfaceId: "community-bugfix-chat",
      surfaceName: "bugfix",
    });
  });

  it("treats project presentation as a cache hint when the live source chat is already in a community", async () => {
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];

    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "groups",
          cached_community_chat_id: null,
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "main-chat",
            workspace_chat_subject: "main",
            role: "main",
            linked_community_chat_id: "community-chat",
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async () => {
          assert.fail("stale project presentation should not force a rewrite when live chat state is already authoritative");
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        createCommunity: async () => {
          assert.fail("live-linked source chat should not create a replacement community");
        },
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-new-chat",
            subject,
          };
        },
        getGroupLinkedParent: async () => "community-chat",
        linkExistingGroupToCommunity: async () => {
          assert.fail("live-linked source chat should not relink the main surface");
        },
        renameGroup: async () => {
          assert.fail("already-normalized main group should not be renamed");
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-2",
      workspaceName: "ops",
      sourceChatId: "main-chat",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunityGroups, [{
      subject: "ops",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(storedPresentations, [{
      projectId: "repo-1",
      workspaceId: "ws-2",
      workspaceChatId: "community-new-chat",
      workspaceChatSubject: "ops",
      role: "workspace",
      linkedCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(surface, {
      surfaceId: "community-new-chat",
      surfaceName: "ops",
    });
  });

  it("adds later workspaces directly as community subgroups", async () => {
    /** @type {Array<{ subject: string, participants: string[], parentCommunityChatId: string }>} */
    const createdCommunityGroups = [];
    /** @type {Array<{
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => ({
          project_id: "repo-1",
          cached_topology_kind: "community",
          cached_community_chat_id: "community-chat",
          cached_main_workspace_id: "ws-1",
          timestamp: new Date().toISOString(),
        }),
        getWhatsAppWorkspacePresentation: async () => null,
        listWhatsAppWorkspacePresentations: async () => ([
          {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "community-main-chat",
            workspace_chat_subject: "main",
            role: "main",
            linked_community_chat_id: "community-chat",
            timestamp: new Date().toISOString(),
          },
        ]),
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async () => {
          assert.fail("project presentation should not be rewritten for later community subgroups");
        },
      },
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        getGroupLinkedParent: async () => "community-chat",
        createCommunityGroup: async (subject, participants, parentCommunityChatId) => {
          createdCommunityGroups.push({ subject, participants, parentCommunityChatId });
          return {
            chatId: "community-bugfix-chat",
            subject,
          };
        },
      },
    });

    const surface = await presenter.ensureWorkspaceVisible({
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceName: "bugfix",
      sourceChatName: "Original Group",
      requesterJids: ["user@s.whatsapp.net"],
    });

    assert.deepEqual(createdCommunityGroups, [{
      subject: "bugfix",
      participants: ["user@s.whatsapp.net"],
      parentCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(storedPresentations, [{
      projectId: "repo-1",
      workspaceId: "ws-3",
      workspaceChatId: "community-bugfix-chat",
      workspaceChatSubject: "bugfix",
      role: "workspace",
      linkedCommunityChatId: "community-chat",
    }]);
    assert.deepEqual(surface, {
      surfaceId: "community-bugfix-chat",
      surfaceName: "bugfix",
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
     *   projectId: string,
     *   workspaceId: string,
     *   workspaceChatId: string,
     *   workspaceChatSubject: string,
     *   role?: WhatsAppWorkspacePresentationRole,
     *   linkedCommunityChatId?: string | null,
     * }>} */
    const storedPresentations = [];
    const presenter = createWhatsAppWorkspacePresenter({
      store: {
        getWhatsAppProjectPresentationCache: async () => null,
        getWhatsAppWorkspacePresentation: async () => ({
          workspace_id: "ws-1",
          project_id: "repo-1",
          workspace_chat_id: "workspace-chat",
          workspace_chat_subject: "[payments] Old Name",
          role: "workspace",
          linked_community_chat_id: null,
          timestamp: new Date().toISOString(),
        }),
        listWhatsAppWorkspacePresentations: async () => [],
        saveWhatsAppWorkspacePresentation: async (input) => {
          storedPresentations.push(input);
        },
        upsertWhatsAppProjectPresentationCache: async () => {},
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
      projectId: "repo-1",
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
      projectId: "repo-1",
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
        getWhatsAppProjectPresentationCache: async () => null,
        getWhatsAppWorkspacePresentation: async (workspaceId) => {
          assert.equal(workspaceId, "ws-1");
          return {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "workspace-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          };
        },
        listWhatsAppWorkspacePresentations: async () => [],
        saveWhatsAppWorkspacePresentation: async () => {
          throw new Error("should not write when only resolving a surface");
        },
        upsertWhatsAppProjectPresentationCache: async () => {
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
        getWhatsAppProjectPresentationCache: async () => null,
        getWhatsAppWorkspacePresentation: async (workspaceId) => {
          assert.equal(workspaceId, "ws-1");
          return {
            workspace_id: "ws-1",
            project_id: "repo-1",
            workspace_chat_id: "workspace-chat",
            workspace_chat_subject: "[payments] Original Group",
            role: "workspace",
            linked_community_chat_id: null,
            timestamp: new Date().toISOString(),
          };
        },
        listWhatsAppWorkspacePresentations: async () => [],
        saveWhatsAppWorkspacePresentation: async () => {},
        upsertWhatsAppProjectPresentationCache: async () => {},
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
        getWhatsAppProjectPresentationCache: async () => null,
        getWhatsAppWorkspacePresentation: async () => ({
          workspace_id: "ws-1",
          project_id: "repo-1",
          workspace_chat_id: "workspace-chat",
          workspace_chat_subject: "[payments] Original Group",
          role: "workspace",
          linked_community_chat_id: null,
          timestamp: new Date().toISOString(),
        }),
        listWhatsAppWorkspacePresentations: async () => [],
        saveWhatsAppWorkspacePresentation: async () => {},
        upsertWhatsAppProjectPresentationCache: async () => {},
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
