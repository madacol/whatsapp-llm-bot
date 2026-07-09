# HTTP API TTS Markdown Link Labels

## Task

Before assistant text is sent to HTTP API text-to-speech, convert Markdown links from `[label](url)` to just `label`. The displayed assistant text and stored outbound event should remain unchanged.

## Evidence

- User asked to remove URL links before text-to-speech, more precisely: for Markdown links, remove the URL part and leave the human-readable/header part.
- HTTP API transport queues speech synthesis from completed assistant output via `synthesizeSpeech({ text })`.
- The web audio client plays audio blocks produced by the HTTP API transport, so backend TTS input is the right owner layer.

## Acceptance Criteria

- Markdown links in assistant text are spoken as their readable labels only.
- Displayed HTTP API assistant text still includes the original Markdown content.
- The sanitizer applies before the `synthesizeSpeech` hook, including injected test/custom TTS implementations.
- Focused tests and type checks pass.

## Completion Notes

- Added `stripMarkdownLinkTargetsForSpeech` in `http-api-speech.js`.
- Applied the sanitizer before calling the configured HTTP API `synthesizeSpeech` hook.
- Also applied the sanitizer in the default `synthesizeSpeechForHttpApi` provider entrypoint for direct callers.
- Bare URLs are preserved; inline Markdown links and image Markdown keep only their readable label/alt text.

## Verification

- `pnpm test tests/http-api-transport.test.js` with escalated local bind permission
- `pnpm test tests/http-api-speech.test.js`
- `pnpm type-check`
- `pnpm type-check:tests`
