package com.madabot.voicepoc;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;
import java.util.Locale;

final class PlatformSpeechWakeWordDetector implements WakeWordDetector {
    private static final long RESTART_DELAY_MS = 500;

    private final Activity activity;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private Listener listener;
    private String normalizedWakePhrase = "";
    private boolean listening;

    PlatformSpeechWakeWordDetector(Activity activity) {
        this.activity = activity;
    }

    @Override
    public void start(String wakePhrase, Listener listener) {
        mainHandler.post(() -> startOnMain(wakePhrase, listener));
    }

    @Override
    public void stop() {
        mainHandler.post(() -> stopOnMain(true));
    }

    private void startOnMain(String wakePhrase, Listener nextListener) {
        stopOnMain(false);
        String normalized = normalizeWakeText(wakePhrase);
        if (normalized.isEmpty()) {
            nextListener.onWakeError(new IllegalArgumentException("Enter a wake phrase."));
            return;
        }
        if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
            nextListener.onWakeError(new IllegalStateException("Android speech recognition is not available on this device."));
            return;
        }
        listener = nextListener;
        normalizedWakePhrase = normalized;
        listening = true;
        recognizer = SpeechRecognizer.createSpeechRecognizer(activity);
        recognizer.setRecognitionListener(new ListenerAdapter());
        nextListener.onWakeStatus("Listening for \"" + wakePhrase.trim() + "\".");
        startListening();
    }

    private void startListening() {
        SpeechRecognizer current = recognizer;
        if (!listening || current == null) {
            return;
        }
        try {
            current.startListening(recognitionIntent());
        } catch (RuntimeException error) {
            notifyError(error);
            stopOnMain(false);
        }
    }

    private Intent recognitionIntent() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, activity.getPackageName());
        return intent;
    }

    private void stopOnMain(boolean notify) {
        listening = false;
        mainHandler.removeCallbacksAndMessages(null);
        SpeechRecognizer current = recognizer;
        recognizer = null;
        if (current != null) {
            current.cancel();
            current.destroy();
        }
        Listener currentListener = listener;
        listener = null;
        if (notify && currentListener != null) {
            currentListener.onWakeStatus("Wake detector stopped.");
        }
    }

    private void scheduleRestart(String reason) {
        Listener currentListener = listener;
        if (!listening || recognizer == null) {
            return;
        }
        if (currentListener != null && !reason.isEmpty()) {
            currentListener.onWakeStatus(reason);
        }
        mainHandler.postDelayed(this::startListening, RESTART_DELAY_MS);
    }

    private void handleResults(Bundle results) {
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (containsWakePhrase(matches)) {
            triggerWakeWord();
            return;
        }
        scheduleRestart("");
    }

    private boolean containsWakePhrase(ArrayList<String> matches) {
        if (matches == null) {
            return false;
        }
        for (String match : matches) {
            if (normalizeWakeText(match).contains(normalizedWakePhrase)) {
                return true;
            }
        }
        return false;
    }

    private void triggerWakeWord() {
        Listener currentListener = listener;
        String wakePhrase = normalizedWakePhrase;
        stopOnMain(false);
        if (currentListener != null) {
            currentListener.onWakeStatus("Wake phrase detected.");
            currentListener.onWakeWord(wakePhrase);
        }
    }

    private void notifyError(Exception error) {
        Listener currentListener = listener;
        if (currentListener != null) {
            currentListener.onWakeError(error);
        }
    }

    private static String normalizeWakeText(String text) {
        return text
            .toLowerCase(Locale.US)
            .replaceAll("[^a-z0-9]+", " ")
            .trim()
            .replaceAll("\\s+", " ");
    }

    private final class ListenerAdapter implements RecognitionListener {
        @Override
        public void onReadyForSpeech(Bundle params) {
            Listener currentListener = listener;
            if (currentListener != null) {
                currentListener.onWakeStatus("Wake detector listening.");
            }
        }

        @Override
        public void onBeginningOfSpeech() {
            Listener currentListener = listener;
            if (currentListener != null) {
                currentListener.onWakeStatus("Checking wake phrase.");
            }
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
        }

        @Override
        public void onEndOfSpeech() {
        }

        @Override
        public void onError(int error) {
            if (!listening) {
                return;
            }
            if (error == SpeechRecognizer.ERROR_CLIENT || error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                notifyError(new IllegalStateException("Speech recognizer failed with error " + error + "."));
                stopOnMain(false);
                return;
            }
            scheduleRestart("");
        }

        @Override
        public void onResults(Bundle results) {
            handleResults(results);
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            ArrayList<String> matches = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
            if (containsWakePhrase(matches)) {
                triggerWakeWord();
            }
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
        }
    }
}
