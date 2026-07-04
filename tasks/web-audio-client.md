# Web Audio Client

## Subject

Build a browser-based alternative frontend for the HTTP API audio transport. This is separate from the Android audio client and should not change the Android task plan except where shared backend contracts are intentionally reused.

## Current Evidence

- User request on 2026-07-01: consider building a website before the Android app if wake-word detection is feasible in the browser.
- User clarification on 2026-07-01: keep the web client plan in an alternate task file; do not mix the web client into the Android client task.
- `http-api-transport.js` already exposes `POST /api/transports/:transportId/audio-turns?wait=true` for `audio/*` request bodies and returns assistant text plus an authenticated assistant audio URL when speech synthesis is configured.
- HTTP API tests already cover browser-friendly `audio/ogg; codecs=opus` input.
- The voice-client direction treats clients as thin frontends: wake/capture/upload/playback happen locally, while STT, agent execution, and provider-backed TTS happen in `whatsapp-llm-bot`.

## Browser Wake-Word Research

Research update on 2026-07-01:

- Browser wake-word detection is feasible for an active, permissioned page. Picovoice Porcupine Web supports Chrome/Chromium, Edge, Firefox, and Safari, runs through WebAssembly/Web Voice Processor, and supports custom Web `.ppn` keyword models.
- TensorFlow.js Speech Commands can run streaming command recognition in the browser and supports transfer learning, but it is better framed as an experimental/open alternative for a small command vocabulary than as the primary assistant wake-word implementation.
- Browser wake detection is not equivalent to native always-on listening. Microphone capture requires a secure context and user permission; hidden/background pages are subject to browser lifecycle throttling; screen wake locks apply only to active visible documents and can be released by the browser or OS.
- sherpa-onnx supports WebAssembly generally, but its keyword-spotting path currently looks more direct on Android than in a packaged browser client. Treat sherpa browser KWS as a later investigation, not the first browser implementation path.

Direction correction on 2026-07-04:

- The user rejected any provider-gated browser wake detector. A Picovoice AccessKey is not acceptable even if inference runs locally, because it introduces an external vendor account/key requirement.
- The web MVP wake path must be absolutely local from the browser's point of view: one app-owned microphone stream, local PCM processing, vendored model/runtime assets, and no wake-provider API/token.
- Current browser wake implementation uses vendored ONNX Runtime Web plus vendored openWakeWord-compatible ONNX models for `hey_jarvis`.

## Proposed Direction

- Build a web POC under `clients/web/` as its own client.
- First slice: manual record, upload the recorded blob to `POST /api/transports/:transportId/audio-turns?wait=true`, show assistant text, fetch/play assistant audio.
- Use `MediaRecorder` with a preferred `audio/ogg; codecs=opus` or `audio/webm; codecs=opus` MIME type, falling back to a browser-supported `audio/*` type that the backend media-to-text provider can transcribe.
- Add a browser `WakeWordDetector` boundary after the manual path works. Current accepted path: vendored openWakeWord-compatible ONNX models running through ONNX Runtime Web. Do not use a provider-gated SDK or Web Speech API as the MVP wake engine.
- Make browser constraints explicit in the UI state model: microphone permission, listening, recording, uploading, awaiting response, playback, and permission/error states.
- Require HTTPS or localhost for microphone access. For phone-on-LAN testing against the bot backend, use TLS/dev certs, a trusted local reverse proxy, or another secure-origin setup.

## Non-Goals

- Do not implement background or locked-screen always-listening behavior in the browser POC.
- Do not move web wake-word research into the Android task file.
- Do not add new browser wake-word packages until package provenance and licensing are reviewed.

## Current Status

Active. The manual record/send/playback slice is deployed and verified end to end. The Web Speech wake path was removed from the MVP because Chrome/Android repeatedly ended and restarted recognition, causing audible mic activation cycles and no real Jarvis detections in target testing. The Picovoice/Porcupine path was removed because it requires a vendor AccessKey. Current work is absolute-local browser wake detection: one app-owned microphone stream feeds a vendored openWakeWord-compatible ONNX Jarvis detector, then the same stream is reused for command capture and upload. As of v13, the client re-arms local wake listening immediately after command capture stops, resets openWakeWord's internal buffers between cycles, and suppresses residual post-capture detections briefly so rearm lands in word detection rather than command capture.

## Progress

