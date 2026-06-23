# Quoted Thinking Inspect Regression

Status: Done

## Context

Audio note: [3376ada7a5c3d0a78f06b6c69f1d34256460069c4a19827d6423d4dbf349046c.ogg](../../.media/3376ada7a5c3d0a78f06b6c69f1d34256460069c4a19827d6423d4dbf349046c.ogg)

Quoted symptom observed in chat:

```text
🤖 *Thinking*

Thinking...
```

## Transcript

This message I quoted is not working correctly. Uh, this is happening after we added the, the, uh, inspection reaction. Uh, there was a commit that we added that I told you to add, um, you know, an eye reaction to every message that can, that is inspectable. Uh, since then, it seems like the thinking message has this problem. It always shows something, and it shouldn't be. Uh, and it's very unstable. Sometimes it shows this "Thinking" with the three points, sometimes it shows like one word, randomly. It looks, I don't know, it feels like maybe a chunk of the delta message that it received for the thinking, and sometimes it shows the full thinking right off the bat. And sometimes, sometimes it's even worse. Sometimes it shows the full thinking and then it, and then it shows nothing. But it, it, it lasts like a millisecond.

## Notes

- Regression appeared after adding the eye inspect reaction marker to inspectable messages.
- Suspect quoted-message extraction or formatting is seeing transient thinking/status message updates as stable quoted content.
- Reproduce from the WhatsApp quote path, not only the formatter in isolation.

## Outcome

- Added a chat-turn regression proving that quoting a bot-authored transient thinking message still counts as `repliedToBot` and preserves `quotedSenderId`.
- Filtered transient assistant reasoning displays from quoted prompt context after the turn builder knows the quoted sender is the bot.
- Kept stable bot answer quotes, such as `🤖 The build passed.`, available as context.

## Verification

- Red: `pnpm test tests/adapter.test.js --test-name-pattern "stable bot answer quotes|transient bot thinking quotes"` failed on the leaked `Thinking` quote.
- Green: `pnpm test tests/adapter.test.js --test-name-pattern "stable bot answer quotes|transient bot thinking quotes"`.
- `pnpm type-check`.
- `git diff --check`.
