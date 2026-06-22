# Quoted Thinking Inspect Regression

Status: Todo

## Context

Audio note: [3376ada7a5c3d0a78f06b6c69f1d34256460069c4a19827d6423d4dbf349046c.ogg](../.media/3376ada7a5c3d0a78f06b6c69f1d34256460069c4a19827d6423d4dbf349046c.ogg)

Quoted symptom observed in chat:

```text
🤖 *Thinking*

Thinking...
```

## Transcript

This message I quoted is not working correctly. Uh, this is happening after we added the, the, uh, inspection reaction. Uh, there was a commit that we added that I told you to add, um, you know, an eye reaction to every message that can, that is inspectable. Uh, since then, it seems like the thinking message has this problem. It always shows something, and it shouldn't be. Uh, and it's very unstable. Sometimes it shows this "Thinking" with the three points, sometimes it shows like one word, randomly. It looks, I don't know, it feels like maybe a chunk of the delta message that it received for the thinking, and sometimes it shows the full thinking right off the bat. And sometimes, sometimes it's even worse. Sometimes it shows the full thinking and then it, and then it shows nothing. But it, it, it lasts like a millisecond.

## Additional Examples

Audio note: [9295db3e206e550e5f98017427a057a342f07121f773a5ea2f73f6159bfb0315.ogg](../.media/9295db3e206e550e5f98017427a057a342f07121f773a5ea2f73f6159bfb0315.ogg)

Observed symptom: multiple separate thinking/progress traces were visible as one coalesced message. The user called out that this should be fixed in this task.

```text
🤖 *Thought*

**Updating AGENTS instructions**
...
Thinking...**Clarifying instructions for modifications**
...
Thinking...**Preparing for a new commit**
...
**Updating AGENTS instructions**
...
```

Audio note: [3112ca3c2ef7b2bc559a5a3530d654ead5a910e90ffc6bd3be69d9c604e190ef.ogg](../.media/3112ca3c2ef7b2bc559a5a3530d654ead5a910e90ffc6bd3be69d9c604e190ef.ogg)

Observed symptom: a second quoted trace shows the same shape, with multiple internal thinking sections stitched into one visible message and repeated content.

```text
🤖 *Thought*

**Addressing user requests**
...
Thinking...**Updating tests based on user feedback**
...
Thinking...**Deciding on test modifications**
...
**Addressing user requests**
...
```

## Notes

- Regression appeared after adding the eye inspect reaction marker to inspectable messages.
- Suspect quoted-message extraction or formatting is seeing transient thinking/status message updates as stable quoted content.
- Reproduce from the WhatsApp quote path, not only the formatter in isolation.
- The fix should preserve separate thinking/update events as separate presentation states; it should not concatenate multiple internal traces into one visible message.
