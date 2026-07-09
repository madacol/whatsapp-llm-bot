package com.madabot.voicepoc;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Set;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OnnxValue;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.TensorInfo;

final class OpenWakeWordModel implements AutoCloseable {
    static final int SAMPLE_RATE = 16_000;
    static final int FRAME_SAMPLES = 1_280;

    private static final int MEL_CONTEXT_SAMPLES = 160 * 3;
    private static final int MELSPEC_MAX_ROWS = 10 * 97;
    private static final int FEATURE_MAX_ROWS = 120;
    private static final int PREDICTION_BUFFER_ROWS = 30;
    private static final int MODEL_INPUT_FRAMES = 16;
    private static final int FEATURE_COLUMNS = 96;
    private static final int MELSPEC_COLUMNS = 32;
    private static final int WARMUP_PREDICTIONS = 5;
    private static final int RAW_BUFFER_SAMPLES = SAMPLE_RATE * 10;

    private final OrtEnvironment environment;
    private final OrtSession.SessionOptions sessionOptions;
    private final OrtSession melspecSession;
    private final OrtSession embeddingSession;
    private final OrtSession wakeSession;
    private final double threshold;

    private final short[] rawDataBuffer = new short[RAW_BUFFER_SAMPLES];
    private int rawDataLength;
    private short[] rawDataRemainder = new short[0];
    private int accumulatedSamples;
    private final ArrayList<float[]> melspectrogramRows = new ArrayList<>();
    private final ArrayList<float[]> featureRows = new ArrayList<>();
    private ArrayList<float[]> primedFeatureRows = new ArrayList<>();
    private final ArrayList<Float> predictionBuffer = new ArrayList<>();

    private OpenWakeWordModel(
        OrtEnvironment environment,
        OrtSession.SessionOptions sessionOptions,
        OrtSession melspecSession,
        OrtSession embeddingSession,
        OrtSession wakeSession,
        double threshold
    ) {
        this.environment = environment;
        this.sessionOptions = sessionOptions;
        this.melspecSession = melspecSession;
        this.embeddingSession = embeddingSession;
        this.wakeSession = wakeSession;
        this.threshold = threshold;
        addInitialRows(melspectrogramRows, 76, MELSPEC_COLUMNS, 1);
    }

    static OpenWakeWordModel create(Context context, double threshold) throws IOException, OrtException {
        OrtEnvironment environment = OrtEnvironment.getEnvironment();
        OrtSession.SessionOptions options = new OrtSession.SessionOptions();
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        options.setIntraOpNumThreads(2);
        options.setInterOpNumThreads(1);
        OpenWakeWordModel model = new OpenWakeWordModel(
            environment,
            options,
            environment.createSession(readAssetBytes(context, "melspectrogram.onnx"), options),
            environment.createSession(readAssetBytes(context, "embedding_model.onnx"), options),
            environment.createSession(readAssetBytes(context, "hey_jarvis_v0.1.onnx"), options),
            threshold
        );
        model.primeFeatureBuffer();
        model.captureResetBaseline();
        return model;
    }

    Prediction process(short[] input, int length) throws OrtException {
        int preparedSamples = prepareFeatures(input, length);
        float score = 0;
        if (preparedSamples > FRAME_SAMPLES) {
            int preparedFrames = Math.floorDiv(preparedSamples, FRAME_SAMPLES);
            for (int index = preparedFrames - 1; index >= 0; index -= 1) {
                score = Math.max(score, predictFromFeatures(-MODEL_INPUT_FRAMES - index));
            }
        } else if (preparedSamples == FRAME_SAMPLES) {
            score = predictFromFeatures(null);
        } else if (!predictionBuffer.isEmpty()) {
            score = predictionBuffer.get(predictionBuffer.size() - 1);
        }

        if (predictionBuffer.size() < WARMUP_PREDICTIONS) {
            score = 0;
        }
        predictionBuffer.add(score);
        trimPredictions();
        return new Prediction(score >= threshold, score, threshold);
    }

