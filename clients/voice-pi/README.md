# Pi voice client

This directory contains the Raspberry Pi voice frontend for the HTTP API transport.
It is a client of `http-api-transport.js`, not a server-side transport by itself.

The Pi runtime owns hardware-local work:

- wake word detection;
- cue playback;
- microphone capture;
- local endpointing/silence detection;
- final audio playback through ALSA/BlueALSA.

The current imported implementation is transitional: it still performs STT and TTS
from the Pi process while sending turns to the HTTP API transport. The intended
next step is to move STT and TTS into `whatsapp-llm-bot` so this client only
uploads captured audio and plays audio returned by the server.

## Current entry point

```bash
./capture_ask.sh
```

Copy `.env.example` to `.env` on the Pi and configure the HTTP API transport
settings before running the client. Do not commit `.env`.
