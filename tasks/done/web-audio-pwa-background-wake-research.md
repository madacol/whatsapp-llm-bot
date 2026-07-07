# Research PWA Background Wake Detection

## Status

Done.

## Subject

Research whether converting the web audio client into a PWA can keep microphone capture and wake-word detection running while the phone screen is off or locked.

## Conclusion

Do not treat a PWA as a reliable way to keep the current browser wake-word detector running with the phone screen off or locked.

A PWA can still help with installability, cached assets, permissions persistence, and a foreground "keep screen on while listening" mode. It does not give the web app a native Android foreground service or a dependable always-listening microphone runtime. For reliable locked-screen wake detection, use a native Android app or wrapper with a microphone foreground service, visible notification, battery-optimization handling, and a native audio pipeline.

## Findings

- `getUserMedia()` is a secure-context, document/window API that requires user permission. It is not a background service primitive.
- The Media Capture spec exposes `MediaDevices` to `Window`, not service workers.
- Service workers are event-driven worker contexts with no DOM access. They can cache, intercept fetches, and handle events, but they cannot own microphone capture or continuously run wake-word inference.
- Chrome's page lifecycle allows hidden pages to be frozen or discarded. On mobile, the hidden transition is often the last reliably observable state; frozen pages suspend freezable tasks and discarded pages run no JavaScript.
- AudioWorklet can run low-latency processing on a Web Audio thread, but it is still attached to an `AudioContext`. `AudioContext.state` can become `suspended` or `interrupted`, which pauses the audio graph from the app's perspective.
- Chrome throttles timers in hidden pages, especially after a page is hidden for several minutes, silent, and not using WebRTC. WebRTC or active audio can improve some throttling behavior, but that is not a locked-screen wake-word guarantee.
- Screen Wake Lock is useful only for keeping the screen from dimming or locking while the document is active and visible. It can be rejected or released for system policy, low battery, or inactive/invisible documents.
- Media Session is for media metadata, lock-screen controls, and media notifications. It is not a general-purpose foreground-service API for continuous microphone capture.
- Android's native platform model explicitly uses the `microphone` foreground service type to continue microphone capture from the background, with `RECORD_AUDIO` and foreground-service permissions. A Chrome-installed PWA cannot declare that native service type for this app.
- iOS/Safari should be treated as at least as restrictive. Do not expect a home-screen web app to provide locked-screen continuous microphone wake-word detection.

## Source Notes

- MDN `getUserMedia()`: secure-context, permissioned microphone capture from a document context. https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- W3C Media Capture and Streams: `MediaDevices` and related media stream interfaces are `Exposed=Window`. https://w3c.github.io/mediacapture-main/#mediadevices
- Chrome Page Lifecycle API: hidden pages can move to frozen, discarded, or terminated states; frozen pages suspend freezable tasks. https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- Chrome timer throttling: hidden, silent pages can enter intensive timer throttling; WebRTC changes throttling conditions but does not provide an always-running guarantee. https://developer.chrome.com/blog/timer-throttling-in-chrome-88/
- MDN AudioWorklet: worklets run on a Web Audio thread and are accessed through an audio context. https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- MDN `BaseAudioContext.state`: audio contexts can be running, suspended, interrupted, or closed. https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state
- MDN Screen Wake Lock API: only active visible documents can acquire screen wake locks, and locks can be released or rejected. https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
- MDN Service Worker API: service workers are event-driven worker contexts with no DOM access. https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- Chrome Media Session: media session affects media notifications/controls, and Web Audio does not request Android audio focus unless bridged through an audio element. https://developer.chrome.com/blog/media-session/
- Android foreground service types: the native `microphone` foreground service type is the documented way to continue microphone capture from the background. https://developer.android.com/develop/background-work/services/fgs/service-types

## Target-Phone Experiment Plan

Build a tiny diagnostic PWA/page that logs:

- `visibilitychange`, `freeze`, `resume`, and `pagehide`;
- `AudioContext.state` changes;
- `MediaStreamTrack.readyState` and `muted`;
- AudioWorklet or audio callback frame counters;
- wake-word inference timestamps;
- timer drift.

Run it on the actual target phone in these states:

- Chrome tab foreground, screen on;
- installed PWA foreground, screen on;
- installed PWA with Screen Wake Lock active;
- screen manually turned off;
- phone locked for 5, 15, 30, and 60 minutes;
- Battery Saver on and off;
- OEM battery optimization default and unrestricted.

During the test, speak the wake phrase every two minutes from another device and record whether inference fires immediately, late, or never. Also check whether the OS microphone indicator remains active. If available, collect `adb shell dumpsys audio`, `adb shell dumpsys media.audio_flinger`, and Chrome remote debugging logs.

The PWA path fails the always-listening requirement if any target phone stops audio callbacks, suspends or interrupts the `AudioContext`, mutes or ends the track, delays inference materially, or misses wake phrases while locked.

## Verification

Research-only task. Primary browser/platform docs were checked on 2026-07-07. No code verification was run.