    private void reset() {
        rawDataLength = 0;
        rawDataRemainder = new short[0];
        accumulatedSamples = 0;
        melspectrogramRows.clear();
        addInitialRows(melspectrogramRows, 76, MELSPEC_COLUMNS, 1);
        featureRows.clear();
        featureRows.addAll(cloneRows(primedFeatureRows));
        predictionBuffer.clear();
    }

    private void primeFeatureBuffer() throws OrtException {
        short[] samples = new short[SAMPLE_RATE * 4];
        long seed = 0x12345678L;
        for (int index = 0; index < samples.length; index += 1) {
            seed = (1664525L * seed + 1013904223L) & 0xffffffffL;
            samples[index] = (short) ((seed / (double) 0xffffffffL) * 2000 - 1000);
        }
        featureRows.addAll(embeddingsForSamples(samples));
        trimRows(featureRows, FEATURE_MAX_ROWS);
    }

    private void captureResetBaseline() {
        primedFeatureRows = cloneRows(featureRows);
        reset();
    }

    private int prepareFeatures(short[] input, int length) throws OrtException {
        short[] x = copyOf(input, length);
        if (rawDataRemainder.length > 0) {
            x = concatenate(rawDataRemainder, x);
            rawDataRemainder = new short[0];
        }

        if (accumulatedSamples + x.length >= FRAME_SAMPLES) {
            int remainder = (accumulatedSamples + x.length) % FRAME_SAMPLES;
            int evenLength = remainder == 0 ? x.length : x.length - remainder;
            if (evenLength > 0) {
                bufferRawData(x, 0, evenLength);
                accumulatedSamples += evenLength;
            }
            rawDataRemainder = remainder == 0 ? new short[0] : Arrays.copyOfRange(x, evenLength, x.length);
        } else {
            bufferRawData(x, 0, x.length);
            accumulatedSamples += x.length;
        }

        int processedSamples = 0;
        if (accumulatedSamples >= FRAME_SAMPLES && accumulatedSamples % FRAME_SAMPLES == 0) {
            streamingMelspectrogram(accumulatedSamples);
            int preparedFrames = Math.floorDiv(accumulatedSamples, FRAME_SAMPLES);
            for (int frameIndex = preparedFrames - 1; frameIndex >= 0; frameIndex -= 1) {
                int offsetRows = frameIndex == 0 ? 0 : 8 * frameIndex;
                int end = offsetRows == 0 ? melspectrogramRows.size() : melspectrogramRows.size() - offsetRows;
                int start = end - 76;
                if (start >= 0 && end <= melspectrogramRows.size()) {
                    featureRows.addAll(embeddingsForMelspecWindows(Collections.singletonList(windowRows(start, end))));
                }
            }
            processedSamples = accumulatedSamples;
            accumulatedSamples = 0;
            trimRows(featureRows, FEATURE_MAX_ROWS);
        }
        return processedSamples != 0 ? processedSamples : accumulatedSamples;
    }

    private void streamingMelspectrogram(int sampleCount) throws OrtException {
        if (rawDataLength < 400) {
            throw new IllegalStateException("openWakeWord needs at least 25 ms of PCM before feature extraction.");
        }
        int start = Math.max(0, rawDataLength - sampleCount - MEL_CONTEXT_SAMPLES);
        short[] samples = Arrays.copyOfRange(rawDataBuffer, start, rawDataLength);
        melspectrogramRows.addAll(melspectrogramForSamples(samples));
        trimRows(melspectrogramRows, MELSPEC_MAX_ROWS);
    }

    private ArrayList<float[]> embeddingsForSamples(short[] samples) throws OrtException {
        ArrayList<float[]> melspecRows = melspectrogramForSamples(samples);
        ArrayList<float[][]> windows = new ArrayList<>();
        for (int index = 0; index < melspecRows.size(); index += 8) {
            if (index + 76 <= melspecRows.size()) {
                float[][] rows = new float[76][];
                for (int row = 0; row < 76; row += 1) {
                    rows[row] = melspecRows.get(index + row);
                }
                windows.add(rows);
            }
        }
        return embeddingsForMelspecWindows(windows);
    }