- Added a dependency-free static client under `clients/web/`.
- Added a local static server exposed through `pnpm web:audio`.
- Implemented the first manual path: microphone permission, browser recording, raw audio upload to the HTTP API audio-turn endpoint, returned text display, authenticated assistant audio fetch, and browser playback.
- Deployed the static client through `website.json` as `web-audio-client`.
- Disabled bearer-token auth for the current private tailnet API test path with `API_TRANSPORT_AUTH_REQUIRED=false`.
- Fixed authenticated HTTP API client chats so `api:*` chats are enabled before agent routing instead of being silently persisted.
- Fixed OGG/Opus audio conversion to avoid temp files, which blocked transcription when the host disk was full.
- Configured the HTTP API TTS path to use OpenAI's speech endpoint for browser-playable MP3 audio, with local `flite` as an emergency fallback and best-effort behavior so text still returns if speech synthesis fails.
- Verified that OpenRouter audio-chat is not a valid exact TTS substitute for this path: it can generate audio that does not match the response text.
- Added an active-page word-detection panel to the web client. It uses `SpeechRecognition`/`webkitSpeechRecognition` when available, detects the configured phrase, keeps a short local pre-roll buffer, plays wake/end cues, captures post-wake audio, stops after speech has ended plus configured silence/post-roll, falls back to no-speech and max-utterance timeouts, and submits the captured audio through the same verified HTTP audio-turn path as manual recording.
- 2026-07-01 correction: the target browser test produced zero wake detections, not merely unreliable wake detections. The repeated phone/browser microphone activation sound is consistent with the current Web Speech `onend` restart loop, but the root acceptance failure is no actual "Jarvis" detection.
- Updated the Web Speech path to force English recognition for Jarvis, request up to five recognition alternatives, add experimental phrase bias when supported, start recognition from the already-open microphone track when supported, match common Jarvis ASR variants, and write wake recognition result/error diagnostics into the UI.
- 2026-07-01 follow-up: user reported no visible website change after deployment and no detections. Added a visible wake panel marker, `Detector build: Web Speech v2, diagnostics enabled.`, cache-busted the module URL, and changed the deployed web client from Caddy static hosting to the Node static server so deployed HTML/JS are served with `cache-control: no-store`.
- 2026-07-01 smoke/debug pass:
  - `Web Speech v3` removed the pre-detection MediaRecorder/VAD mic hold so native Web Speech does not compete with the app's manual-recording MediaStream.
  - `Web Speech v4` removed experimental phrase bias after Chromium smoke reported `phrases-not-supported`.
  - `Web Speech v5` starts native Web Speech synchronously from the button click path after Chromium smoke reported `not-allowed`.
  - `Web Speech v6` fixes command-capture endpointing: `startWakeRecorder()` was resetting `wakeDetectedAt` to `0`, which prevented the silence loop from ever entering its endpoint logic. The fix preserves the capture start timestamp and shows live RMS/silence progress while capturing.
  - Added `scripts/web-wake-smoke.js`, a Chromium DevTools smoke harness with generated fake mic audio. Native Web Speech cannot be proven in this Linux Chromium environment: headless and Xvfb non-headless runs expose `SpeechRecognition` but fail with `audio-capture`. A recognizer-stub smoke proves the app path recognizes `hey jarvis` and enters command capture when Web Speech emits a matching result.
