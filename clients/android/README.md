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
- wake phrase detection through Android's platform speech recognizer fallback,
  with a seam for a future offline KWS implementation.

The backend owns STT/media-to-text, the assistant run, provider-backed TTS, and
media download authorization.

## Disk note

Do not install Android SDK components on the current host while free space is
below 4 GB. Prefer the Pi-attached Android device for build/install/logcat once
it is available.

## Build status

This source scaffold intentionally does not include a Gradle wrapper binary or
downloaded Android SDK/model assets. Build it after SDK setup:

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

- API base URL, for example `http://192.168.1.20:3200`;
- API bearer token;
- transport id, usually `voice`;
- chat id, for example `api:android-1`.
- sender id and sender name.

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

The current APK uses Android's built-in `SpeechRecognizer` as a dependency-free
wake phrase fallback. It listens for the configured wake phrase, starts audio
recording when the phrase appears in partial or final recognition results, and
auto-sends after the configured max capture seconds.

This is a practical POC fallback, not the final offline KWS path. Accuracy,
privacy, offline availability, and battery behavior depend on the recognizer
service installed on the device. The `silence seconds` field is persisted for
future VAD endpointing but is not used by this fallback.

Use `sherpa-onnx` keyword spotting for the intended offline Android wake-word
implementation. The upstream Android tree includes `SherpaOnnxKws`, an Android
keyword spotting demo, Java/Kotlin APIs, assets, and native libraries. This repo
does not vendor those large assets yet because local disk is constrained.
