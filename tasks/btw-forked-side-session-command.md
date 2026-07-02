# `/BTW` Forked Side Session Command

Status: Todo

## Subject

Add `/BTW <input>` as an MVP command that forks the current session and sends the input as the first turn in the fork.

## Evidence

User clarified the desired shape on 2026-07-02:

- It is `/BTW`, uppercase in the public interface.
- It should be a forked session, not a special "side question" response.
- The core behavior must be transport-agnostic; only presentation is transport-specific.
- It should use normal agent capabilities, including tools and media.
- The parent session must remain unchanged.
- The fork should get a short conflict-awareness note because another agent may be running and editing files.
- Keep the MVP minimal to test whether the feature is useful.

Relevant audio notes:

- [9c9bb99598b213f4d4662972178f0791fe503364cec088f2c03ffbb97c3c7d90.ogg](../.media/9c9bb99598b213f4d4662972178f0791fe503364cec088f2c03ffbb97c3c7d90.ogg)
- [0c74b6e4828220c942337c89328bb666bf73775fa2e7169822334c17b6c276cd.ogg](../.media/0c74b6e4828220c942337c89328bb666bf73775fa2e7169822334c17b6c276cd.ogg)
- [4b7cf095f6f487ae3bd17304567544ad5d51e9b2ce96b0758650a8597617f284.ogg](../.media/4b7cf095f6f487ae3bd17304567544ad5d51e9b2ce96b0758650a8597617f284.ogg)

## MVP Behavior

- Recognize `/BTW <input>` before normal agent turn dispatch.
- Fork the current session.
- Send the command's text and media payload as the first child-session turn, with the `/BTW` token stripped.
- Keep the parent session context and run state unchanged.
- Add a short child-session preamble: this is a side fork; another agent may be running; avoid conflicting edits; report files touched.
- Emit normal agent events tagged with the child/fork session identity.

## Presentation

Only transports decide how to label the fork. WhatsApp can prefix child-session output with a compact `BTW <id>:` label.

## Acceptance Criteria

- `/BTW <input>` creates a forked child session and starts a normal agent turn there.
- Text and media from the `/BTW` message reach the child session.
- Parent session history is not polluted by the `/BTW` turn or child outputs.
- Child outputs carry enough identity for transports to present them as a side session.
- WhatsApp labels the child output distinctly without changing core session behavior.
