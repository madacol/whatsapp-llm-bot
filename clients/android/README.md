# Android voice POC

Thin Android client for the HTTP API audio transport.

The POC app owns only device-local work:

- microphone permission;
- utterance recording;
- audio upload to `POST /api/transports/:transportId/audio-turns?wait=true`;
- sender/chat/transport runtime configuration;
- API health checks;
- turn cancellation through the same `!c` command used by the web client;
- conversation clearing through the same `/clear` command used by the web client;
- polling transport events while an audio turn is running so intermediate
  assistant messages and audio can be shown/played before the final HTTP
  response completes;
- assistant audio download and playback;
- continuous local wake detection through the same openWakeWord Jarvis ONNX
  model family used by the web client.

The backend owns STT/media-to-text, the assistant run, provider-backed TTS, and
media download authorization.

## Disk note

Do not install Android SDK components on the current host while free space is
below 4 GB. Prefer the Pi-attached Android device for build/install/logcat once
it is available.

## Build status

This source scaffold intentionally does not include a Gradle wrapper binary or
downloaded Android SDK assets. The debug build reuses the vendored
openWakeWord ONNX models from `clients/web/vendor/openwakeword/` and packages
only `arm64-v8a` native ONNX Runtime libraries for a modern physical phone.
Build it after SDK setup:

```bash
cd clients/android
gradle assembleDebug
```

or generate a wrapper from an approved Gradle install:

```bash
gradle wrapper --gradle-version 8.10.2
./gradlew assembleDebug
```

On the constrained local host, the debug APK has also been built successfully
with the temporary minimal toolchain:

```bash
ANDROID_HOME=/tmp/android-sdk-min \
GRADLE_USER_HOME=/tmp/android-lite/gradle-user-home \
/tmp/android-lite/gradle-8.10.2/bin/gradle --no-daemon --max-workers=1 assembleDebug
```

## Runtime configuration

The app UI asks for:

- API base URL;
- API bearer token;
- transport id, usually `voice`;
- chat id, for example `api:android-1`.
- sender id and sender name.

For private deployment builds, set `ANDROID_API_BASE_URL` in the repo `.env`
or pass `-PandroidApiBaseUrl=...` when building. `.env` is ignored and must
remain the place for the real deployment URL; do not commit private hostnames.
If no build-time URL is configured, the app falls back to `http://127.0.0.1:3200`.

If the API base URL contains query parameters, such as a tokenized media URL,
the Android client preserves them when resolving assistant audio media URLs.

Android cleartext HTTP is enabled for this POC so a LAN-hosted backend can be
used without TLS. Do not expose the API transport publicly without TLS and a
strong token.

For Android playback, configure backend TTS to return a playable container:

```bash
TTS_PROVIDER=openai
TTS_ROUTE=speech
TTS_MODEL=gpt-4o-mini-tts
TTS_VOICE=marin
TTS_RESPONSE_FORMAT=mp3
```

Raw PCM is useful on the Pi, but Android `MediaPlayer` should receive MP3, M4A,
or another supported container.

## Wake word

The APK uses continuous `AudioRecord` capture with Microsoft ONNX Runtime
Android and the existing openWakeWord Jarvis models:

- `melspectrogram.onnx`
- `embedding_model.onnx`
- `hey_jarvis_v0.1.onnx`

The wake phrase field currently supports Jarvis only. Detection starts the
existing recording path and auto-sends after the configured max capture seconds.
The `silence seconds` field is persisted for future VAD endpointing but is not
used yet.