    private ArrayList<float[]> melspectrogramForSamples(short[] samples) throws OrtException {
        float[] input = new float[samples.length];
        for (int index = 0; index < samples.length; index += 1) {
            input[index] = samples[index];
        }
        TensorData output = runSession(melspecSession, input, new long[] { 1, input.length });
        int rowCount = Math.toIntExact(output.shape[output.shape.length - 2]);
        ArrayList<float[]> rows = new ArrayList<>(rowCount);
        for (int row = 0; row < rowCount; row += 1) {
            float[] values = new float[MELSPEC_COLUMNS];
            for (int column = 0; column < MELSPEC_COLUMNS; column += 1) {
                values[column] = output.data[row * MELSPEC_COLUMNS + column] / 10 + 2;
            }
            rows.add(values);
        }
        return rows;
    }

    private ArrayList<float[]> embeddingsForMelspecWindows(List<float[][]> windows) throws OrtException {
        ArrayList<float[]> rows = new ArrayList<>(windows.size());
        if (windows.isEmpty()) {
            return rows;
        }
        float[] input = new float[windows.size() * 76 * MELSPEC_COLUMNS];
        int cursor = 0;
        for (float[][] windowRows : windows) {
            for (float[] row : windowRows) {
                for (float value : row) {
                    input[cursor] = value;
                    cursor += 1;
                }
            }
        }
        TensorData output = runSession(embeddingSession, input, new long[] { windows.size(), 76, MELSPEC_COLUMNS, 1 });
        for (int batch = 0; batch < windows.size(); batch += 1) {
            float[] row = new float[FEATURE_COLUMNS];
            System.arraycopy(output.data, batch * FEATURE_COLUMNS, row, 0, FEATURE_COLUMNS);
            rows.add(row);
        }
        return rows;
    }

    private float predictFromFeatures(Integer startIndex) throws OrtException {
        List<float[]> rows = getFeatureWindow(MODEL_INPUT_FRAMES, startIndex);
        float[] input = new float[MODEL_INPUT_FRAMES * FEATURE_COLUMNS];
        int cursor = 0;
        for (float[] row : rows) {
            for (float value : row) {
                if (cursor < input.length) {
                    input[cursor] = value;
                    cursor += 1;
                }
            }
        }
        TensorData output = runSession(wakeSession, input, new long[] { 1, MODEL_INPUT_FRAMES, FEATURE_COLUMNS });
        return output.data.length > 0 ? output.data[0] : 0;
    }

    private List<float[]> getFeatureWindow(int count, Integer startIndex) {
        int size = featureRows.size();
        int start;
        int end;
        if (startIndex == null) {
            start = Math.max(0, size - count);
            end = size;
        } else if (startIndex < 0) {
            start = size + startIndex;
            end = startIndex + count == 0 ? size : size + startIndex + count;
        } else {
            start = startIndex;
            end = startIndex + count;
        }
        start = Math.max(0, Math.min(start, size));
        end = Math.max(start, Math.min(end, size));
        return featureRows.subList(start, end);
    }

    private TensorData runSession(OrtSession session, float[] inputData, long[] inputShape) throws OrtException {
        String inputName = firstName(session.getInputNames(), "input");
        String outputName = firstName(session.getOutputNames(), "output");
        try (
            OnnxTensor input = OnnxTensor.createTensor(environment, FloatBuffer.wrap(inputData), inputShape);
            OrtSession.Result result = session.run(Collections.singletonMap(inputName, input))
        ) {
            OnnxValue rawOutput = result.get(outputName).orElse(result.get(0));
            if (!(rawOutput instanceof OnnxTensor)) {
                throw new IllegalStateException("ONNX model returned a non-tensor output.");
            }
            OnnxTensor output = (OnnxTensor) rawOutput;
            if (!(output.getInfo() instanceof TensorInfo)) {
                throw new IllegalStateException("ONNX model returned output without tensor shape info.");
            }
            FloatBuffer outputBuffer = output.getFloatBuffer();
            float[] outputData = new float[outputBuffer.remaining()];
            outputBuffer.get(outputData);
            return new TensorData(outputData, ((TensorInfo) output.getInfo()).getShape());
        }
    }

