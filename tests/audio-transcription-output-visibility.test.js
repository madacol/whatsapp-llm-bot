import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAudioTranscriptionStatusObserver } from "../conversation/create-conversation-runner.js";
import { DEFAULT_OUTPUT_VISIBILITY } from "../chat-output-visibility.js";

/**
 * @returns {{
 *   context: Pick<ExecuteActionContext, "send" | "reply">,
 *   sent: OutboundEvent[],
 *   replies: OutboundEvent[],
 *   updates: MessageHandleUpdate[],
 *   inspects: MessageInspectState[],
 * }}
 */
function createSubject() {
  /** @type {OutboundEvent[]} */
  const sent = [];
  /** @type {OutboundEvent[]} */
  const replies = [];
  /** @type {MessageHandleUpdate[]} */
  const updates = [];
  /** @type {MessageInspectState[]} */
  const inspects = [];
  return {
    sent,
    replies,
    updates,
    inspects,
    context: {
      send: async (event) => {
        sent.push(structuredClone(event));
        return undefined;
      },
      reply: async (event) => {
        replies.push(structuredClone(event));
        return {
          transportHandleId: "transcription-status-1",
          update: async (update) => { updates.push(structuredClone(update)); },
          setInspect: (inspect) => { if (inspect) inspects.push(structuredClone(inspect)); },
        };
      },
    },
  };
}

/** @type {AudioContentBlock} */
const audioBlock = { type: "audio", path: "voice.ogg", mime_type: "audio/ogg" };

describe("audio transcription output visibility", () => {
  it("hides transcription status and details when transcription is hidden", async () => {
    const subject = createSubject();
    const observer = createAudioTranscriptionStatusObserver(subject.context, {
      ...DEFAULT_OUTPUT_VISIBILITY,
      transcription: "hidden",
    });

    await observer.onAudioTranscriptionStart({
      block: audioBlock,
      modelId: "audio-model",
    });
    await observer.onAudioTranscriptionComplete({
      block: audioBlock,
      modelId: "audio-model",
      transcription: "hello",
    });
    await observer.onAudioTranscriptionFailure({
      block: audioBlock,
      modelId: "audio-model",
      error: new Error("boom"),
    });

    assert.deepEqual(subject.sent, []);
    assert.deepEqual(subject.replies, []);
    assert.deepEqual(subject.updates, []);
    assert.deepEqual(subject.inspects, []);
  });

  it("shows compact inspectable transcription status by default", async () => {
    const subject = createSubject();
    const observer = createAudioTranscriptionStatusObserver(subject.context, DEFAULT_OUTPUT_VISIBILITY);

    await observer.onAudioTranscriptionStart({
      block: audioBlock,
      modelId: "audio-model",
    });
    await observer.onAudioTranscriptionComplete({
      block: audioBlock,
      modelId: "audio-model",
      transcription: "hello",
    });

    assert.deepEqual(subject.replies, [{
      kind: "app_message",
      role: "plain",
      content: "Transcribing audio...",
      replyToTriggeringMessage: true,
      presentationCategory: "transcription",
      presentationStatus: "started",
    }]);
    assert.deepEqual(subject.updates, [{ kind: "text", text: "Transcribed" }]);
    assert.deepEqual(subject.inspects, [{ kind: "text", text: "hello" }]);
  });

  it("shows full transcription details when configured", async () => {
    const subject = createSubject();
    const observer = createAudioTranscriptionStatusObserver(subject.context, {
      ...DEFAULT_OUTPUT_VISIBILITY,
      transcription: "fullDetails",
    });

    await observer.onAudioTranscriptionComplete({
      block: audioBlock,
      modelId: "audio-model",
      transcription: "hello",
    });

    assert.equal(subject.replies.length, 1);
    assert.deepEqual(subject.updates, [{ kind: "text", text: "Transcribed\n\nhello" }]);
    assert.deepEqual(subject.inspects, []);
  });

  it("emits categorized app messages for pinned transcription status", async () => {
    const subject = createSubject();
    const observer = createAudioTranscriptionStatusObserver(subject.context, {
      ...DEFAULT_OUTPUT_VISIBILITY,
      transcription: "pinnedIndicator",
    });

    await observer.onAudioTranscriptionStart({
      block: audioBlock,
      modelId: "audio-model",
    });
    await observer.onAudioTranscriptionComplete({
      block: audioBlock,
      modelId: "audio-model",
      transcription: "hello",
    });

    assert.deepEqual(subject.replies, [{
      kind: "app_message",
      role: "plain",
      content: "Transcribing audio...",
      replyToTriggeringMessage: true,
      presentationCategory: "transcription",
      presentationStatus: "started",
    }]);
    assert.deepEqual(subject.sent, [{
      kind: "app_message",
      role: "plain",
      content: "Transcribed",
      presentationCategory: "transcription",
      presentationStatus: "completed",
    }]);
    assert.deepEqual(subject.updates, []);
    assert.deepEqual(subject.inspects, []);
  });
});
