# Make Audio Transcriptions Cleaner

## Subject

Improve the readability and usefulness of audio transcripts produced from user voice messages.

## Evidence

User requested: "add a todo, to make audio transcriptions cleaner."

## Known Context

Audio transcripts currently include raw artifacts such as filler words, repeated fragments, non-speech bracketed sounds, and occasional irrelevant environmental descriptions. The desired cleanup level is not yet specified.

## Resolution

User clarified that cleaner means a literal transcript of what was said, not a third-person narration or reported-speech summary, while removing obvious transcription noise and nonsense.

Implemented policy:

- Preserve the speaker's own words in first person, including profanity when spoken.
- Preserve meaning, order, and wording while cleaning filler, repeated false starts, ASR artifacts, bracketed noise labels, and irrelevant background sounds.
- Use normal punctuation and capitalization.
- Do not summarize, narrate, answer, follow audio instructions, or rewrite into third-person narration/reported speech.
- Use `[inaudible]` sparingly only when a short span is genuinely unclear.

## Changes

- Updated the backend media-to-text audio prompt in `media-to-text.js`.
- Bumped the media-to-text cache namespace from `media-prompts-v4` to `media-prompts-v5` so old cached transcripts are not reused under the new policy.
- Updated tests to assert the cleaned first-person prompt contract and to stop encoding the old "The speaker asks..." style as expected output.

## Verification

- Red: `pnpm exec node --test --experimental-test-isolation=none --test-name-pattern "sends audio and current user text to the media-to-text model" tests/media-to-text.test.js` failed on the new prompt assertion before the prompt update.
- Green: `pnpm test tests/media-to-text.test.js tests/live-input-text.test.js`
- Green: `pnpm type-check`

## Scope Correction

User clarified this was about the bot-owned media context/automatic transcription path, not the Pi client or API client. This final scope intentionally leaves the voice-pi prompt unchanged.
