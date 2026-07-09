package com.madabot.voicepoc;

import android.net.Uri;

import org.json.JSONArray;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

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

    static final class AudioBlock {
        final String path;
        final String url;
        final String mimeType;

        AudioBlock(String path, String url, String mimeType) {
            this.path = path;
            this.url = url;
            this.mimeType = mimeType;
        }
    }

    static final class AssistantEvent {
        final String text;
        final List<AudioBlock> audioBlocks;

        AssistantEvent(String text, List<AudioBlock> audioBlocks) {
            this.text = text;
            this.audioBlocks = audioBlocks;
        }
    }

    static final class EventRow {
        final String eventId;
        final String kind;
        final JSONObject event;

        EventRow(String eventId, String kind, JSONObject event) {
            this.eventId = eventId;
            this.kind = kind;
            this.event = event;
        }
    }

    static final class Result {
        final String text;
        final AudioBlock audio;

        Result(String text, AudioBlock audio) {
            this.text = text;
            this.audio = audio;
        }
    }

    String checkHealth(Config config) throws Exception {
        HttpURLConnection connection = openConnection(buildApiUrl(config.baseUrl, "/health", null), config);
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        connection.setRequestMethod("GET");
        int status = connection.getResponseCode();
        String body = readText(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (status >= 400) {
            throw new IOException("HTTP " + status + ": " + body);
        }
        return body;
    }

    String submitCommandTurn(Config config, String commandText, String requestId) throws Exception {
        Map<String, String> query = new LinkedHashMap<>();
        query.put("wait", "true");
        HttpURLConnection connection = openConnection(
            buildApiUrl(config.baseUrl, "/api/transports/" + Uri.encode(config.transportId) + "/turns", query),
            config
        );
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(180_000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        JSONObject payload = new JSONObject();
        payload.put("requestId", requestId);
        payload.put("chatId", config.chatId);
        payload.put("senderIds", new JSONArray().put(config.senderId));
        payload.put("senderName", config.senderName);
        payload.put("timestamp", java.time.Instant.now().toString());
        payload.put("content", new JSONArray().put(new JSONObject()
            .put("type", "text")
            .put("text", commandText)));
        payload.put("facts", new JSONObject()
            .put("isGroup", false)
            .put("addressedToBot", true)
            .put("repliedToBot", false));

        try (OutputStream output = connection.getOutputStream()) {
            output.write(payload.toString().getBytes(StandardCharsets.UTF_8));
        }

        int status = connection.getResponseCode();
        String body = readText(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (status >= 400) {
            throw new IOException("HTTP " + status + ": " + body);
        }
        return body;
    }

    String readCurrentEventCursor(Config config) throws Exception {
        Map<String, String> query = new LinkedHashMap<>();
        query.put("chatId", config.chatId);
        query.put("after", "0");
        HttpURLConnection connection = openConnection(
            buildApiUrl(config.baseUrl, "/api/transports/" + Uri.encode(config.transportId) + "/events", query),
            config
        );
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        connection.setRequestMethod("GET");
        int status = connection.getResponseCode();
        String body = readText(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (status >= 400) {
            return null;
        }
        JSONObject json = new JSONObject(body);
        return json.optString("nextEventId", null);
    }

    List<EventRow> readEventsAfter(Config config, String after) throws Exception {
        Map<String, String> query = new LinkedHashMap<>();
        query.put("chatId", config.chatId);
        query.put("after", after);
        HttpURLConnection connection = openConnection(
            buildApiUrl(config.baseUrl, "/api/transports/" + Uri.encode(config.transportId) + "/events", query),
            config
        );
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        connection.setRequestMethod("GET");
        int status = connection.getResponseCode();
        String body = readText(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
        if (status >= 400) {
            throw new IOException("Event catch-up failed with HTTP " + status + ": " + body);
        }
        JSONObject json = new JSONObject(body);
        JSONArray events = json.optJSONArray("events");
        List<EventRow> rows = new ArrayList<>();
        if (events == null) {
            return rows;
        }
        for (int index = 0; index < events.length(); index += 1) {
            JSONObject row = events.optJSONObject(index);
            if (row == null) {
                continue;
            }
            JSONObject event = row.optJSONObject("event");
            if (event == null) {
                continue;
            }
            rows.add(new EventRow(
                row.optString("eventId", ""),
                row.optString("kind", ""),
                event
            ));
        }
        return rows;
    }

    AssistantEvent parseAssistantEvent(EventRow row) {
        if (!"assistant_output".equals(row.kind)) {
            return new AssistantEvent("", new ArrayList<>());
        }
        return new AssistantEvent(assistantEventText(row.event), assistantEventAudioBlocks(row.event));
    }

    Result submitAudioTurn(Config config, File audioFile, String mimeType, String requestId) throws Exception {
        String encodedTransport = Uri.encode(config.transportId);
        Map<String, String> query = new LinkedHashMap<>();
        query.put("wait", "true");
        URL url = buildApiUrl(config.baseUrl, "/api/transports/" + encodedTransport + "/audio-turns", query);
        HttpURLConnection connection = openConnection(url, config);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(180_000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", mimeType);
        connection.setRequestProperty("X-Request-Id", requestId);
        connection.setRequestProperty("X-Chat-Id", config.chatId);
        connection.setRequestProperty("X-Sender-Id", config.senderId);
        connection.setRequestProperty("X-Sender-Name", config.senderName);
        connection.setRequestProperty("X-Timestamp", java.time.Instant.now().toString());

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
        return new Result(
            json.optString("text", ""),
            audio == null ? null : audioBlockFromJson(audio)
        );
    }

    String resolveAudioUrl(Config config, AudioBlock audio) throws Exception {
        if (audio == null) {
            throw new IOException("Response did not include assistant audio.");
        }
        if (!audio.path.isEmpty()) {
            return buildApiUrl(config.baseUrl, "/api/media/" + Uri.encode(audio.path), null).toString();
        }
        if (!audio.url.isEmpty()) {
            URL resolved = new URL(new URL(config.baseUrl), audio.url);
            return preserveBaseQuery(config.baseUrl, resolved.toString()).toString();
        }
        throw new IOException("Response audio did not include a path or URL.");
    }

    private static HttpURLConnection openConnection(URL url, Config config) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        if (!config.token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + config.token);
        }
        return connection;
    }

    private static URL buildApiUrl(String baseUrl, String apiPath, Map<String, String> query) throws IOException {
        Uri base = Uri.parse(stripTrailingSlash(baseUrl));
        Uri.Builder builder = base.buildUpon();
        String basePath = base.getEncodedPath();
        String normalizedBasePath = basePath == null || basePath.equals("/") ? "" : basePath.replaceAll("/+$", "");
        String normalizedApiPath = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
        builder.encodedPath(normalizedBasePath + normalizedApiPath);
        if (query != null) {
            for (Map.Entry<String, String> entry : query.entrySet()) {
                builder.appendQueryParameter(entry.getKey(), entry.getValue());
            }
        }
        return new URL(builder.build().toString());
    }

    private static URL preserveBaseQuery(String baseUrl, String resolvedUrl) throws IOException {
        Uri base = Uri.parse(baseUrl);
        Uri resolved = Uri.parse(resolvedUrl);
        Uri.Builder builder = resolved.buildUpon();
        for (String name : base.getQueryParameterNames()) {
            if (resolved.getQueryParameter(name) != null) {
                continue;
            }
            for (String value : base.getQueryParameters(name)) {
                builder.appendQueryParameter(name, value);
            }
        }
        return new URL(builder.build().toString());
    }

    private static String stripTrailingSlash(String value) {
        String trimmed = value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String assistantEventText(JSONObject event) {
        Object content = event.opt("content");
        if (content instanceof String) {
            String text = ((String) content).trim();
            return isTransientAssistantStatus(text) ? "" : text;
        }
        JSONArray blocks = content instanceof JSONArray
            ? (JSONArray) content
            : content instanceof JSONObject
                ? new JSONArray().put(content)
                : new JSONArray();
        List<String> lines = new ArrayList<>();
        for (int index = 0; index < blocks.length(); index += 1) {
            JSONObject block = blocks.optJSONObject(index);
            if (block == null) {
                continue;
            }
            String type = block.optString("type", "");
            String text = block.optString("text", "").trim();
            if (text.isEmpty() || isTransientAssistantStatus(text)) {
                continue;
            }
            if ("text".equals(type) || "markdown".equals(type)) {
                lines.add(text);
            }
        }
        return String.join("\n", lines);
    }

    private static List<AudioBlock> assistantEventAudioBlocks(JSONObject event) {
        Object content = event.opt("content");
        JSONArray blocks = content instanceof JSONArray
            ? (JSONArray) content
            : content instanceof JSONObject
                ? new JSONArray().put(content)
                : new JSONArray();
        List<AudioBlock> audioBlocks = new ArrayList<>();
        for (int index = 0; index < blocks.length(); index += 1) {
            JSONObject block = blocks.optJSONObject(index);
            if (block == null || !"audio".equals(block.optString("type", ""))) {
                continue;
            }
            AudioBlock audio = audioBlockFromJson(block);
            if (!audio.path.isEmpty() || !audio.url.isEmpty()) {
                audioBlocks.add(audio);
            }
        }
        return audioBlocks;
    }

    private static AudioBlock audioBlockFromJson(JSONObject audio) {
        return new AudioBlock(
            audio.optString("path", ""),
            audio.optString("url", ""),
            audio.optString("mimeType", audio.optString("mime_type", "audio/mpeg"))
        );
    }

    private static boolean isTransientAssistantStatus(String text) {
        return "Thinking...".equals(text.trim());
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