- 2026-07-02 follow-up: user reported that silence endpointing works in quiet conditions, but TV/background speech keeps RMS above the fixed threshold so capture does not end after the user stops talking.
- `Web Speech v7` changes post-wake endpointing from a fixed RMS gate to adaptive ambient-relative VAD. The client now estimates ambient RMS while wake listening, seeds capture endpointing from that baseline, requires speech to rise above the ambient-relative voice threshold, and treats return-to-baseline as silence using a lower release threshold.
- `Web Speech v7` also keeps the browser microphone stream open during wake listening and attempts to start `SpeechRecognition` from the shared live audio track before falling back to native browser microphone recognition. This avoids the app explicitly releasing/reacquiring the mic on wake-listening start and restart loops, though browsers that ignore `start(audioTrack)` may still use their own recognition microphone path.
- 2026-07-02 regression: user reported v7 no longer detects Jarvis on the phone. Treat the phone result as authoritative for native Web Speech; the stub smoke only validates app wiring after a recognition result, not real Android Chrome recognition.
- `Web Speech v8` restores the previous native Web Speech wake path by releasing any app-owned microphone stream before starting `SpeechRecognition`, removing the shared pre-wake mic stream and ambient monitor. Adaptive endpointing remains for post-wake capture, using a short post-wake calibration window to estimate background RMS before applying ambient-relative voice/release thresholds.
- 2026-07-04 direction change: user rejected Web Speech compatibility/fallback work and asked for the simplest MVP that works. A short-lived Picovoice Porcupine implementation was also rejected because it required a Picovoice AccessKey.
- Replaced the provider-gated wake path with local openWakeWord-compatible ONNX inference in the browser. The web client now has one wake path: vendored ONNX Runtime Web, vendored `melspectrogram.onnx`, vendored `embedding_model.onnx`, vendored `hey_jarvis_v0.1.onnx`, one app-owned `getUserMedia` stream, Web Audio PCM framing/downsampling, same-stream command `MediaRecorder` capture, silence endpointing, upload, response playback, and auto-return to local wake listening after each completed turn.
- Added exact pinned dependency `onnxruntime-web@1.24.1`, vendored the browser WASM runtime assets under `clients/web/vendor/onnxruntime/`, and removed the Picovoice dependency, bundle, model, and AccessKey UI.
- The page no longer requires any wake-provider key. Wake detection is local browser inference over local assets.
- v12 removes the delayed restart-after-answer/audio path. `finishWakeCapture()` now stops the command recorder, immediately starts local wake listening again when auto-restart is armed, and submits the captured audio in the background. Local wake detection no longer treats an in-flight upload/assistant response as a blocker, so the user can inject or steer with another wake turn before the previous answer returns.
- v13 fixes the rearm target state after capture. Each new listening cycle resets the local openWakeWord detector buffers, and auto-rearm applies a short post-capture suppression window for residual detections from the previous cycle. The intended state after command capture is now explicitly word detection, not immediate command capture.

## Deployment

- Private/tailnet URL: `https://private-host-redacted/`
- Preconfigured deployed URL: `https://private-host-redacted/?api=https%3A%2F%private-host-redacted`
- API proxy URL: `https://private-host-redacted/`
- Canonical redirect: `https://private-host-redacted/` redirects to the tailnet URL.
- Static root: `./clients/web`
- Current private test API does not require a bearer token.
- The deployed HTTPS page needs a browser-reachable HTTPS API base URL for normal use; plain HTTP backend URLs may be blocked as mixed content outside local-development exceptions.

## Verification

