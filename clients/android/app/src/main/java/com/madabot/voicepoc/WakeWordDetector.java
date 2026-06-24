package com.madabot.voicepoc;

interface WakeWordDetector {
    interface Listener {
        void onWakeWord(String keyword);
        void onWakeError(Exception error);
    }

    void start(Listener listener);
    void stop();
}
