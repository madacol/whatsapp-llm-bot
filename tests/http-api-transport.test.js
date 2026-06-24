process.env.TESTING = "1";

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHttpApiTransport } from "../http-api-transport.js";

const TOKEN = "test-api-token";

/** @type {Array<{ stop: () => Promise<void> }>} */
const transports = [];

afterEach(async () => {
  while (transports.length > 0) {
    const transport = transports.pop();
    await transport?.stop();
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  await assertion();
  throw lastError;
}

/**
 * @returns {Promise<Awaited<ReturnType<typeof createHttpApiTransport>>>}
 */
async function startTransport() {
  const transport = await createHttpApiTransport({
    port: 0,
    host: "127.0.0.1",
    authToken: TOKEN,
  });
  transports.push(transport);
  await transport.start(async () => {});
  return transport;
}

/**
 * @param {string} requestId
 * @returns {Record<string, unknown>}
 */
function turnPayload(requestId) {
  return {
    requestId,
    chatId: "api:client-1",
    senderIds: ["user-1"],
    senderName: "User",
    timestamp: "2026-06-11T00:00:00.000Z",
    content: [
      { type: "text", text: "turn on the desk light" },
    ],
    facts: {
      addressedToBot: true,
      isGroup: false,
      repliedToBot: false,
    },
  };
}

/**
 * @param {Awaited<ReturnType<typeof createHttpApiTransport>>} transport
 * @param {Record<string, unknown>} payload
 * @param {string} [query]
 * @returns {Promise<Response>}
 */
async function postTurn(transport, payload, query = "") {
  return fetch(`${transport.baseUrl}/api/transports/voice/turns${query}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

describe("http-api transport", () => {
  it("accepts a JSON text turn through the transport API and emits semantic outbound events", async () => {
    const transport = await createHttpApiTransport({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
    });
    transports.push(transport);
    /** @type {ChatTurn[]} */
    const turns = [];
    await transport.start(async (turn) => {
      turns.push(turn);
      await turn.io.reply({
        kind: "assistant_output",
        content: "Done.",
      });
    });

    const res = await postTurn(transport, turnPayload("text-20260611-001"));

    assert.equal(res.status, 202);
    const accepted = await res.json();
    assert.equal(accepted.requestId, "text-20260611-001");
    assert.equal(accepted.status, "accepted");
    assert.equal(typeof accepted.turnId, "string");

    await waitFor(() => assert.equal(turns.length, 1));
    assert.equal(turns[0]?.chatId, "api:client-1");
    assert.equal(turns[0]?.senderName, "User");
    assert.deepEqual(turns[0]?.senderIds, ["user-1"]);
    assert.deepEqual(turns[0]?.content, [{ type: "text", text: "turn on the desk light" }]);
    assert.deepEqual(turns[0]?.facts, {
      isGroup: false,
      addressedToBot: true,
      repliedToBot: false,
    });

    const eventsRes = await fetch(`${transport.baseUrl}/api/transports/voice/events?chatId=${encodeURIComponent("api:client-1")}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(eventsRes.status, 200);
    const body = await eventsRes.json();
    assert.equal(body.events.length, 1);
    assert.deepEqual(body.events[0], {
      eventId: "1",
      turnId: accepted.turnId,
      chatId: "api:client-1",
      kind: "assistant_output",
      event: {
        kind: "assistant_output",
        content: "Done.",
      },
    });
  });

  it("does not create duplicate turns for duplicate requestId values", async () => {
    const transport = await createHttpApiTransport({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
    });
    transports.push(transport);
    let callCount = 0;
    await transport.start(async () => {
      callCount += 1;
    });

    const first = await postTurn(transport, turnPayload("duplicate-request"));
    const second = await postTurn(transport, turnPayload("duplicate-request"));

    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    assert.equal(firstBody.turnId, secondBody.turnId);
    assert.equal(firstBody.requestId, "duplicate-request");
    assert.equal(secondBody.requestId, "duplicate-request");
    await waitFor(() => assert.equal(callCount, 1));
  });

  it("returns accepted before non-wait turn handler completion", async () => {
    const transport = await createHttpApiTransport({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
    });
    transports.push(transport);

    let releaseHandler = () => {};
    const handlerReleased = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted = false;
    let handlerCompleted = false;
    await transport.start(async (turn) => {
      handlerStarted = true;
      await handlerReleased;
      await turn.io.reply({
        kind: "assistant_output",
        content: "Async done.",
      });
      handlerCompleted = true;
    });

    const res = await Promise.race([
      postTurn(transport, turnPayload("non-wait-does-not-block")),
      delay(100).then(() => {
        throw new Error("non-wait POST blocked on turn handler");
      }),
    ]);

    assert.equal(res.status, 202);
    const accepted = await res.json();
    assert.equal(accepted.status, "accepted");
    assert.equal(typeof accepted.turnId, "string");
    await waitFor(() => assert.equal(handlerStarted, true));
    assert.equal(handlerCompleted, false);

    releaseHandler();
    await waitFor(() => assert.equal(handlerCompleted, true));
  });

  it("returns completed assistant text in wait mode", async () => {
    const transport = await createHttpApiTransport({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
    });
    transports.push(transport);
    await transport.start(async (turn) => {
      await turn.io.reply({
        kind: "assistant_output",
        content: [{ type: "text", text: "Light is on." }],
      });
    });

    const res = await postTurn(transport, turnPayload("wait-request"), "?wait=true");

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.requestId, "wait-request");
    assert.equal(body.status, "completed");
    assert.equal(body.text, "Light is on.");
  });

  it("accepts raw audio turns and returns synthesized assistant audio", async () => {
    const transport = await createHttpApiTransport({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
      synthesizeSpeech: async ({ text }) => {
        assert.equal(text, "The answer is ready.");
        return {
          buffer: Buffer.from("fake assistant mp3"),
          mimeType: "audio/mpeg",
        };
      },
    });
    transports.push(transport);
    /** @type {ChatTurn[]} */
    const turns = [];
    await transport.start(async (turn) => {
      turns.push(turn);
      await turn.io.reply({
        kind: "assistant_output",
        content: [{ type: "text", text: "The answer is ready." }],
      });
    });

    const res = await fetch(`${transport.baseUrl}/api/transports/voice/audio-turns?wait=true`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "audio/ogg; codecs=opus",
        "x-request-id": "audio-request",
        "x-chat-id": "api:client-1",
        "x-sender-id": "android-user",
        "x-sender-name": "Android User",
      },
      body: Buffer.from("fake ogg opus"),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.requestId, "audio-request");
    assert.equal(body.status, "completed");
    assert.equal(body.text, "The answer is ready.");
    assert.equal(body.audio.mimeType, "audio/mpeg");
    assert.match(body.audio.path, /^[a-f0-9]{64}\.mp3$/);
    assert.equal(body.audio.url, `${transport.baseUrl}/api/media/${body.audio.path}`);

    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.senderName, "Android User");
    assert.deepEqual(turns[0]?.senderIds, ["android-user"]);
    assert.deepEqual(turns[0]?.content, [
      {
        type: "audio",
        path: turns[0]?.content[0]?.path,
        mime_type: "audio/ogg; codecs=opus",
      },
    ]);
    assert.match(turns[0]?.content[0]?.path ?? "", /^[a-f0-9]{64}\.ogg$/);

    const audioRes = await fetch(body.audio.url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(audioRes.status, 200);
    assert.equal(audioRes.headers.get("content-type"), "audio/mpeg");
    assert.equal(Buffer.from(await audioRes.arrayBuffer()).toString("utf8"), "fake assistant mp3");

    const eventsRes = await fetch(`${transport.baseUrl}/api/transports/voice/events?chatId=${encodeURIComponent("api:client-1")}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const eventsBody = await eventsRes.json();
    assert.equal(eventsBody.events.length, 2);
    assert.deepEqual(eventsBody.events.map((event) => event.kind), ["assistant_output", "assistant_output"]);
    assert.deepEqual(eventsBody.events[1].event.content, [
      {
        type: "audio",
        path: body.audio.path,
        mime_type: "audio/mpeg",
      },
    ]);
  });

  it("returns turn status by turnId", async () => {
    const transport = await startTransport();
    const res = await postTurn(transport, turnPayload("status-request"));
    const accepted = await res.json();

    let status = null;
    await waitFor(async () => {
      const statusRes = await fetch(`${transport.baseUrl}/api/transports/voice/turns/${accepted.turnId}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(statusRes.status, 200);
      status = await statusRes.json();
      assert.equal(status.status, "completed");
    });
    assert.equal(status.turnId, accepted.turnId);
    assert.equal(status.requestId, "status-request");
    assert.equal(status.chatId, "api:client-1");
    assert.equal(typeof status.createdAt, "string");
    assert.equal(typeof status.updatedAt, "string");
  });

  it("flushes event stream headers before any events are available", async () => {
    const transport = await startTransport();
    const controller = new AbortController();
    try {
      const res = await Promise.race([
        fetch(`${transport.baseUrl}/api/transports/voice/events/stream?chatId=${encodeURIComponent("api:client-empty")}&after=0`, {
          headers: { authorization: `Bearer ${TOKEN}` },
          signal: controller.signal,
        }),
        delay(100).then(() => {
          throw new Error("event stream headers were not flushed");
        }),
      ]);

      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    } finally {
      controller.abort();
    }
  });

  it("rejects unauthorized requests", async () => {
    const transport = await startTransport();

    const res = await fetch(`${transport.baseUrl}/api/transports/voice/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(turnPayload("unauthorized-request")),
    });

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Unauthorized" });
  });

  it("rejects malformed text turn payloads before calling the handler", async () => {
    const transport = await createHttpApiTransport({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
    });
    transports.push(transport);
    let handled = false;
    await transport.start(async () => {
      handled = true;
    });

    const res = await postTurn(transport, {
      requestId: "bad-request",
      chatId: "api:client-1",
      content: [],
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "Expected text turn payload with requestId, chatId, and one text content block",
    });
    assert.equal(handled, false);
  });
});
