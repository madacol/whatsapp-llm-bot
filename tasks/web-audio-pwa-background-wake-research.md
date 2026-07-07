# Research PWA Background Wake Detection

## Status

Todo, research only.

## Subject

Research whether converting the web audio client into a PWA can keep microphone capture and wake-word detection running while the phone screen is off or locked.

## Evidence

The user said the current wake-word detection requires the screen to stay on. They want to know whether a PWA can keep the microphone open and keep the openWakeWord/Web Audio detection logic running while the screen is off.

## Questions To Answer

- On Android Chrome or an installed Android PWA, can microphone capture continue when the screen is off or locked?
- Are Web Audio, AudioWorklet, timers, WASM inference, or media streams throttled or suspended in that state?
- Can the Wake Lock API, Media Session API, service workers, or installed PWA mode change the answer?
- Do service workers have any legal way to access microphone input?
- Are there OS power-management constraints that make a native Android foreground service or wrapper necessary?
- If iOS/Safari matters later, what are its installed web app limitations?
- What experiment should be run on the target phone to prove the answer?

## Non-Goals

- Do not convert the client into a PWA yet.
- Do not implement a native Android wrapper yet.

## Acceptance Criteria

- Research cites current primary browser/platform sources where possible.
- The result gives a practical recommendation: viable as PWA, not viable as PWA, or only viable with a native wrapper/foreground service.
- The result includes a concrete target-phone test plan.
