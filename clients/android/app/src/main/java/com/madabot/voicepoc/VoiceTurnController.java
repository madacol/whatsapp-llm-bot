package com.madabot.voicepoc;

import android.app.Activity;

import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class VoiceTurnController {
    interface Listener {
        void onStatus(String text);
        void onAssistantText(String text, boolean replace);
        void onTurnActive(boolean active);
        void onError(Exception error);
    }

    private static final String INPUT_MIME_TYPE = "audio/mp4";

    private final Activity activity;
    private final UtteranceRecorder recorder = new UtteranceRecorder();
    private final AudioTurnClient client = new AudioTurnClient();
    private final AssistantAudioPlayer player = new AssistantAudioPlayer();
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final Listener listener;
    private volatile String activeTurnRequestId = "";

    VoiceTurnController(Activity activity, Listener listener) {
        this.activity = activity;
        this.listener = listener;
    }

    boolean isRecording() {
        return recorder.isRecording();
    }

    boolean hasActiveTurn() {
        return !activeTurnRequestId.isEmpty();
    }

    void startRecording() {
        try {
            recorder.start(activity);
            listener.onStatus("Recording");
        } catch (Exception error) {
            listener.onError(error);
        }
    }

    void checkApi(AudioTurnClient.Config config) {
        listener.onStatus("Checking API health.");
        executor.execute(() -> {
            try {
                client.checkHealth(config);
                postStatus("API health check passed.");
            } catch (Exception error) {
                postError(error);
            }
        });
    }

    void cancelActiveTurn(AudioTurnClient.Config config) {
        String activeRequest = activeTurnRequestId;
        if (activeRequest.isEmpty()) {
            listener.onStatus("No active turn to cancel.");
            return;
        }
        listener.onStatus("Sending cancellation request.");
        executor.execute(() -> {
            try {
                client.submitCommandTurn(config, "!c", commandRequestId("cancel"));
                postStatus("Cancellation requested.");
            } catch (Exception error) {
                postError(error);
            }
        });
    }

    void clearHistory(AudioTurnClient.Config config) {
        listener.onStatus("Clearing conversation history.");
        executor.execute(() -> {
            try {
                client.submitCommandTurn(config, "/clear", commandRequestId("clear"));
                activity.runOnUiThread(() -> {
                    listener.onAssistantText("No response yet.", true);
                    listener.onStatus("Conversation history cleared.");
                });
            } catch (Exception error) {
                postError(error);
            }
        });
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
        listener.onAssistantText("Waiting for assistant...", true);
        String requestId = requestId("turn");
        setActiveTurnRequestId(requestId);
        executor.execute(() -> {
            TurnEventMonitor eventMonitor = new TurnEventMonitor(config);
            eventMonitor.start();
            try {
                AudioTurnClient.Result result = client.submitAudioTurn(config, capture, INPUT_MIME_TYPE, requestId);
                eventMonitor.flush();
                if (!eventMonitor.hasAssistantOutput()) {
                    renderFinalResult(config, result);
                } else {
                    postStatus(eventMonitor.hasAssistantAudio()
                        ? "Assistant response is ready."
                        : "Assistant returned text but no audio.");
                }
            } catch (Exception error) {
                postError(error);
            } finally {
                eventMonitor.stop();
                setActiveTurnRequestId("");
            }
        });
    }

    private void renderFinalResult(AudioTurnClient.Config config, AudioTurnClient.Result result) {
        activity.runOnUiThread(() -> {
            listener.onAssistantText(result.text.isEmpty() ? "Assistant returned no text." : result.text, true);
            listener.onStatus(result.audio == null ? "Assistant returned text but no audio." : "Assistant response is ready.");
        });
        if (result.audio != null) {
            queueAssistantAudio(config, result.audio);
        }
    }

    private void queueAssistantAudio(AudioTurnClient.Config config, AudioTurnClient.AudioBlock audio) {
        try {
            String audioUrl = client.resolveAudioUrl(config, audio);
            player.enqueue(activity, audioUrl, config.token, new AssistantAudioPlayer.Listener() {
                @Override
                public void onPlaybackStatus(String text) {
                    postStatus(text);
                }

                @Override
                public void onPlaybackError(Exception error) {
                    postError(error);
                }
            });
        } catch (Exception error) {
            postError(error);
        }
    }

    private void setActiveTurnRequestId(String requestId) {
        activeTurnRequestId = requestId;
        activity.runOnUiThread(() -> listener.onTurnActive(!requestId.isEmpty()));
    }

    private void postStatus(String text) {
        activity.runOnUiThread(() -> listener.onStatus(text));
    }

    private void postError(Exception error) {
        activity.runOnUiThread(() -> listener.onError(error));
    }

    private static String requestId(String label) {
        return "android-" + label + "-" + System.currentTimeMillis();
    }

    private static String commandRequestId(String label) {
        return requestId(label);
    }

    void shutdown() {
        player.shutdown();
        executor.shutdownNow();
    }

    private final class TurnEventMonitor {
        private final AudioTurnClient.Config config;
        private volatile boolean stopped;
        private volatile String after;
        private volatile boolean assistantOutput;
        private volatile boolean assistantAudio;

        TurnEventMonitor(AudioTurnClient.Config config) {
            this.config = config;
        }

        void start() {
            try {
                after = client.readCurrentEventCursor(config);
            } catch (Exception error) {
                after = null;
                postStatus("Event polling unavailable: " + error.getMessage());
                return;
            }
            executor.execute(() -> {
                try {
                    while (!stopped && after != null) {
                        pollOnce();
                        Thread.sleep(700);
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                } catch (Exception error) {
                    postStatus("Event polling stopped: " + error.getMessage());
                }
            });
        }

        void flush() {
            if (after == null) {
                return;
            }
            try {
                pollOnce();
            } catch (Exception error) {
                postStatus("Event catch-up failed: " + error.getMessage());
            }
        }

        void stop() {
            stopped = true;
        }

        boolean hasAssistantOutput() {
            return assistantOutput || assistantAudio;
        }

        boolean hasAssistantAudio() {
            return assistantAudio;
        }

        private synchronized void pollOnce() throws Exception {
            String cursor = after;
            if (cursor == null) {
                return;
            }
            List<AudioTurnClient.EventRow> rows = client.readEventsAfter(config, cursor);
            for (AudioTurnClient.EventRow row : rows) {
                if (!row.eventId.isEmpty()) {
                    after = row.eventId;
                }
                handleRow(row);
            }
        }

        private void handleRow(AudioTurnClient.EventRow row) {
            AudioTurnClient.AssistantEvent event = client.parseAssistantEvent(row);
            if (!event.text.isEmpty()) {
                assistantOutput = true;
                activity.runOnUiThread(() -> {
                    listener.onAssistantText(event.text, false);
                    listener.onStatus("Assistant message received.");
                });
            }
            for (AudioTurnClient.AudioBlock audio : event.audioBlocks) {
                assistantAudio = true;
                queueAssistantAudio(config, audio);
            }
        }
    }
}