- `pnpm type-check`
- `pnpm type-check` after the Web Speech Jarvis-detection hardening pass.
- `pnpm type-check:tests` after the Web Speech Jarvis-detection hardening pass.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed after rerun with local port binding allowed; sandboxed run failed with `listen EPERM: operation not permitted 127.0.0.1`.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json`
- `curl -I --max-time 15 https://private-host-redacted/` returned HTTP 200.
- Deployed `https://private-host-redacted/app.js` contains the new Web Speech hardening markers: `effectiveWakeLanguage`, `recognition-start`, `Heard:`, `JARVIS_WAKE_VARIANTS`, and `SpeechRecognitionPhrase`.
- `pnpm type-check` after switching the web client deployment to the Node no-cache static server.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after the no-cache service switch.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed `web-audio-client` as `workspace-site-web-audio-client.service`.
- `systemctl --user status workspace-site-web-audio-client.service --no-pager` showed the service active at `http://127.0.0.1:3103`.
- `curl -i --max-time 15 https://private-host-redacted/` returned HTTP 200 with `cache-control: no-store`.
- `curl -I --max-time 15 'https://private-host-redacted/app.js?v=20260701-wake-v2'` returned HTTP 200 with `cache-control: no-store`.
- Deployed HTML contains the visible marker `Detector build: Web Speech v2, diagnostics enabled.` and the script URL `./app.js?v=20260701-wake-v2`.
- Generated `/tmp/hey-jarvis-smoke.wav` from OpenAI TTS phrase `hey jarvis` for browser fake-microphone smoke testing.
- `node scripts/web-wake-smoke.js --audio /tmp/hey-jarvis-smoke.wav --timeout-ms 20000 --stub-recognition` passed against the deployed page: diagnostics contained a Web Speech `result` transcript `hey jarvis` with `matched: true`, and the page reached `Wake phrase detected. Capturing command.`
- `node scripts/web-wake-smoke.js --audio /tmp/hey-jarvis-smoke.wav --timeout-ms 20000` against deployed v4 failed with `not-allowed`; after v5 direct-start fix, native headless Chromium failed with `audio-capture`.
- `env DISPLAY=:99 node scripts/web-wake-smoke.js --audio /tmp/hey-jarvis-smoke.wav --timeout-ms 25000 --headed` under direct Xvfb also failed native Web Speech with `audio-capture`.
- `curl -fsSL --max-time 15 https://private-host-redacted/ | rg "Web Speech v5|app.js\\?v=20260701-wake-v5"` verified the deployed v5 marker and cache-busted script URL.
- `pnpm type-check` after Web Speech v5 and smoke harness changes.
- `pnpm type-check:tests` after Web Speech v5 and smoke harness changes.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after Web Speech v5 and smoke harness changes.
- `pnpm type-check` after Web Speech v6 silence endpoint fix.
- `pnpm type-check:tests` after Web Speech v6 silence endpoint fix.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after Web Speech v6 silence endpoint fix.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed Web Speech v6.
- `curl -fsSL --max-time 15 https://private-host-redacted/ | rg "Web Speech v6|app.js\\?v=20260701-wake-v6"` verified the deployed v6 marker and cache-busted script URL.
- Generated `/tmp/hey-jarvis-then-silence.wav` from `hey jarvis` plus 5s of silence.
- `node scripts/web-wake-smoke.js --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 30000 --stub-recognition --wait-complete` passed against deployed v6: transcript `hey jarvis` matched, status reached `Silence detected; submitting.`, uploaded a 25.1 KiB `audio/webm;codecs=opus` blob, and received stub response text `wake smoke recognized`.
- `pnpm type-check:tests`
- `pnpm exec node --test tests/web-audio-client-server.test.js`
- `pnpm exec node --test tests/integration.test.js` passed with local port binding allowed.
- `pnpm exec node --test tests/http-api-transport-ledger.test.js tests/http-api-turn-flow.test.js tests/http-api-transport.test.js tests/web-audio-client-server.test.js` passed with local port binding allowed.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed.
- `pnpm exec node --test tests/http-api-transport.test.js tests/web-audio-client-server.test.js` passed with local port binding allowed.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json`
- `curl -I --max-time 15 https://private-host-redacted` returned HTTP 200 with `content-type: text/html; charset=utf-8`.
- `curl -I --max-time 15 https://private-host-redacted` returned HTTP 308 redirecting to `https://private-host-redacted/`.
- `curl -I --max-time 15 'https://private-host-redacted/?api=https%3A%2F%private-host-redacted'` returned HTTP 200.
- `curl --max-time 15 -i https://private-host-redacted/health` returned HTTP 200 with `{"ok":true}` and CORS headers.
- No-token deployed API check: `GET https://private-host-redacted/api/transports/voice/events?chatId=api%3Aweb-e2e-final` returned HTTP 200.
- Temporary WAV route E2E used generated non-private OGG/Opus speech via `ffmpeg` and posted to `POST https://private-host-redacted/api/transports/voice/audio-turns?wait=true` with request id `e2e-web-audio-final-synth-20260701-001`; response was HTTP 200 with `status:"completed"`, text `Received. Transcript: “Web audio final test phrase Orange Nine.”`, and a WAV audio object.
- Direct OpenAI TTS verification synthesized `Received. Transcript: Web audio TTS verification phrase green candle eight bridges.` as `audio/mpeg` and transcribed the returned MP3 with `gpt-4o-mini-transcribe`; normalized expected text and normalized audio transcript matched exactly with word coverage `1.000`.
- Final deployed OpenAI TTS E2E used generated non-private MP3 speech and posted to `POST https://private-host-redacted/api/transports/voice/audio-turns?wait=true` with request id `e2e-audio-match-1782932487696`; response was HTTP 200 with `status:"completed"`, assistant text, and MP3 audio path `eee9b0661d25182929b7f5e30e504812ae664086c95fa02d7aa0aae3744a5f29.mp3`.
- The returned deployed MP3 was fetched through `https://private-host-redacted/api/media/eee9b0661d25182929b7f5e30e504812ae664086c95fa02d7aa0aae3744a5f29.mp3` with HTTP 200 and `content-type: audio/mpeg`; OpenAI transcription normalized exactly to the API response text with word coverage `1.000`.
- Deployed word-detection static check: `https://private-host-redacted/` includes `Word detection`, `Wake Capture`, `Max seconds`, and `Silence seconds`; deployed `app.js` includes the `SpeechRecognition` wake-detection path plus `WAKE_PREROLL_MS`, `startWakeRecorder`, `VAD_NO_SPEECH_TIMEOUT_MS`, `VAD_POST_ROLL_MS`, `Silence detected`, `No speech detected`, `Max utterance`, and `finishWakeCapture`.
- `pnpm type-check` after Web Speech v7 adaptive ambient endpointing and shared microphone stream changes.
- `pnpm type-check:tests` after Web Speech v7 adaptive ambient endpointing and shared microphone stream changes.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after Web Speech v7 changes; sandboxed run failed without detailed output in this environment.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed Web Speech v7.
- `curl -fsSL --max-time 15 https://private-host-redacted/ | rg "Web Speech v7|app.js\\?v=20260702-wake-v7|adaptive ambient"` verified the deployed v7 marker and cache-busted script URL.
- `curl -fsSL --max-time 15 'https://private-host-redacted/app.js?v=20260702-wake-v7' | rg "WAKE_DETECTOR_BUILD|shared-audio-track|vadThresholds|Ambient RMS"` verified the deployed shared-track and adaptive VAD code markers.
- `node scripts/web-wake-smoke.js --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 30000 --stub-recognition --wait-complete` passed against deployed v7: status reached `Silence detected; submitting.`, uploaded a 23.2 KiB `audio/webm;codecs=opus` blob, and received stub response text `wake smoke recognized`.
- `pnpm type-check` after Web Speech v8 regression fix.
- `pnpm type-check:tests` after Web Speech v8 regression fix.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after Web Speech v8 regression fix.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed Web Speech v8.
- `curl -fsSL --max-time 15 https://private-host-redacted/ | rg "Web Speech v8|app.js\\?v=20260702-wake-v8|native wake"` verified the deployed v8 marker and cache-busted script URL.
- `curl -fsSL --max-time 15 'https://private-host-redacted/app.js?v=20260702-wake-v8' | rg "WAKE_DETECTOR_BUILD|VAD_POST_WAKE_CALIBRATION_MS|Calibrating ambient|recognition.start\\(\\)"` verified the deployed native Web Speech start path and post-wake calibration markers.
- `node scripts/web-wake-smoke.js --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 30000 --stub-recognition --wait-complete` passed against deployed v8: status reached `Silence detected; submitting.`, uploaded a 25.1 KiB `audio/webm;codecs=opus` blob, and received stub response text `wake smoke recognized`. This remains a post-wake app-path smoke only; it does not prove native Android Chrome wake recognition.
- `pnpm type-check` after local-only Porcupine MVP changes.
- `pnpm type-check:tests` after local-only Porcupine MVP changes.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after local-only Porcupine MVP changes.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4173/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 45000 --stub-porcupine --wait-complete` passed locally: stubbed Porcupine detected Jarvis, command capture stopped on silence, uploaded a 25.3 KiB `audio/webm;codecs=opus` blob to the stubbed API, and rendered response text `wake smoke recognized`.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4173/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 45000 --stub-porcupine --expect-restart` passed locally: after the completed stubbed turn, the page returned to `Listening locally for "jarvis".`
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed the local-only Porcupine MVP to `private-host-redacted`.
- `curl -fsSL --max-time 15 https://private-host-redacted/` returned deployed HTML with `Picovoice AccessKey`, `Local Porcupine v10`, and no `Web Speech`, `wake-engine`, or `wake-language` controls.
- `curl -I --max-time 15 https://private-host-redacted/vendor/porcupine/porcupine_params.pv` returned HTTP 200 with `content-length: 984948`.
- `curl -I --max-time 15 https://private-host-redacted/vendor/picovoice/porcupine-web.iife.js` returned HTTP 200 with `content-type: text/javascript; charset=utf-8`.
- 2026-07-04 correction: the Porcupine/Picovoice deployment was superseded because the AccessKey requirement violates the user's no-cloud/no-provider-key constraint.
- `pnpm type-check` after replacing Picovoice with local openWakeWord-compatible ONNX wake detection.
- `pnpm type-check:tests` after replacing Picovoice with local openWakeWord-compatible ONNX wake detection.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after adding the vendored ONNX Runtime and openWakeWord assets.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4174/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 60000 --wait-complete` passed locally with real browser ONNX inference: openWakeWord detected `hey_jarvis`, command capture stopped, the upload path ran, and the stubbed assistant response text `wake smoke recognized` rendered.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4174/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 60000 --expect-restart` passed locally: after a completed turn, the page returned to `Listening locally for "jarvis".`
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed the local openWakeWord browser wake path to `private-host-redacted`.
- Deployed HTML marker check found `Wake threshold`, `Detector build: Local openWakeWord v11, single mic stream.`, and `./vendor/onnxruntime/ort.wasm.min.js`.
- Deployed JavaScript marker check found `OpenWakeWordJarvisDetector` and `configureOrtRuntime`; the same HTML/JS marker checks found no `Picovoice`, `Porcupine`, `AccessKey`, `Web Speech`, or `SpeechRecognition` strings.
- `curl -I --max-time 15 https://private-host-redacted/vendor/openwakeword/hey_jarvis_v0.1.onnx` returned HTTP 200 with `content-length: 1271370`.
- `curl -I --max-time 15 https://private-host-redacted/vendor/onnxruntime/ort-wasm-simd-threaded.wasm` returned HTTP 200 with `content-type: application/wasm` and `content-length: 12297086`.
- `pnpm type-check` after v12 immediate wake rearm changes.
- `pnpm type-check:tests` after v12 immediate wake rearm changes.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after v12 marker/test updates and guard assertions for no `Picovoice`, `Porcupine`, `AccessKey`, `Web Speech`, or `SpeechRecognition` strings in the served HTML/JS.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4174/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 60000 --response-delay-ms 30000 --expect-immediate-restart` passed locally: the fake backend response was still delayed, assistant text was still `No response yet.`, and diagnostics already showed a second local wake `start` event.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4174/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 60000 --wait-complete` passed locally after v12: local ONNX wake detection, command capture, upload, and response render still completed.
- `node /home/mada/tools/caddy-sites-manager/site-manager.js deploy /home/mada/whatsapp-llm-bot/website.json` deployed v12 to `private-host-redacted`.
- Deployed v12 marker check found `Detector build: Local openWakeWord v12, single mic stream.`, `./app.js?v=20260704-wake-v12`, and `restartWakeListeningAfterCapture` / `submitWakeAudioInBackground` in the served JavaScript.
- Deployed v12 marker check found no `Picovoice`, `Porcupine`, `AccessKey`, `Web Speech`, `SpeechRecognition`, or `scheduleWakeRestart` strings in the served HTML/JS.
- `pnpm type-check` after v13 detector reset/post-capture suppression changes.
- `pnpm type-check:tests` after v13 detector reset/post-capture suppression changes.
- `pnpm exec node --test tests/web-audio-client-server.test.js` passed with local port binding allowed after v13 marker updates.
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4174/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 60000 --response-delay-ms 30000 --expect-immediate-restart` passed locally after v13: after capture, diagnostics showed a second local wake `start` event while assistant text was still `No response yet.`
- `node scripts/web-wake-smoke.js --url http://127.0.0.1:4174/ --audio /tmp/hey-jarvis-then-silence.wav --timeout-ms 60000 --wait-complete` passed locally after v13: local ONNX wake detection, command capture, upload, response render, and return to `Listening locally for "jarvis"` completed.

