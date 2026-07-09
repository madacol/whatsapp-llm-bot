import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stripMarkdownLinkTargetsForSpeech } from "../http-api-speech.js";

describe("HTTP API speech text preparation", () => {
  it("replaces inline Markdown links with labels while preserving bare URLs", () => {
    assert.equal(
      stripMarkdownLinkTargetsForSpeech(
        "Read [the docs](https://example.com/docs?q=1) and keep https://example.com/raw.",
      ),
      "Read the docs and keep https://example.com/raw.",
    );
  });

  it("handles image labels and nested URL parentheses without speaking targets", () => {
    assert.equal(
      stripMarkdownLinkTargetsForSpeech(
        "See ![architecture diagram](https://example.com/image(1).png) and [API](https://example.com/a_(b)).",
      ),
      "See architecture diagram and API.",
    );
  });

  it("leaves escaped or incomplete Markdown links unchanged", () => {
    assert.equal(
      stripMarkdownLinkTargetsForSpeech("\\[literal](https://example.com) and [broken](https://example.com"),
      "\\[literal](https://example.com) and [broken](https://example.com",
    );
  });
});
