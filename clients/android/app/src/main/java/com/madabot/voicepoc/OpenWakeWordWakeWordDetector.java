package com.madabot.voicepoc;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;

import java.util.Locale;

final class OpenWakeWordWakeWordDetector implements WakeWordDetector {
    private final Activity activity;
    private final Object lock = new Object();

    private AudioRecord recorder;
    private Thread worker;
    private int activeRunId;
    private boolean active;

    OpenWakeWordWakeWordDetector(Activity activity) {
        this.activity = activity;
    }

    @Override
    public void start(String wakePhrase, double threshold, Listener listener) {
        stop();
        String normalized = normalizeWakeText(wakePhrase);
        if (normalized.isEmpty()) {
            listener.onWakeError(new IllegalArgumentException("Enter a wake phrase."));
            return;
        }
        if (!normalized.contains("jarvis")) {
            listener.onWakeError(new IllegalArgumentException("The bundled Android wake model currently supports only Jarvis."));
            return;
        }
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            listener.onWakeError(new IllegalStateException("Microphone permission is required for wake detection."));
            return;
        }

        int runId;
        synchronized (lock) {
            activeRunId += 1;
            runId = activeRunId;
            active = true;
            worker = new Thread(() -> runWakeLoop(runId, wakePhrase.trim(), threshold, listener), "openwakeword-wake-detector");
            worker.start();
        }
    }

    @Override
    public void stop() {
        AudioRecord currentRecorder;
        Thread currentWorker;
        synchronized (lock) {
            activeRunId += 1;
            active = false;
            currentRecorder = recorder;
            recorder = null;
            currentWorker = worker;
            worker = null;
        }
        if (currentWorker != null) {
            currentWorker.interrupt();
        }
        releaseAudioRecord(currentRecorder);
    }

    @SuppressLint("MissingPermission")
    private void runWakeLoop(int runId, String displayWakePhrase, double threshold, Listener listener) {
        OpenWakeWordModel model = null;
        AudioRecord localRecorder = null;
        try {
            listener.onWakeStatus("Loading local wake model.");
            model = OpenWakeWordModel.create(activity.getApplicationContext(), threshold);
            int minimumBufferBytes = AudioRecord.getMinBufferSize(
                OpenWakeWordModel.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            );
            if (minimumBufferBytes == AudioRecord.ERROR || minimumBufferBytes == AudioRecord.ERROR_BAD_VALUE) {
                throw new IllegalStateException("Android could not create a 16 kHz mono microphone buffer.");
            }

            int bufferBytes = Math.max(minimumBufferBytes, OpenWakeWordModel.FRAME_SAMPLES * 2 * 4);
            localRecorder = new AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                OpenWakeWordModel.SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferBytes
            );
            if (localRecorder.getState() != AudioRecord.STATE_INITIALIZED) {
                throw new IllegalStateException("Android microphone recording could not be initialized.");
            }
            if (!setRecorderIfActive(runId, localRecorder)) {
                return;
            }

            localRecorder.startRecording();
            listener.onWakeStatus("Listening locally for \"" + displayWakePhrase + "\".");
            short[] audioBuffer = new short[OpenWakeWordModel.FRAME_SAMPLES];
            while (isActive(runId) && !Thread.currentThread().isInterrupted()) {
                int read = localRecorder.read(audioBuffer, 0, audioBuffer.length, AudioRecord.READ_BLOCKING);
                if (read > 0) {
                    OpenWakeWordModel.Prediction prediction = model.process(audioBuffer, read);
                    if (prediction.detected && finishRun(runId)) {
                        listener.onWakeStatus(String.format(Locale.US, "Wake phrase detected (%.2f).", prediction.score));
                        listener.onWakeWord(displayWakePhrase);
                        return;
                    }
                    continue;
                }
                if (read == AudioRecord.ERROR_DEAD_OBJECT) {
                    throw new IllegalStateException("Android microphone recorder died while wake detection was active.");
                }
                if (read == AudioRecord.ERROR_INVALID_OPERATION) {
                    throw new IllegalStateException("Android microphone recorder is not recording.");
                }
                if (read == AudioRecord.ERROR_BAD_VALUE) {
                    throw new IllegalStateException("Android microphone recorder returned an invalid read.");
                }
            }
        } catch (Exception error) {
            if (finishRun(runId)) {
                listener.onWakeError(error);
            }
        } finally {
            clearRecorder(localRecorder);
            releaseAudioRecord(localRecorder);
            if (model != null) {
                model.close();
            }
        }
    }

    private boolean setRecorderIfActive(int runId, AudioRecord nextRecorder) {
        synchronized (lock) {
            if (!active || activeRunId != runId) {
                return false;
            }
            recorder = nextRecorder;
            return true;
        }
    }

    private boolean isActive(int runId) {
        synchronized (lock) {
            return active && activeRunId == runId;
        }
    }

    private boolean finishRun(int runId) {
        synchronized (lock) {
            if (!active || activeRunId != runId) {
                return false;
            }
            active = false;
            activeRunId += 1;
            worker = null;
            return true;
        }
    }

    private void clearRecorder(AudioRecord localRecorder) {
        if (localRecorder == null) {
            return;
        }
        synchronized (lock) {
            if (recorder == localRecorder) {
                recorder = null;
            }
        }
    }

    private static void releaseAudioRecord(AudioRecord audioRecord) {
        if (audioRecord == null) {
            return;
        }
        try {
            audioRecord.stop();
        } catch (IllegalStateException ignored) {
        }
        audioRecord.release();
    }

    private static String normalizeWakeText(String text) {
        return text
            .toLowerCase(Locale.US)
            .replaceAll("[^a-z0-9]+", " ")
            .trim()
            .replaceAll("\\s+", " ");
    }
}
