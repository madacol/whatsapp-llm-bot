package com.madabot.voicepoc;

import android.content.Context;
import android.media.MediaRecorder;
import android.os.Build;

import java.io.File;
import java.io.IOException;

final class UtteranceRecorder {
    private MediaRecorder recorder;
    private File outputFile;

    boolean isRecording() {
        return recorder != null;
    }

    void start(Context context) throws IOException {
        if (recorder != null) {
            return;
        }
        File captureDir = new File(context.getCacheDir(), "captures");
        if (!captureDir.exists() && !captureDir.mkdirs()) {
            throw new IOException("Failed to create capture directory: " + captureDir);
        }
        outputFile = new File(captureDir, "turn-" + System.currentTimeMillis() + ".m4a");
        MediaRecorder next = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? new MediaRecorder(context)
            : new MediaRecorder();
        next.setAudioSource(MediaRecorder.AudioSource.MIC);
        next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
        next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
        next.setAudioChannels(1);
        next.setAudioSamplingRate(16_000);
        next.setAudioEncodingBitRate(64_000);
        next.setOutputFile(outputFile.getAbsolutePath());
        next.prepare();
        next.start();
        recorder = next;
    }

    File stop() {
        MediaRecorder current = recorder;
        recorder = null;
        if (current != null) {
            try {
                current.stop();
            } finally {
                current.release();
            }
        }
        return outputFile;
    }
}
