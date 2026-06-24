package com.madabot.voicepoc;

import android.Manifest;
import android.app.Activity;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public final class MainActivity extends Activity implements VoiceTurnController.Listener {
    private static final int REQUEST_RECORD_AUDIO = 200;

    private VoiceTurnController controller;
    private final WakeWordDetector wakeWordDetector = new SherpaWakeWordDetector();
    private EditText baseUrl;
    private EditText token;
    private EditText transportId;
    private EditText chatId;
    private TextView status;
    private Button recordButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        controller = new VoiceTurnController(this, this);
        setContentView(buildContentView());
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
    }

    private ScrollView buildContentView() {
        SharedPreferences preferences = getSharedPreferences("voice-poc", MODE_PRIVATE);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        baseUrl = field("API base URL", preferences.getString("baseUrl", "http://192.168.1.20:3200"));
        token = field("API token", preferences.getString("token", ""));
        transportId = field("Transport ID", preferences.getString("transportId", "voice"));
        chatId = field("Chat ID", preferences.getString("chatId", "api:android-1"));

        recordButton = new Button(this);
        recordButton.setText("Record");
        recordButton.setOnClickListener((view) -> toggleRecord());

        Button wakeButton = new Button(this);
        wakeButton.setText("Start wake detector");
        wakeButton.setOnClickListener((view) -> wakeWordDetector.start(new WakeWordDetector.Listener() {
            @Override
            public void onWakeWord(String keyword) {
                runOnUiThread(() -> {
                    onStatus("Wake: " + keyword);
                    if (!controller.isRecording()) {
                        controller.startRecording();
                    }
                });
            }

            @Override
            public void onWakeError(Exception error) {
                runOnUiThread(() -> onError(error));
            }
        }));

        status = new TextView(this);
        status.setText("Idle");
        status.setMinLines(8);

        root.addView(label("HTTP API"));
        root.addView(baseUrl);
        root.addView(token);
        root.addView(transportId);
        root.addView(chatId);
        root.addView(recordButton);
        root.addView(wakeButton);
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

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(18);
        return view;
    }

    private void toggleRecord() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQUEST_RECORD_AUDIO);
            return;
        }
        saveConfig();
        if (controller.isRecording()) {
            recordButton.setText("Record");
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
            "android-user",
            "Android"
        );
    }

    private void saveConfig() {
        getSharedPreferences("voice-poc", MODE_PRIVATE).edit()
            .putString("baseUrl", baseUrl.getText().toString())
            .putString("token", token.getText().toString())
            .putString("transportId", transportId.getText().toString())
            .putString("chatId", chatId.getText().toString())
            .apply();
    }

    @Override
    public void onStatus(String text) {
        status.setText(text);
    }

    @Override
    public void onError(Exception error) {
        status.setText(error.getClass().getSimpleName() + ": " + error.getMessage());
        recordButton.setText("Record");
    }

    @Override
    protected void onDestroy() {
        wakeWordDetector.stop();
        controller.shutdown();
        super.onDestroy();
    }
}
