# Android Audio Client

## Subject

Turn the existing HTTP API transport voice client direction into an Android client that sends captured audio to `whatsapp-llm-bot` and receives assistant audio back, rather than doing client-side STT/TTS and exchanging text through the API.

## Current Evidence

- User request on 2026-06-24: "I want to turn that client into an Android app, and instead of sending text back and forth through API layer, I want to send audio back and forth".
- Follow-up clarification on 2026-06-24: replicate the current voice assistant functionality in an Android app, with the change that Android transmits audio directly to the API so the client stays as thin as possible.
- Follow-up clarification on 2026-06-24: also implement word detection, interpreted as wake-word / wake-phrase detection matching the existing Pi voice assistant flow.
- Follow-up clarification on 2026-06-24: openWakeWord was chosen for a Pi Zero constraint and was not reliable enough; prefer a better-quality open-source alternative for Android if available.
- Follow-up on 2026-07-01: Android target can assume medium/high-end Android hardware; low-end-phone constraints are not required.
- Follow-up on 2026-07-09: the Android app must not commit the real API deployment URL; use private build-time configuration, and remove private deployment hostnames from tracked code/docs.
- Follow-up on 2026-07-09: Android wake detection should work like the current web client's ONNX openWakeWord flow, not the restart-based Android speech recognizer behavior that repeatedly starts/stops the microphone session.
- Follow-up on 2026-07-10: purge concrete `100.x.x.x` API addresses from Git history, keep the real Android API domain in ignored `.env`, and do not publish the private deployment domain in tracked source or history.
- Follow-up on 2026-07-10: `WEB_AUDIO_API_TARGET` is a functional server environment variable, but `website.json` service environment entries are literal systemd values in the deploy tool, not `.env` interpolation. Tracked `website.json` must therefore not contain a fake or private API target.
- `clients/voice-pi/openwakeword_always_on.py` and `clients/voice-pi/capture_after_wake.py` currently use openWakeWord for `hey_jarvis` detection, then VAD endpointing to capture the user's turn.
- `sherpa-onnx` is the preferred POC wake-word candidate: it is Apache-2.0, supports Android and Kotlin/Java APIs, includes keyword spotting, has an Android keyword spotting app, and supports custom keyword files.
- `clients/voice-pi/README.md` says the Pi client is a frontend for `http-api-transport.js`, and the intended next step is moving STT/TTS into `whatsapp-llm-bot` while clients keep wake/capture/upload/playback.
- `clients/voice-pi/api_transport_client.py` currently posts text payloads and extracts assistant text from event streams.
- `http-api-transport.js` currently accepts only one text content block through `POST /api/transports/:transportId/turns`.
- Shared types already include `AudioContentBlock`, and media-to-text support already knows how to transcribe audio blocks when configured.

## Ambiguity

- Audio exchange mode is not yet confirmed: complete clip upload/download, streaming input/output, or hybrid upload with streamed events.
- Preferred audio formats, max duration, authentication, and LAN/public deployment shape are not yet confirmed.
- Exact wake phrase and threshold tuning are not yet confirmed.

## Proposed Direction

- Keep `http-api-transport.js` as the backend transport seam.
- Add an audio turn contract that accepts `AudioContentBlock` payloads using existing media block shapes.
- Store uploaded audio in `.media/` through `media-store.js` instead of keeping large base64 blobs in long-lived ledgers/events.
- Let existing media-to-text enrichment produce the transcript before the main run.
- Add a response audio surface after assistant text is finalized, so Android receives an audio media block or download URL to play.
- Use the same provider-backed TTS direction already implemented in `clients/voice-pi/tts_openrouter.py`: default OpenAI speech with OpenRouter-compatible alternatives via env configuration, not local OS TTS.
- Build a native Android POC under `clients/android/` that owns wake phrase detection, recording, upload, and playback.
- Use `sherpa-onnx` keyword spotting on Android for wake detection rather than Android cloud speech recognition or openWakeWord.
- On the assumed medium/high-end phone target, benchmark the sherpa-onnx detector with a realistic wake phrase and threshold before considering proprietary alternatives such as Picovoice Porcupine Android.

## Current Status

Active. First implementation slice is a complete-clip POC: Android records a full utterance, uploads the audio to the API, the backend runs the assistant flow and provider-backed TTS, and Android downloads/plays the returned audio.

