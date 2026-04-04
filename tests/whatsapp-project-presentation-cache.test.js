import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readWhatsAppProjectPresentationCache } from "../whatsapp/project-presentation-cache.js";

describe("readWhatsAppProjectPresentationCache", () => {
  it("maps storage-oriented cache columns onto semantic fields", () => {
    const view = readWhatsAppProjectPresentationCache({
      project_id: "project-1",
      cached_topology_kind: "community",
      cached_community_chat_id: "community-chat",
      cached_main_workspace_id: "ws-1",
      timestamp: "2026-04-04T05:36:00.000Z",
    });

    assert.deepEqual(view, {
      projectId: "project-1",
      topologyKind: "community",
      communityChatId: "community-chat",
      mainWorkspaceId: "ws-1",
      timestamp: "2026-04-04T05:36:00.000Z",
    });
  });

  it("returns null when there is no cached project presentation", () => {
    assert.equal(readWhatsAppProjectPresentationCache(null), null);
  });
});
