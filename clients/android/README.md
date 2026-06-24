# Android voice POC

Thin Android client for the HTTP API audio transport.

The POC app owns only device-local work:

- microphone permission;
- utterance recording;
- audio upload to `POST /api/transports/:transportId/audio-turns?wait=true`;
- assistant audio download and playback;
- wake-word detection seam for the Android KWS implementation.

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

## Runtime configuration

The app UI asks for:

- API base URL, for example `http://192.168.1.20:3200`;
- API bearer token;
- transport id, usually `voice`;
- chat id, for example `api:android-1`.

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

Use `sherpa-onnx` keyword spotting for the Android wake-word implementation.
The upstream Android tree includes `SherpaOnnxKws`, an Android keyword spotting
demo, Java/Kotlin APIs, assets, and native libraries. This repo does not vendor
those large assets yet because local disk is constrained. The current app keeps
the wake-word boundary explicit so the sherpa detector can start capture through
the same `VoiceTurnController` used by the manual POC path.
