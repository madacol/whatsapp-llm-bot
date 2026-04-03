import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executeCommunityCreate,
  executeCommunityCreateGroup,
} from "../whatsapp/create-whatsapp-transport.js";

describe("WhatsApp transport community creation", () => {
  it("returns the created community id directly from the raw query response", async () => {
    const socket = {
      query: async () => ({
        tag: "iq",
        attrs: {},
        content: [{
          tag: "group",
          attrs: { id: "community-12345" },
        }],
      }),
      communityCreate: async () => {
        throw new Error("should not fall back to Baileys communityCreate when query is available");
      },
    };

    const result = await executeCommunityCreate(socket, "Project Main", "Primary workspace community");

    assert.deepEqual(result, {
      chatId: "community-12345@g.us",
      subject: "Project Main",
    });
  });

  it("recovers the created community id from participating communities when the query response lacks a group node", async () => {
    const socket = {
      query: async () => ({
        tag: "iq",
        attrs: {},
        content: [],
      }),
      communityCreate: async () => {
        throw new Error("should not fall back to Baileys communityCreate when query is available");
      },
      communityFetchAllParticipating: async () => ({
        "community-12345@g.us": {
          id: "community-12345@g.us",
          subject: "Project Main",
        },
      }),
    };

    const result = await executeCommunityCreate(socket, "Project Main", "Primary workspace community");

    assert.deepEqual(result, {
      chatId: "community-12345@g.us",
      subject: "Project Main",
    });
  });

  it("returns the created subgroup id directly from the raw query response", async () => {
    const socket = {
      query: async () => ({
        tag: "iq",
        attrs: {},
        content: [{
          tag: "group",
          attrs: { id: "group-12345" },
        }],
      }),
      communityCreateGroup: async () => {
        throw new Error("should not fall back to Baileys communityCreateGroup when query is available");
      },
    };

    const result = await executeCommunityCreateGroup(
      socket,
      "payments",
      ["user@s.whatsapp.net"],
      "community-12345@g.us",
    );

    assert.deepEqual(result, {
      chatId: "group-12345@g.us",
      subject: "payments",
    });
  });
});
