import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.TESTING = "1";
process.env.MASTER_ID = "master-user";
process.env.LLM_API_KEY = "test-key";
process.env.MODEL = "mock-model";

import { createChatTurn, createMockLlmServer, createTestDb, seedChat as seedChat_ } from "./helpers.js";
import { setDb } from "../db.js";

/** @type {PGlite} */
let db;
/** @type {Awaited<ReturnType<typeof import("../store.js").initStore>>} */
let store;
/** @type {Awaited<ReturnType<typeof createMockLlmServer>>} */
let mockServer;

before(async () => {
  db = await createTestDb();
  setDb("./pgdata/root", db);
  mockServer = await createMockLlmServer();
  process.env.BASE_URL = mockServer.url;
  const { initStore } = await import("../store.js");
  store = await initStore(db);
});

after(async () => {
  await mockServer?.close();
});

/**
 * @param {string} chatId
 * @returns {Promise<void>}
 */
async function seedChat(chatId) {
  await seedChat_(db, chatId, { enabled: true });
}

/**
 * @param {{ transport?: ChatTransport }} [options]
 * @returns {Promise<(msg: ChatTurn) => Promise<void>>}
 */
async function createHandler(options = {}) {
  const { createLlmClient } = await import("../llm.js");
  const llmClient = createLlmClient();
  const { createMessageHandler } = await import("../index.js");
  const { getActions, executeAction } = await import("../actions.js");
  const handler = createMessageHandler({
    store,
    llmClient,
    getActionsFn: getActions,
    executeActionFn: executeAction,
    transport: options.transport,
  });
  return handler.handleMessage;
}

