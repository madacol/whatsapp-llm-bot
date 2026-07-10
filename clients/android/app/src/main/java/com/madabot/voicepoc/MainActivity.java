package com.madabot.voicepoc;

import android.Manifest;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.URI;

public final class MainActivity extends Activity implements VoiceTurnController.Listener {
    private static final int REQUEST_RECORD_AUDIO = 200;
    private static final int DEFAULT_API_PORT = 3200;
    private static final String LOCAL_DEFAULT_API_BASE_URL = "http://127.0.0.1:3200";

    private VoiceTurnController controller;
    private WakeWordDetector wakeWordDetector;
    private Button recordButton;
    private Button cancelButton;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable wakeCaptureTimeout = () -> {
        if (controller != null && controller.isRecording()) {
            recordButton.setText("Record");
            onStatus("Wake capture limit reached. Sending audio.");
            controller.stopAndSend(config());
        }
    };
    private EditText baseUrl;
    private EditText token;
    private EditText transportId;
    private EditText chatId;
    private EditText senderId;
    private EditText senderName;
    private EditText wakePhrase;
    private EditText wakeThreshold;
    private EditText wakeCaptureSeconds;
    private EditText wakeSilenceSeconds;
    private TextView status;
    private TextView assistantText;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        controller = new VoiceTurnController(this, this);
        wakeWordDetector = new OpenWakeWordWakeWordDetector(this);
        setContentView(buildContentView());
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
    }

    private ScrollView buildContentView() {
        SharedPreferences preferences = getSharedPreferences("voice-poc", MODE_PRIVATE);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        baseUrl = field("API base URL", defaultBaseUrl(preferences));
        token = field("API token", preferences.getString("token", ""));
        transportId = field("Transport ID", preferences.getString("transportId", "voice"));
        chatId = field("Chat ID", preferences.getString("chatId", "api:android-1"));
        senderId = field("Sender ID", preferences.getString("senderId", "android-user"));
        senderName = field("Sender name", preferences.getString("senderName", "Android"));
        wakePhrase = field("Wake phrase", preferences.getString("wakePhrase", "jarvis"));
        wakeThreshold = field("Wake threshold", preferences.getString("wakeThreshold", "0.5"));
        wakeCaptureSeconds = field("Max seconds", preferences.getString("wakeCaptureSeconds", "120"));
        wakeSilenceSeconds = field("Silence seconds", preferences.getString("wakeSilenceSeconds", "1.5"));

        Button checkApiButton = button("Check API", () -> {
            saveConfig();
            controller.checkApi(config());
        });

        Button clearHistoryButton = button("Clear History", () -> {
            saveConfig();
            controller.clearHistory(config());
        });

        cancelButton = button("Cancel Turn", () -> {
            saveConfig();
            controller.cancelActiveTurn(config());
        });
        cancelButton.setEnabled(false);

        recordButton = new Button(this);
        recordButton.setText("Record");
        recordButton.setOnClickListener((view) -> toggleRecord());

        Button wakeButton = button("Start wake detector", () -> {
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
                return;
            }
            saveConfig();
            wakeWordDetector.start(wakePhrase.getText().toString(), wakeThreshold(), new WakeWordDetector.Listener() {
            @Override
            public void onWakeWord(String keyword) {
                runOnUiThread(() -> {
                    onStatus("Wake: " + keyword + ". Recording.");
                    if (!controller.isRecording()) {
                        recordButton.setText("Stop and send");
                        controller.startRecording();
                        scheduleWakeCaptureTimeout();
                    }
                });
            }

            @Override
            public void onWakeStatus(String text) {
                runOnUiThread(() -> onStatus(text));
            }

            @Override
            public void onWakeError(Exception error) {
                runOnUiThread(() -> onError(error));
            }
            });
        });

        Button stopWakeButton = button("Stop wake detector", () -> {
            wakeWordDetector.stop();
            mainHandler.removeCallbacks(wakeCaptureTimeout);
            onStatus("Wake detector stopped.");
        });

        status = new TextView(this);
        status.setText("Idle");
        status.setMinLines(4);

        assistantText = new TextView(this);
        assistantText.setText("No response yet.");
        assistantText.setMinLines(6);

        root.addView(label("HTTP API"));
        root.addView(baseUrl);
        root.addView(token);
        root.addView(transportId);
        root.addView(chatId);
        root.addView(senderId);
        root.addView(senderName);
        root.addView(checkApiButton);
        root.addView(label("Wake Capture"));
        root.addView(wakePhrase);
        root.addView(wakeThreshold);
        root.addView(wakeCaptureSeconds);
        root.addView(wakeSilenceSeconds);
        root.addView(recordButton);
        root.addView(cancelButton);
        root.addView(clearHistoryButton);
        root.addView(wakeButton);
        root.addView(stopWakeButton);
        root.addView(label("Assistant"));
        root.addView(assistantText);
        root.addView(label("Status"));
        root.addView(status);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        return scroll;
    }

    private EditText field(String hint, String value) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setText(value);
        field.setSingleLine(true);
        field.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return field;
    }

    private String defaultBaseUrl(SharedPreferences preferences) {
        String configuredDefault = BuildConfig.DEFAULT_API_BASE_URL.trim();
        String fallback = configuredDefault.isEmpty() ? LOCAL_DEFAULT_API_BASE_URL : configuredDefault;
        String stored = preferences.getString("baseUrl", "");
        if (stored == null || stored.trim().isEmpty()) {
            return fallback;
        }
        String normalizedStored = stored.trim();
        if (!fallback.equals(LOCAL_DEFAULT_API_BASE_URL) && isPreviousDevelopmentBaseUrl(normalizedStored)) {
            return fallback;
        }
        return normalizedStored;
    }

    private static boolean isPreviousDevelopmentBaseUrl(String value) {
        try {
            URI uri = URI.create(value);
            String host = uri.getHost();
            if (host == null || uri.getPort() != DEFAULT_API_PORT) {
                return LOCAL_DEFAULT_API_BASE_URL.equals(value);
            }
            return isDevelopmentHost(host);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    private static boolean isDevelopmentHost(String host) {
        if ("localhost".equals(host) || "127.0.0.1".equals(host)) {
            return true;
        }
        int[] octets = parseIpv4(host);
        if (octets == null) {
            return false;
        }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }

    private static int[] parseIpv4(String host) {
        String[] parts = host.split("\\.");
        if (parts.length != 4) {
            return null;
        }
        int[] octets = new int[4];
        for (int index = 0; index < parts.length; index += 1) {
            try {
                if (parts[index].isEmpty()) {
                    return null;
                }
                int octet = Integer.parseInt(parts[index]);
                if (octet < 0 || octet > 255) {
                    return null;
                }
                octets[index] = octet;
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return octets;
    }

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(18);
        return view;
    }

    private Button button(String text, Runnable action) {
        Button button = new Button(this);
        button.setText(text);
        button.setOnClickListener((view) -> action.run());
        return button;
    }

    private void toggleRecord() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        saveConfig();
        if (controller.isRecording()) {
            recordButton.setText("Record");
            mainHandler.removeCallbacks(wakeCaptureTimeout);
            controller.stopAndSend(config());
        } else {
            recordButton.setText("Stop and send");
            controller.startRecording();
        }
    }

    private AudioTurnClient.Config config() {
        return new AudioTurnClient.Config(
            baseUrl.getText().toString(),
            token.getText().toString(),
            transportId.getText().toString(),
            chatId.getText().toString(),
            senderId.getText().toString(),
            senderName.getText().toString()
        );
    }

    private void saveConfig() {
        getSharedPreferences("voice-poc", MODE_PRIVATE).edit()
            .putString("baseUrl", baseUrl.getText().toString())
            .putString("token", token.getText().toString())
            .putString("transportId", transportId.getText().toString())
            .putString("chatId", chatId.getText().toString())
            .putString("senderId", senderId.getText().toString())
            .putString("senderName", senderName.getText().toString())
            .putString("wakePhrase", wakePhrase.getText().toString())
            .putString("wakeThreshold", wakeThreshold.getText().toString())
            .putString("wakeCaptureSeconds", wakeCaptureSeconds.getText().toString())
            .putString("wakeSilenceSeconds", wakeSilenceSeconds.getText().toString())
            .apply();
    }

    private void scheduleWakeCaptureTimeout() {
        mainHandler.removeCallbacks(wakeCaptureTimeout);
        mainHandler.postDelayed(wakeCaptureTimeout, wakeCaptureMillis());
    }

    private long wakeCaptureMillis() {
        try {
            double seconds = Double.parseDouble(wakeCaptureSeconds.getText().toString().trim());
            double boundedSeconds = Math.max(2, Math.min(120, seconds));
            return (long) (boundedSeconds * 1000);
        } catch (NumberFormatException ignored) {
            return 120_000;
        }
    }

    private double wakeThreshold() {
        try {
            double threshold = Double.parseDouble(wakeThreshold.getText().toString().trim());
            return Math.max(0.05, Math.min(0.99, threshold));
        } catch (NumberFormatException ignored) {
            return 0.5;
        }
    }

    @Override
    public void onStatus(String text) {
        status.setText(text);
    }

    @Override
    public void onAssistantText(String text, boolean replace) {
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return;
        }
        String current = assistantText.getText().toString().trim();
        if (replace || current.isEmpty() || "No response yet.".equals(current) || "Waiting for assistant...".equals(current)) {
            assistantText.setText(trimmed);
        } else {
            assistantText.setText(current + "\n\n" + trimmed);
        }
    }

    @Override
    public void onTurnActive(boolean active) {
        cancelButton.setEnabled(active);
    }

    @Override
    public void onError(Exception error) {
        mainHandler.removeCallbacks(wakeCaptureTimeout);
        status.setText(error.getClass().getSimpleName() + ": " + error.getMessage());
        recordButton.setText("Record");
        cancelButton.setEnabled(controller.hasActiveTurn());
    }

    @Override
    protected void onDestroy() {
        wakeWordDetector.stop();
        mainHandler.removeCallbacks(wakeCaptureTimeout);
        controller.shutdown();
        super.onDestroy();
    }
}
