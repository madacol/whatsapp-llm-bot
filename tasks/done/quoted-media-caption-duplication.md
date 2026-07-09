# Quoted Media Caption Duplication

Status: Complete

## Subject

Fix duplicated captions in normalized quoted media content. Quoted images, videos, and documents with captions should expose the caption once, not once as quote text and once as media caption text.

## Evidence

During the `/wait` replied-media regression work on 2026-07-05, a vertical test exposed quoted image content shaped as:

- `text`: quoted image caption
- `image`: downloaded quoted image
- `text`: the same quoted image caption again

The duplicate came from `whatsapp/inbound/message-content.js`: `getQuotedText()` extracted media captions before media extraction, and `downloadMediaToBlocks()` also appended the media caption.

## Completion

Completed on 2026-07-05.

Quoted media extraction now lets media handling emit captions once on successful media handling. If quoted media download fails, the extractor preserves real caption text when available but does not inject synthetic `[Quoted ...]` placeholder text into the quote content.

Regression coverage:

- Added adapter coverage for quoted image captions appearing exactly once.
- Extended quoted document coverage to assert the document caption is not duplicated.
- Added adapter coverage that quoted media download failures do not inject placeholder text.
- Tightened the `/wait` quoted-image vertical regression to expect `quote` content shaped as image plus one caption text block.

Verification:

- `pnpm exec node scripts/test-runner.js --test-name-pattern "quoted|quote|caption" tests/adapter.test.js`
- `pnpm exec node scripts/test-runner.js tests/vertical/wait-send-batching.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
- `git diff --check`
