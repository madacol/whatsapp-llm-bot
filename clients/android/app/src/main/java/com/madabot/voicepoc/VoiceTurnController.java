package com.madabot.voicepoc;

import android.app.Activity;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class VoiceTurnController {
    interface Listener {
        void onStatus(String text);
        void onError(Exception error);
    }

    private static final String INPUT_MIME_TYPE = "audio/mp4";

    private final Activity activity;
    private final UtteranceRecorder recorder = new UtteranceRecorder();
    private final AudioTurnClient client = new AudioTurnClient();
    private final AssistantAudioPlayer player = new AssistantAudioPlayer();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Listener listener;

    VoiceTurnController(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    boolean isRecording() {
        return recorder.isRecording();
    }

    void startRecording() {
        try {
            recorder.start(activity);
            listener.onStatus("Recording");
        } catch (Exception error) {
            listener.onError(error);
        }
    }

    void stopAndSend(AudioTurnClient.Config config) {
        File capture;
        try {
            capture = recorder.stop();
        } catch (Exception error) {
            listener.onError(error);
            return;
        }
        if (capture == null || !capture.exists() || capture.length() == 0) {
            listener.onStatus("No audio captured");
            return;
        }
        listener.onStatus("Uploading " + capture.length() + " bytes");
        executor.execute(() -> {
            try {
                AudioTurnClient.Result result = client.submitAudioTurn(config, capture, INPUT_MIME_TYPE);
                activity.runOnUiThread(() -> {
                    listener.onStatus(result.text.isEmpty() ? "Playing response" : result.text);
                    try {
                        player.play(activity, result.audioUrl, config.token);
                    } catch (Exception error) {
                        listener.onError(error);
                    }
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> listener.onError(error));
            }
        });
    }

    void shutdown() {
        player.stop();
        executor.shutdownNow();
    }
}