The previous local disk-space blocker is resolved enough for debug builds: on 2026-07-09 the project built successfully with a temporary minimal command-line toolchain under `/tmp`, using about 1.4 GB for Gradle, Gradle cache, Android command-line tools, SDK platform/build-tools, and build outputs.

No Android device is currently visible through `adb devices`, so install/logcat validation is still blocked on connecting or exposing a physical device. If the backend is running remotely, the Android device needs network reachability to the configured bot API.

The Android app should track improvements made to the web audio client where the improvement is backend-facing or client-workflow-facing. The current wake detector ports the web client's ONNX openWakeWord Jarvis path into Android using continuous `AudioRecord` capture and Microsoft ONNX Runtime Android.

Current operational state on 2026-07-10:

- Android source and web manifest cleanup commit has been rewritten locally to `dd81786` after removing concrete `100.x.x.x` addresses and synthetic private placeholders from reachable history.
- The real Android API URL is intentionally sourced from ignored `.env` / build-time environment through `ANDROID_API_BASE_URL`; tracked source must not reveal it.
- `website.json` no longer declares `WEB_AUDIO_API_TARGET`. The web server still supports `process.env.WEB_AUDIO_API_TARGET`; the real value must be supplied through private runtime/deployment configuration, not committed JSON.
- Final local cleanup after the second rewrite deleted `refs/original`, expired reflogs, ran GC, and verified no concrete `100.x.x.x` addresses or synthetic private placeholders remain in current files, reachable commit trees, diff history, or raw objects.
- Rewritten `master` was force-pushed after the second rewrite, then the unrelated in-progress ACP compact-command work was restored from the temporary stash and the stash ref was removed.
- Current working tree intentionally contains unrelated ACP compact-command changes restored from before the history rewrite. Do not revert them while finishing Android/APK work.
- The debug APK was clean-rebuilt from the ignored `.env` domain URL after discovering the inherited shell `ANDROID_API_BASE_URL` still pointed at an old development IP and was overriding `.env`. The final build passed the checks below and is ready to hand off.

## Progress

- Added backend raw audio turn API: `POST /api/transports/:transportId/audio-turns?wait=true` accepts `audio/*` request bodies with `x-request-id`, `x-chat-id`, sender headers, stores uploaded audio in `.media/`, and runs the normal turn handler with an `AudioContentBlock`.
- Added authenticated media download API: `GET /api/media/:mediaPath`.
- Added provider-backed HTTP API speech synthesis using the same OpenAI/OpenRouter direction as `clients/voice-pi/tts_openrouter.py`.
- Added a small Android source scaffold under `clients/android/` with manual record/send/playback against the audio-turn API.
- Added an explicit Android wake-word seam.
- Replaced the platform speech recognizer fallback with continuous local openWakeWord detection:
  - reuses the existing vendored web openWakeWord ONNX model files at build time;
  - packages Microsoft ONNX Runtime Android for `arm64-v8a`;
  - reads 16 kHz mono PCM continuously through `AudioRecord`;
  - supports the bundled Jarvis model and reports unsupported custom wake phrases honestly;
  - starts the existing recording path after detection;
  - auto-sends after the configured max capture seconds;
  - leaves silence-based endpointing for future VAD work.
- Added private Android API URL build configuration:
  - `ANDROID_API_BASE_URL` from environment or ignored repo `.env`;
  - `-PandroidApiBaseUrl=...` override;
  - fallback to localhost when no private build-time URL is configured;
  - migration away from previous local development defaults without committing the real deployment URL.
- Redacted private deployment hostnames from tracked current-tree code/docs/evidence.
- Updated Android stored-URL migration so old development API URLs are replaced by the build-configured API URL, including previous Tailscale/CGNAT-style development addresses on the API port.
- Removed tracked `WEB_AUDIO_API_TARGET` from `website.json`; the web server environment variable remains supported, but the deployment target must be configured privately at runtime.
- Rewrote Git history once to purge concrete `100.x.x.x` addresses and a second time to remove synthetic private placeholders from historical `website.json` values.
- Ported current web audio-client parity into Android:
  - configurable sender id and sender name;
  - API health check;
  - turn cancellation through `!c`;
  - conversation clearing through `/clear`;
  - intermediate assistant text while an audio turn is still running;
  - queued assistant audio playback from transport events before the final HTTP response completes;
  - token/query preservation when resolving assistant media URLs.
