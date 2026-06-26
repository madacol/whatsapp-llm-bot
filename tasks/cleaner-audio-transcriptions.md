# Make Audio Transcriptions Cleaner

## Subject

Improve the readability and usefulness of audio transcripts produced from user voice messages.

## Evidence

User requested: "add a todo, to make audio transcriptions cleaner."

## Known Context

Audio transcripts currently include raw artifacts such as filler words, repeated fragments, non-speech bracketed sounds, and occasional irrelevant environmental descriptions. The desired cleanup level is not yet specified.

## Ambiguity

Clarify whether "cleaner" means:

- light cleanup for readability while preserving wording;
- removal of filler/repeated fragments and background-noise annotations;
- speaker/segment formatting;
- improving the transcription prompt, model, or processing path itself.

## Next Action

Inspect the current audio transcription pipeline and representative examples, then propose a cleanup policy before changing behavior.

## Acceptance Criteria

- A clear cleanup policy exists for voice-message transcripts.
- The policy is covered by representative examples or tests.
- Transcripts remain faithful enough for agent task execution while becoming easier to read.
