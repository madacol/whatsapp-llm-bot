package com.madabot.voicepoc;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;

import java.util.HashMap;
import java.util.Map;

final class AssistantAudioPlayer {
    private MediaPlayer player;

    void play(Context context, String audioUrl, String token) throws Exception {
        stop();
        MediaPlayer next = new MediaPlayer();
        next.setAudioAttributes(new AudioAttributes.Builder()
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
            .build());
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + token.trim());
        next.setDataSource(context, Uri.parse(audioUrl), headers);
        next.setOnCompletionListener(MediaPlayer::release);
        next.prepare();
        player = next;
        next.start();
    }

    void stop() {
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
}