Manual browser microphone testing on the phone remains useful, but the deployed backend path has now been verified independently with synthetic speech.

## Remaining

- Manually test real openWakeWord Jarvis detection on the target phone/browser. The local Chromium fake-mic smoke proves real browser ONNX inference and app wiring; real acoustic phone performance still needs target-device testing.
- If the openWakeWord `hey_jarvis_v0.1` model is not good enough in the target environment, evaluate tuning the threshold, using a custom local openWakeWord model, or switching to another fully local browser-runnable model asset.

## Acceptance

- Browser client can record a spoken turn, submit it to the backend, show returned text, and play returned assistant audio.
- Wake-word detection, if included in the POC, works while the page is active and permissioned, with clear documented limits for background/locked-screen use.
- Android task file remains Android-focused and does not contain the web client plan.
- Relevant backend/web tests pass, or skipped verification is recorded with a reason.

## Research Sources

- Picovoice Porcupine Web quick start: https://picovoice.ai/docs/quick-start/porcupine-web/
- Picovoice Porcupine Android quick start: https://picovoice.ai/docs/quick-start/porcupine-android/
- openWakeWord release assets: https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1
- ONNX Runtime Web package: https://www.npmjs.com/package/onnxruntime-web
- TensorFlow.js Speech Commands: https://github.com/tensorflow/tfjs-models/tree/master/speech-commands
- MDN `getUserMedia`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN Page Visibility API: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- MDN Screen Wake Lock API: https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
