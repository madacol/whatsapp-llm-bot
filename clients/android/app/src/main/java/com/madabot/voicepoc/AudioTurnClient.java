package com.madabot.voicepoc;

import android.net.Uri;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class AudioTurnClient {
    static final class Config {
        final String baseUrl;
        final String token;
        final String transportId;
        final String chatId;
        final String senderId;
        final String senderName;

        Config(String baseUrl, String token, String transportId, String chatId, String senderId, String senderName) {
            this.baseUrl = stripTrailingSlash(baseUrl);
            this.token = token.trim();
            this.transportId = transportId.trim();
            this.chatId = chatId.trim();
            this.senderId = senderId.trim();
            this.senderName = senderName.trim();
        }
    }

    static final class Result {
        final String text;
        final String audioUrl;
        final String audioMimeType;

        Result(String text, String audioUrl, String audioMimeType) {
            this.text = text;
            this.audioUrl = audioUrl;
            this.audioMimeType = audioMimeType;
        }
    }

    Result submitAudioTurn(Config config, File audioFile, String mimeType) throws Exception {
        String encodedTransport = Uri.encode(config.transportId);
        URL url = new URL(config.baseUrl + "/api/transports/" + encodedTransport + "/audio-turns?wait=true");
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(180_000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", mimeType);
        connection.setRequestProperty("Authorization", "Bearer " + config.token);
        connection.setRequestProperty("X-Request-Id", "android-" + System.currentTimeMillis());
        connection.setRequestProperty("X-Chat-Id", config.chatId);
        connection.setRequestProperty("X-Sender-Id", config.senderId);
        connection.setRequestProperty("X-Sender-Name", config.senderName);

        try (OutputStream output = connection.getOutputStream(); InputStream input = new FileInputStream(audioFile)) {
            copy(input, output);
        }

        int status = connection.getResponseCode();
        String body = readText(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (status >= 400) {
            throw new IOException("HTTP " + status + ": " + body);
        }

        JSONObject json = new JSONObject(body);
        JSONObject audio = json.optJSONObject("audio");
        if (audio == null) {
            throw new IOException("Response did not include assistant audio: " + body);
        }
        return new Result(
            json.optString("text", ""),
            audio.optString("url", ""),
            audio.optString("mimeType", "audio/mpeg")
        );
    }

    private static String stripTrailingSlash(String value) {
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static void copy(InputStream input, OutputStream output) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            output.write(buffer, 0, read);
        }
    }

    private static String readText(InputStream input) throws IOException {
        if (input == null) {
            return "";
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        copy(input, output);
        return output.toString(StandardCharsets.UTF_8.name());
    }
}