describe("WhatsApp test command", () => {
  afterEach(() => {
    const pending = mockServer.pendingResponses();
    assert.equal(pending, 0, `Mock response queue should be empty after each test, but has ${pending} unconsumed response(s).`);
  });

  it("runs !test wa methods through the transport test port", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Logged methods to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-methods");

    const turn = createChatTurn({
      chatId: "wa-test-methods",
      content: [{ type: "text", text: "!test wa methods" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "methods",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Logged methods to /tmp/wh.log")));
  });

  it("runs !tmp through the transport test port with sender participants", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Temporary link probe logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-tmp");

    const turn = createChatTurn({
      chatId: "wa-test-tmp",
      senderIds: ["user"],
      senderJids: ["user@s.whatsapp.net"],
      content: [{ type: "text", text: "!tmp" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "tmp",
      participants: ["user@s.whatsapp.net"],
      groupJid: "120363426153979898@g.us",
      groupSubject: "probe-external-link-raw",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Temporary link probe logged to /tmp/wh.log")));
  });

  it("runs !test wa smoke with the sender as participant", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Smoke test logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-smoke");

    const turn = createChatTurn({
      chatId: "wa-test-smoke",
      senderIds: ["user"],
      senderJids: ["user@s.whatsapp.net"],
      content: [{ type: "text", text: "!test wa smoke Payments Probe" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "smoke",
      baseSubject: "Payments Probe",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Smoke test logged to /tmp/wh.log")));
  });

  it("parses !test wa community-create with an inline description", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community create logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-community-create");

    const turn = createChatTurn({
      chatId: "wa-test-community-create",
      content: [{ type: "text", text: "!test wa community-create Project Atlas: migration probe" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-create",
      subject: "Project Atlas",
      description: "migration probe",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community create logged to /tmp/wh.log")));
  });

  it("parses !test wa community-create-group and falls back to senderId when jid is missing", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community subgroup logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-create-group");

    const turn = createChatTurn({
      chatId: "wa-test-create-group",
      senderIds: ["fallback-user"],
      senderJids: [],
      content: [{ type: "text", text: "!test wa community-create-group 120363000000000000@g.us: main" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-create-group",
      parentCommunityJid: "120363000000000000@g.us",
      subject: "main",
      participants: ["fallback-user@s.whatsapp.net"],
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community subgroup logged to /tmp/wh.log")));
  });

  it("parses !test wa community-link with two JIDs", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community link logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-link");

    const turn = createChatTurn({
      chatId: "wa-test-link",
      content: [{ type: "text", text: "!test wa community-link 120363000000000000@g.us 120363999999999999@g.us" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-link",
      parentCommunityJid: "120363000000000000@g.us",
      groupJid: "120363999999999999@g.us",
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community link logged to /tmp/wh.log")));
  });

  it("parses !test wa community-link-smoke and carries sender participants", async () => {
    /** @type {WhatsAppTestCommandInput[]} */
    const invocations = [];
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async (input) => {
          invocations.push(input);
          return { summary: "Community link smoke logged to /tmp/wh.log" };
        },
      },
    });

    await seedChat("wa-test-link-smoke");

    const turn = createChatTurn({
      chatId: "wa-test-link-smoke",
      senderIds: ["user"],
      senderJids: ["user@s.whatsapp.net"],
      content: [{ type: "text", text: "!test wa community-link-smoke 120363000000000000@g.us: probe-main" }],
    });
    await handleMessage(turn.context);

    assert.deepEqual(invocations, [{
      kind: "community-link-smoke",
      parentCommunityJid: "120363000000000000@g.us",
      subject: "probe-main",
      participants: ["user@s.whatsapp.net"],
    }]);
    assert.ok(turn.responses.some((response) => response.text.includes("Community link smoke logged to /tmp/wh.log")));
  });

  it("shows usage when !test wa subcommand is missing", async () => {
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        runWhatsAppTest: async () => {
          assert.fail("runWhatsAppTest should not be called for invalid syntax");
        },
      },
    });

    await seedChat("wa-test-usage");

    const turn = createChatTurn({
      chatId: "wa-test-usage",
      content: [{ type: "text", text: "!test wa" }],
    });
    await handleMessage(turn.context);

    assert.ok(turn.responses.some((response) => response.text.includes("Usage: `!test wa methods`")));
  });

  it("reports when the WhatsApp test port is unavailable", async () => {
    const handleMessage = await createHandler({
      transport: {
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
      },
    });

    await seedChat("wa-test-unavailable");

    const turn = createChatTurn({
      chatId: "wa-test-unavailable",
      content: [{ type: "text", text: "!test wa methods" }],
    });
    await handleMessage(turn.context);

    assert.ok(turn.responses.some((response) => response.text.includes("unavailable in this runtime")));
  });
});

describe("runLoggedWhatsAppTestOperation", () => {
  it("logs start and resolution around a completed operation", async () => {
    const { runLoggedWhatsAppTestOperation } = await import("../whatsapp/create-whatsapp-transport.js");

    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const result = await runLoggedWhatsAppTestOperation({
      kind: "community-link",
      args: {
        kind: "community-link",
        parentCommunityJid: "120363000000000000@g.us",
        groupJid: "120363999999999999@g.us",
      },
      availableMethods: ["communityLinkGroup"],
      timeoutMs: 100,
      appendLog: async (entry) => {
        entries.push(entry);
      },
      execute: async () => ({ linked: true }),
    });

    assert.deepEqual(result, { linked: true });
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.phase, "started");
    assert.equal(entries[1]?.phase, "resolved");
    assert.deepEqual(entries[1]?.result, { linked: true });
  });

  it("logs rejection when the operation throws", async () => {
    const { runLoggedWhatsAppTestOperation } = await import("../whatsapp/create-whatsapp-transport.js");

    /** @type {Array<Record<string, unknown>>} */
    const entries = [];
    const failure = new Error("link failed");

    await assert.rejects(
      () => runLoggedWhatsAppTestOperation({
        kind: "community-link",
        args: {
          kind: "community-link",
          parentCommunityJid: "120363000000000000@g.us",
          groupJid: "120363999999999999@g.us",
        },
        availableMethods: ["communityLinkGroup"],
        timeoutMs: 100,
        appendLog: async (entry) => {
          entries.push(entry);
        },
        execute: async () => {
          throw failure;
        },
      }),
      /link failed/,
    );

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.phase, "started");
    assert.equal(entries[1]?.phase, "rejected");
    assert.equal(
      /** @type {{ name?: unknown }} */ (entries[1]?.error).name,
      "Error",
    );
  });

  it("logs timeout when the operation never resolves", async () => {
    const { runLoggedWhatsAppTestOperation } = await import("../whatsapp/create-whatsapp-transport.js");

    /** @type {Array<Record<string, unknown>>} */
    const entries = [];

    await assert.rejects(
      () => runLoggedWhatsAppTestOperation({
        kind: "community-link",
        args: {
          kind: "community-link",
          parentCommunityJid: "120363000000000000@g.us",
          groupJid: "120363999999999999@g.us",
        },
        availableMethods: ["communityLinkGroup"],
        timeoutMs: 10,
        appendLog: async (entry) => {
          entries.push(entry);
        },
        execute: async () => new Promise(() => {}),
      }),
      /timed out/,
    );

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.phase, "started");
    assert.equal(entries[1]?.phase, "timeout");
    assert.equal(
      /** @type {{ name?: unknown }} */ (entries[1]?.error).name,
      "WhatsAppTestTimeoutError",
    );
  });
});

describe("executeWhatsAppTestCommand", () => {
  it("reuses the fixed tmp probe group and community for the tmp probe", async () => {
    const { executeWhatsAppTestCommand } = await import("../whatsapp/create-whatsapp-transport.js");

    /** @type {string[]} */
    const calls = [];
    /** @type {BaileysSocket & {
     *   communityLinkGroup: (groupJid: string, parentCommunityJid: string) => Promise<void>;
     *   groupMetadata: (jid: string) => Promise<{ id: string, linkedParent?: string }>;
     *   communityFetchLinkedGroups: (jid: string) => Promise<Array<{ id: string, subject: string }>>;
     * }} */
    const sock = /** @type {never} */ ({
      communityLinkGroup: async (groupJid, parentCommunityJid) => {
        calls.push(`communityLinkGroup:${groupJid}:${parentCommunityJid}`);
      },
      groupMetadata: async (jid) => {
        calls.push(`groupMetadata:${jid}`);
        return {
          id: jid,
          linkedParent: "120363000000000000@g.us",
        };
      },
      communityFetchLinkedGroups: async (jid) => {
        calls.push(`communityFetchLinkedGroups:${jid}`);
        return [{ id: "120363999999999999@g.us", subject: "tmp" }];
      },
    });

    const result = await executeWhatsAppTestCommand({
      sock,
      input: {
        kind: "tmp",
        participants: ["user@s.whatsapp.net"],
        groupJid: "120363426153979898@g.us",
        groupSubject: "probe-external-link-raw",
      },
    });

    assert.deepEqual(calls, [
      "communityLinkGroup:120363426153979898@g.us:120363408812026899@g.us",
      "groupMetadata:120363426153979898@g.us",
      "communityFetchLinkedGroups:120363408812026899@g.us",
    ]);
    assert.deepEqual(result, {
      community: {
        id: "120363408812026899@g.us",
        subject: "tmp",
      },
      reusedGroup: {
        id: "120363426153979898@g.us",
        subject: "probe-external-link-raw",
      },
      linkResponse: null,
      groupMetadataAfter: {
        status: "fulfilled",
        value: {
          id: "120363426153979898@g.us",
          linkedParent: "120363000000000000@g.us",
        },
      },
      linkedGroupsAfter: {
        status: "fulfilled",
        value: [{ id: "120363999999999999@g.us", subject: "tmp" }],
      },
    });
  });

  it("prefers the built-in communityLinkGroup method when available", async () => {
    const { executeWhatsAppTestCommand } = await import("../whatsapp/create-whatsapp-transport.js");

    /** @type {string[]} */
    const calls = [];
    /** @type {BaileysSocket & {
     *   communityLinkGroup: (groupJid: string, parentCommunityJid: string) => Promise<void>;
     *   groupMetadata: (jid: string) => Promise<{ id: string, linkedParent?: string }>;
     *   communityFetchLinkedGroups: (jid: string) => Promise<Array<{ id: string, subject: string }>>;
     * }} */
    const sock = /** @type {never} */ ({
      communityLinkGroup: async (groupJid, parentCommunityJid) => {
        calls.push(`communityLinkGroup:${groupJid}:${parentCommunityJid}`);
      },
      groupMetadata: async (jid) => {
        calls.push(`groupMetadata:${jid}`);
        return {
          id: jid,
          linkedParent: "120363000000000000@g.us",
        };
      },
      communityFetchLinkedGroups: async (jid) => {
        calls.push(`communityFetchLinkedGroups:${jid}`);
        return [{ id: "120363999999999999@g.us", subject: "probe-main" }];
      },
    });

    const result = await executeWhatsAppTestCommand({
      sock,
      input: {
        kind: "community-link",
        parentCommunityJid: "120363000000000000@g.us",
        groupJid: "120363999999999999@g.us",
      },
    });

    assert.deepEqual(calls, [
      "communityLinkGroup:120363999999999999@g.us:120363000000000000@g.us",
      "groupMetadata:120363999999999999@g.us",
      "communityFetchLinkedGroups:120363000000000000@g.us",
    ]);
    assert.deepEqual(result, {
      linkResponse: null,
      groupMetadataAfter: {
        status: "fulfilled",
        value: {
          id: "120363999999999999@g.us",
          linkedParent: "120363000000000000@g.us",
        },
      },
      linkedGroupsAfter: {
        status: "fulfilled",
        value: [{ id: "120363999999999999@g.us", subject: "probe-main" }],
      },
    });
  });

  it("creates an external group, links it, and fetches linked groups for community-link-smoke", async () => {
    const { executeWhatsAppTestCommand } = await import("../whatsapp/create-whatsapp-transport.js");

    /** @type {string[]} */
    const calls = [];
    /** @type {Array<Record<string, unknown>>} */
    const queries = [];
    /** @type {BaileysSocket & {
     *   groupCreate: (subject: string, participants: string[]) => Promise<{ id: string, subject: string }>;
     *   query: (node: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
     *   groupMetadata: (jid: string) => Promise<{ id: string, linkedParent?: string }>;
     *   communityFetchLinkedGroups: (jid: string) => Promise<Array<{ id: string, subject: string }>>;
     * }} */
    const sock = /** @type {never} */ ({
      groupCreate: async (subject, participants) => {
        calls.push(`groupCreate:${subject}:${participants.join(",")}`);
        return {
          id: "120363999999999999@g.us",
          subject,
        };
      },
      query: async (node) => {
        queries.push(node);
        calls.push("query");
        return {
          tag: "iq",
          attrs: { type: "result" },
          content: [{
            tag: "links",
            attrs: {},
            content: [{
              tag: "group",
              attrs: { jid: "120363999999999999@g.us" },
            }],
          }],
        };
      },
      groupMetadata: async (jid) => {
        calls.push(`groupMetadata:${jid}`);
        return {
          id: jid,
          linkedParent: "120363000000000000@g.us",
        };
      },
      communityFetchLinkedGroups: async (jid) => {
        calls.push(`communityFetchLinkedGroups:${jid}`);
        return [{ id: "120363999999999999@g.us", subject: "probe-main" }];
      },
    });

    const result = await executeWhatsAppTestCommand({
      sock,
      input: {
        kind: "community-link-smoke",
        parentCommunityJid: "120363000000000000@g.us",
        subject: "probe-main",
        participants: ["user@s.whatsapp.net"],
      },
    });

    assert.deepEqual(calls, [
      "groupCreate:probe-main:user@s.whatsapp.net",
      "query",
      "groupMetadata:120363999999999999@g.us",
      "communityFetchLinkedGroups:120363000000000000@g.us",
    ]);
    assert.deepEqual(queries, [{
      tag: "iq",
      attrs: {
        type: "set",
        xmlns: "w:g2",
        to: "120363000000000000@g.us",
      },
      content: [{
        tag: "links",
        attrs: {},
        content: [{
          tag: "link",
          attrs: { link_type: "sub_group" },
          content: [{
            tag: "group",
            attrs: { jid: "120363999999999999@g.us" },
          }],
        }],
      }],
    }]);
    assert.deepEqual(result, {
      createdGroup: {
        id: "120363999999999999@g.us",
        subject: "probe-main",
      },
      linkResponse: {
        tag: "iq",
        attrs: { type: "result" },
        content: [{
          tag: "links",
          attrs: {},
          content: [{
            tag: "group",
            attrs: { jid: "120363999999999999@g.us" },
          }],
        }],
      },
      groupMetadataAfter: {
        status: "fulfilled",
        value: {
          id: "120363999999999999@g.us",
          linkedParent: "120363000000000000@g.us",
        },
      },
      linkedGroupsAfter: {
        status: "fulfilled",
        value: [{ id: "120363999999999999@g.us", subject: "probe-main" }],
      },
    });
  });
});
