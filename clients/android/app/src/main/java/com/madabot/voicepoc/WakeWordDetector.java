package com.madabot.voicepoc;

interface WakeWordDetector {
    interface Listener {
        void onWakeWord(String keyword);
        void onWakeStatus(String text);
        void onWakeError(Exception error);
    }

    void start(String wakePhrase, double threshold, Listener listener);
    void stop();
}