- Built `clients/android/app/build/outputs/apk/debug/app-debug.apk` successfully using a minimal temporary toolchain:
  - Android command-line tools: `/tmp/android-sdk-min/cmdline-tools/latest`
  - SDK packages: `platform-tools` 37.0.0, `platforms;android-35`, `build-tools;35.0.0`, plus AGP-installed `build-tools;34.0.0`
  - Gradle: `/tmp/android-lite/gradle-8.10.2`
  - Gradle user home: `/tmp/android-lite/gradle-user-home`
  - Measured footprint after web-parity build: `/tmp/android-lite` 780 MB, `/tmp/android-sdk-min` 627 MB, `clients/android/app/build` 1.5 MB.
- Rebuilt the debug APK after ONNX integration; final APK is arm64-only and about 30 MB.
- Current local build footprint after ONNX integration: `/tmp/android-lite` 936 MB, `/tmp/android-sdk-min` 627 MB, `clients/android/app/build` 260 MB.

## Verification

- `pnpm type-check`
- `pnpm exec node --test tests/http-api-transport.test.js`
- `pnpm test:fast` passed 911 tests.
- `ANDROID_HOME=/tmp/android-sdk-min GRADLE_USER_HOME=/tmp/android-lite/gradle-user-home /tmp/android-lite/gradle-8.10.2/bin/gradle --no-daemon --max-workers=1 assembleDebug`
- `/tmp/android-sdk-min/build-tools/35.0.0/apksigner verify --verbose clients/android/app/build/outputs/apk/debug/app-debug.apk`
- `/tmp/android-sdk-min/build-tools/35.0.0/aapt dump badging clients/android/app/build/outputs/apk/debug/app-debug.apk`
- `git diff --check`
- `/tmp/android-sdk-min/platform-tools/adb devices` starts successfully with elevated local daemon permission, but no device is attached.
- A current-tree search over tracked source/docs returned no concrete `100.x.x.x` API addresses after redaction.
- Before the second rewrite, reachable-history and raw-object scans returned no concrete `100.x.x.x` addresses. Synthetic private placeholders remained only in rewritten historical `website.json`, which triggered the second rewrite.
- After the second rewrite and GC, these checks returned no matches:
  - current-tree `rg` for concrete `100.x.x.x` addresses and synthetic private placeholders;
  - `git log --all -G` for the same patterns;
  - exhaustive `git rev-list --all` plus `git grep` over each reachable commit tree;
  - raw object scan with `git cat-file --batch-all-objects --batch | rg -a`.
- Clean-rebuilt the debug APK with the ignored `.env` domain forced through `-PandroidApiBaseUrl=...` so the stale process-level `ANDROID_API_BASE_URL` could not override it.
- Verified without printing the private URL:
  - generated Android `BuildConfig.DEFAULT_API_BASE_URL` matches `.env`;
  - `.env` API URL is an HTTPS domain, not an IP URL;
  - APK DEX strings contain the `.env` URL;
  - APK DEX strings contain no concrete `100.x.x.x` address and no synthetic private placeholders.
- APK verification:
  - `apksigner verify --verbose clients/android/app/build/outputs/apk/debug/app-debug.apk` passed with APK Signature Scheme v2;
  - `aapt dump badging` reports `com.madabot.voicepoc`, `versionCode=2`, `versionName=0.1.1`, `minSdk=26`, `targetSdk=35`;
  - APK size is 30 MB;
  - current local build footprint is `/tmp/android-lite` 936 MB, `/tmp/android-sdk-min` 627 MB, and `clients/android/app/build` 260 MB.
- `unzip -l clients/android/app/build/outputs/apk/debug/app-debug.apk | rg "onnx|libonnx|melspec|embedding|jarvis"` confirms the APK contains only arm64 ONNX Runtime native libraries and the three openWakeWord model assets.

## Remaining

- Validate the openWakeWord wake detector on a physical Android device.
- Build/install the APK on a physical Android device and verify microphone permission, audio upload, assistant audio playback, and wake-word behavior with `adb logcat`.

## Acceptance

- Android client can record a spoken user turn, submit it to the backend, and play assistant audio.
- Backend contract is covered by tests from HTTP submit through turn execution and response audio availability.
- Existing text-turn HTTP behavior remains supported unless explicitly removed.
- `pnpm type-check` and the relevant HTTP/media tests pass.