    private void bufferRawData(short[] samples, int offset, int length) {
        if (length <= 0) {
            return;
        }
        if (length >= rawDataBuffer.length) {
            System.arraycopy(samples, offset + length - rawDataBuffer.length, rawDataBuffer, 0, rawDataBuffer.length);
            rawDataLength = rawDataBuffer.length;
            return;
        }
        int overflow = rawDataLength + length - rawDataBuffer.length;
        if (overflow > 0) {
            System.arraycopy(rawDataBuffer, overflow, rawDataBuffer, 0, rawDataLength - overflow);
            rawDataLength -= overflow;
        }
        System.arraycopy(samples, offset, rawDataBuffer, rawDataLength, length);
        rawDataLength += length;
    }

    private float[][] windowRows(int start, int end) {
        float[][] rows = new float[end - start][];
        for (int index = start; index < end; index += 1) {
            rows[index - start] = melspectrogramRows.get(index);
        }
        return rows;
    }

    private void trimPredictions() {
        if (predictionBuffer.size() > PREDICTION_BUFFER_ROWS) {
            predictionBuffer.subList(0, predictionBuffer.size() - PREDICTION_BUFFER_ROWS).clear();
        }
    }

    private static void trimRows(ArrayList<float[]> rows, int maxLength) {
        if (rows.size() > maxLength) {
            rows.subList(0, rows.size() - maxLength).clear();
        }
    }

    private static void addInitialRows(ArrayList<float[]> rows, int rowCount, int columns, float value) {
        for (int row = 0; row < rowCount; row += 1) {
            float[] values = new float[columns];
            Arrays.fill(values, value);
            rows.add(values);
        }
    }

    private static ArrayList<float[]> cloneRows(ArrayList<float[]> rows) {
        ArrayList<float[]> clone = new ArrayList<>(rows.size());
        for (float[] row : rows) {
            clone.add(row.clone());
        }
        return clone;
    }

    private static short[] copyOf(short[] input, int length) {
        return Arrays.copyOf(input, length);
    }

    private static short[] concatenate(short[] first, short[] second) {
        short[] combined = new short[first.length + second.length];
        System.arraycopy(first, 0, combined, 0, first.length);
        System.arraycopy(second, 0, combined, first.length, second.length);
        return combined;
    }

    private static String firstName(Set<String> names, String type) {
        if (names.isEmpty()) {
            throw new IllegalStateException("ONNX model did not expose an " + type + " name.");
        }
        return names.iterator().next();
    }

    private static byte[] readAssetBytes(Context context, String assetName) throws IOException {
        try (
            InputStream input = context.getAssets().open(assetName);
            ByteArrayOutputStream output = new ByteArrayOutputStream()
        ) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        }
    }

    @Override
    public void close() {
        closeSession(melspecSession);
        closeSession(embeddingSession);
        closeSession(wakeSession);
        closeOptions(sessionOptions);
    }

    private static void closeSession(OrtSession session) {
        try {
            session.close();
        } catch (OrtException ignored) {
        }
    }

    private static void closeOptions(OrtSession.SessionOptions options) {
        options.close();
    }

    static final class Prediction {
        final boolean detected;
        final float score;
        final double threshold;

        Prediction(boolean detected, float score, double threshold) {
            this.detected = detected;
            this.score = score;
            this.threshold = threshold;
        }
    }

    private static final class TensorData {
        final float[] data;
        final long[] shape;

        TensorData(float[] data, long[] shape) {
            this.data = data;
            this.shape = shape;
        }
    }
}
