# Web audio client

Browser frontend for the HTTP API audio transport. This client is separate from
the Android client and currently implements:

- record microphone audio in the browser;
- upload the recorded blob to `POST /api/transports/:transportId/audio-turns?wait=true`;
- show assistant text returned by the server;
- fetch and play the assistant audio response.
- active-page browser word detection through local openWakeWord-compatible ONNX
  inference.

Word detection is local to the browser. The page keeps one app-owned microphone
stream open, down-samples PCM to 16 kHz, feeds 80 ms frames into vendored ONNX
Runtime Web plus vendored openWakeWord model assets, and detects the local
`hey_jarvis` model without a wake-provider account or AccessKey. After detection
it follows the same capture workflow as the Pi client: keep a local pre-roll
buffer, play a wake cue, capture speech, stop after speech has ended and the
configured silence window has elapsed, fall back to a no-speech timeout or
maximum utterance timeout, play an end cue, and submit the captured audio through
the same backend path as manual capture. This is not a locked-screen or
background wake-word engine.

## Run

From the repo root:

```bash
pnpm web:audio
```

The default URL is `http://127.0.0.1:4173`.

Use `--host` and `--port` to override:

```bash
pnpm web:audio -- --host 0.0.0.0 --port 4173
```

Microphone access requires a secure browser context. `localhost` and
`127.0.0.1` are treated as secure by modern browsers. For phone-on-LAN testing,
serve the page over HTTPS or use another trusted secure-origin setup.

Browser word detection additionally requires WebAssembly, Web Audio, and the
vendored ONNX Runtime Web assets under `vendor/onnxruntime/` plus the vendored
openWakeWord assets under `vendor/openwakeword/`. Browsers that cannot run that
local inference path can still use manual recording.

## Backend

Configure the app UI with the HTTP API transport base URL, transport id, and
chat id. The bearer token field is optional; leave it blank for the current
tailnet test API. Backend speech synthesis must be configured for the response
to include assistant audio.

When using the deployed HTTPS page, use an API base URL that is reachable from
the browser device and served over HTTPS. Browsers may block requests from the
HTTPS page to a plain HTTP backend, except for local development cases such as
`localhost`.

## Deployment

Registered in the repo-root `website.json` as `web-audio-client` and deployed as
a private/tailnet static site:

```text
https://private-host-redacted/
```

The deployed client can take the API base URL from the page URL:

```text
https://private-host-redacted/?api=https%3A%2F%private-host-redacted
```

The API proxy is registered as `web-audio-api` and points at the configured HTTP
API transport listener.
