package com.madabot.voicepoc;

final class SherpaWakeWordDetector implements WakeWordDetector {
    @Override
    public void start(Listener listener) {
        listener.onWakeError(new IllegalStateException(
            "sherpa-onnx KWS assets are not vendored yet. Use the manual record path until the Pi/device setup is ready."
        ));
    }

    @Override
    public void stop() {
        // No-op until sherpa-onnx native assets are installed.
    }
}
