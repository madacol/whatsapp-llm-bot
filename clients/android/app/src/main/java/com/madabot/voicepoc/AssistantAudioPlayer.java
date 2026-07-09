package com.madabot.voicepoc;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;

final class AssistantAudioPlayer {
    interface Listener {
        void onPlaybackStatus(String text);
        void onPlaybackError(Exception error);
    }

    private MediaPlayer player;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    void enqueue(Context context, String audioUrl, String token, Listener listener) {
        executor.execute(() -> {
            try {
                listener.onPlaybackStatus("Downloading assistant audio.");
                playBlocking(context, audioUrl, token);
                listener.onPlaybackStatus("Assistant audio played.");
            } catch (Exception error) {
                listener.onPlaybackError(error);
            }
        });
    }

    private void playBlocking(Context context, String audioUrl, String token) throws Exception {
        stop();
        MediaPlayer next = new MediaPlayer();
        CountDownLatch finished = new CountDownLatch(1);
        AtomicReference<Exception> playbackError = new AtomicReference<>();
        next.setAudioAttributes(new AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
            .build());
        Map<String, String> headers = new HashMap<>();
        if (!token.trim().isEmpty()) {
            headers.put("Authorization", "Bearer " + token.trim());
        }
        next.setDataSource(context, Uri.parse(audioUrl), headers);
        next.setOnCompletionListener((completed) -> finished.countDown());
        next.setOnErrorListener((failed, what, extra) -> {
            playbackError.set(new IllegalStateException("MediaPlayer error " + what + "/" + extra));
            finished.countDown();
            return true;
        });
        next.prepare();
        player = next;
        next.start();
        finished.await();
        stop();
        Exception error = playbackError.get();
        if (error != null) {
            throw error;
        }
    }

    synchronized void stop() {
        MediaPlayer current = player;
        player = null;
        if (current != null) {
            try {
                current.stop();
            } catch (IllegalStateException ignored) {
                // The player may be idle if prepare failed.
            }
            current.release();
        }
    }

    void shutdown() {
        stop();
        executor.shutdownNow();
    }
}
