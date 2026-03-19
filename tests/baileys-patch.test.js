import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeMessageContent } from "@whiskeysockets/baileys";

describe("Baileys patch", () => {
  it("unwraps media nested in associatedChildMessage", () => {
    const content = normalizeMessageContent({
      associatedChildMessage: {
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
            url: "https://example.com/hd-child.jpg",
          },
        },
      },
    });

    assert.deepEqual(content, {
      imageMessage: {
        mimetype: "image/jpeg",
        url: "https://example.com/hd-child.jpg",
      },
    });
  });
});
