# Web audio client

Browser frontend for the HTTP API audio transport. This client is separate from
the Android client and currently implements:

- active-page browser word detection through local openWakeWord-compatible ONNX
  inference;
- capture speech after the wake phrase and upload the recorded blob to
  `POST /api/transports/:transportId/audio-turns?wait=true`;
- show assistant text returned by the server;
- fetch and play the assistant audio response.

Word detection is local to the browser. The page keeps one app-owned microphone
stream open, down-samples PCM to 16 kHz, feeds 80 ms frames into vendored ONNX
Runtime Web plus vendored openWakeWord model assets, and detects the local
`hey_jarvis` model without a wake-provider account or AccessKey. After detection
it follows the same capture workflow as the Pi client: keep a local pre-roll
buffer, play a wake cue, capture speech, stop after speech has ended and the
configured silence window has elapsed, fall back to a no-speech timeout or
maximum utterance timeout, play an end cue, and submit the captured audio through
the backend audio-turn path. This is not a locked-screen or background wake-word
engine.

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
openWakeWord assets under `vendor/openwakeword/`.

## Backend

Configure the app UI with the HTTP API transport base URL, transport id, and
chat id. By default the deployed client uses its own origin as the API base URL,
including the page token query parameter, and the web server proxies `/api/*` to
the backend HTTP API transport. Backend speech synthesis must be configured for
the response to include assistant audio.

When using the deployed HTTPS page, use an API base URL that is reachable from
the browser device and served over HTTPS. Browsers may block requests from the
HTTPS page to a plain HTTP backend, except for local development cases such as
`localhost`.

## Deployment

Registered in the repo-root `website.json` as `web-audio-client` and deployed as
a private/tailnet plus token service:

```text
https://private-host-redacted/
```

The deployed client does not need a separate API subdomain. The same service
serves the browser app and proxies same-origin `/api/*` requests to the
configured HTTP API target.

Use `site-manager link web-audio-client` to get the external token URL.
