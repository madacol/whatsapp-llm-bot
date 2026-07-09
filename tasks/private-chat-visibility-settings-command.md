# Private/LID Visibility Settings Poll Settlement Verification

## Status

Implementation complete in the working tree; live/deploy verification pending. The remaining task is verification, not another code fix.

## Subject

Verify private-chat/LID-addressed WhatsApp poll votes for the visibility settings picker after the code fix is deployed or the affected ingress row is replayed. The initial `!s show` command path appears sound; the observed failure was a poll-vote settlement failure after the picker is shown.

## Evidence

User audio transcript on 2026-07-09:

> Please add to the task to research why the command to show the settings, the visibility settings, do not work on the private chat with the bot. In the groups, it seems to work fine.

Media: `/home/mada/whatsapp-llm-bot/.media/216d3057277bbf1e274076142e34bd398b3bb256650d5ac2fac9df357a0d636a.ogg`

Existing task history suggested the affected command was probably `!s show`, because completed tasks recently added the interactive show-settings picker and presets. Code inspection confirmed `!s show` enters `runInteractiveShowSettings` when sent without a value.

Live ingress journal evidence from `./pgdata/root.sqlite`, row `58912`, shows the current concrete failure:

- `source_event_type`: `messages.upsert`
- `state`: `received`
- `attempt_count`: over 600 retries during inspection
- `chat_id` shape: private/LID-addressed, not group
- message key: `fromMe: false`, `addressingMode: "lid"`
- poll creation key: `fromMe: true`, LID-addressed
- encrypted vote fields are present as strings
- failure:

```text
TypeError: Cannot read properties of undefined (reading 'getPNsForLIDs')
at getPNForLID (.../node_modules/@whiskeysockets/baileys/lib/Signal/lid-mapping.js:200:28)
at normalizePollChatId (whatsapp/runtime/select-runtime.js:323:29)
at decryptAndResolvePollVote (whatsapp/runtime/select-runtime.js:548:18)
at Object.resolvePollVoteMessage (whatsapp/runtime/select-runtime.js:850:14)
at processIncomingUpsertMessage (whatsapp/create-whatsapp-transport.js:1066:53)
at processRow (whatsapp/inbound/ingress-dispatcher.js:69:24)
```

This means the row gets past poll creation lookup and vote payload normalization, but fails while converting the returned LID chat id to a phone-number JID.

Related code findings:

- `runChatSettingsInteraction` routes `!s show` without a value into `runInteractiveShowSettings`.
- Private chats get `select`, `selectMany`, and `getIsAdmin`; `getIsAdmin` returns true for non-group chats.
- Bang commands route regardless of chat enabled state.
- `selectRuntime.handlePollVote` matches pending selections by `pollMsgId`, not by `chatId`, so chat-id normalization failure should not block vote settlement.
- `normalizePollChatId` calls `sock.signalRepository?.lidMapping?.getPNForLID(chatId)` when the chat id is a LID. In this live row Baileys exposes a function, but that function throws internally because its `getPNsForLIDs` dependency is unavailable.

## Scope

- Make LID chat-id normalization in the poll select runtime best-effort. If Baileys LID mapping is unavailable or throws, keep the original LID chat id and continue settling by poll id.
- Cover both raw `messages.upsert.pollUpdateMessage` and `messages.update.pollUpdates`, because both paths call `normalizePollChatId`.
- Add a regression based on a private/LID poll vote shape where `signalRepository.lidMapping.getPNForLID` throws after the vote is otherwise resolvable.
- Prefer a sanitized synthetic fixture derived from the row `58912` shape instead of committing live identifiers.
- After the fix, confirm the stuck row drains or can be replayed successfully.

## Non-Goals

- Do not redesign the visibility settings UI as part of the research task.
- Do not change the command parser or settings service unless new evidence contradicts the current finding.
- Do not make chat-id normalization mandatory for poll settlement.
- Do not commit live WhatsApp identifiers.

## Proposed Fix

Update `whatsapp/runtime/select-runtime.js` so `normalizePollChatId` catches errors from Baileys LID mapping and returns the original LID chat id. Add a focused log/debug message if useful, but do not treat the mapping failure as a vote failure.

Then add coverage:

- select-runtime unit regression for a private/LID raw poll vote where `getPNForLID` throws;
- select-runtime or transport regression for the `messages.update` path with a LID `remoteJid` and throwing mapper;
- optional transport-level replay using sanitized values shaped like row `58912`.

Relevant lines at research time:

- `whatsapp/runtime/select-runtime.js:313` `normalizePollChatId`
- `whatsapp/runtime/select-runtime.js:547` raw vote path normalizes chat id after resolving selected options
- `whatsapp/runtime/select-runtime.js:579` `messages.update` path also normalizes chat id
- `whatsapp/runtime/select-runtime.js:599` pending selection settlement uses `pollMsgId`
- `whatsapp/create-whatsapp-transport.js:1066` raw poll update dispatch into select runtime

## Implementation Notes

- `normalizePollChatId` now calls `lidMapping.getPNForLID(chatId)` with the Baileys LID mapping object as the method receiver instead of extracting the method and losing `this`.
- LID mapping errors are caught; the select runtime keeps the original LID chat id and continues returning the poll vote event.
- Added select-runtime regressions for:
  - raw private/LID `messages.upsert.pollUpdateMessage` votes with encrypted/base64 vote fields;
  - decrypted private/LID `messages.update.pollUpdates` votes.
- Both regressions use a mapper shaped like Baileys' `getPNForLID` method, where the method depends on `this.getPNsForLIDs`, and force that mapper to throw so poll settlement must not depend on chat-id normalization.

## Next Action

Deploy the code containing `68bd5ea` or replay the affected ingress row, then confirm the row no longer retries with `getPNsForLIDs`. If a different live failure appears, record that as a new concrete task.

## Acceptance Criteria

- A private/LID-addressed visibility settings poll vote settles even when Baileys LID-to-PN mapping is unavailable or throws.
- Raw `messages.upsert.pollUpdateMessage` and `messages.update.pollUpdates` both preserve poll-vote settlement with LID chat ids.
- A regression fails before the fix and passes after it.
- The live stuck ingress row is no longer retrying with `getPNsForLIDs` after deploy/replay, or any remaining failure is captured as a new concrete task.

## Research Verification

- `pnpm test tests/chat-settings.test.js tests/select-runtime.test.js tests/whatsapp-transport.test.js` passed all settings/select tests and the relevant poll-settlement tests, then failed in unrelated outbound queue replay tests:
  - `quarantines row-specific replay failures without blocking later FIFO rows`
  - `runs connection-open hooks after queued outbound flushes complete`
- Existing coverage proves the settings service and prior group/LID poll regressions are green, but it does not cover private/LID chat-id normalization failure.
- Implementation verification:
  - `pnpm test tests/select-runtime.test.js`
  - `pnpm type-check`
  - `pnpm type-check:tests`
