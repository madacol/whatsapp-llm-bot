#!/usr/bin/env python3
import os
import tempfile
from pathlib import Path
from unittest import mock

import api_transport_client
import live_transcribe_and_ask
import transcribe_gemini
from transcribe_and_ask import extract_transcript


def main():
    with tempfile.TemporaryDirectory() as tmp:
        audio_path = Path(tmp) / "input.wav"
        audio_path.write_bytes(b"fake-wav")
        tts_path = Path(tmp) / "assistant.pcm"

        os.environ["GEMINI_API_KEY"] = "gemini-test-key"
        os.environ["TTS_PLAYBACK_DEVICE"] = "default"

        def send_streaming_side_effect(text, **kwargs):
            assert text == "turn on the kitchen light"
            kwargs["on_event"]({
                "kind": "client",
                "stage": "turn_submitted",
                "turnId": "turn-test",
                "requestId": "request-test",
            })
            kwargs["on_event"]({
                "eventId": "10",
                "turnId": "turn-test",
                "kind": "content",
                "event": {
                    "kind": "content",
                    "source": "llm",
                    "content": [{"type": "text", "text": "Thinking..."}],
                },
            })
            kwargs["on_assistant_text"](
                "**Done.** The kitchen light is on.",
                {
                    "eventId": "11",
                    "turnId": "turn-test",
                    "kind": "content",
                    "event": {
                        "kind": "content",
                        "source": "llm",
                        "content": [{"type": "markdown", "text": "**Done.** The kitchen light is on."}],
                        "stream": {"id": "assistant-1", "status": "final"},
                    },
                },
            )
            return {
                "status": "completed",
                "assistantText": "**Done.** The kitchen light is on.",
            }

        with (
            mock.patch("transcribe_gemini.upload_file", return_value={"name": "files/test"}) as upload_file,
            mock.patch(
                "transcribe_gemini.transcribe",
                return_value='{"transcript":"turn on the kitchen light","language":"en","notes":""}',
            ) as transcribe,
            mock.patch(
                "api_transport_client.send_text_turn_streaming",
                side_effect=send_streaming_side_effect,
            ) as send_text_turn_streaming,
            mock.patch(
                "tts_openrouter.synthesize_speech",
                return_value={
                    "path": str(tts_path),
                    "format": "pcm",
                    "bytes": 128,
                    "provider": "openai",
                    "route": "speech",
                },
            ) as synthesize_speech,
            mock.patch("tts_openrouter.play_audio") as play_audio,
        ):
            with mock.patch("sys.argv", ["live_transcribe_and_ask.py", str(audio_path)]):
                live_transcribe_and_ask.main()

        upload_file.assert_called_once_with(audio_path, "gemini-test-key")
        assert transcribe.call_count == 1, transcribe.call_args
        assert transcribe.call_args.args[3] == transcribe_gemini.DEFAULT_TRANSCRIPTION_PROMPT, transcribe.call_args
        assert send_text_turn_streaming.call_count == 1, send_text_turn_streaming.call_args
        assert send_text_turn_streaming.call_args.args == ("turn on the kitchen light",), send_text_turn_streaming.call_args
        synthesize_speech.assert_called_once_with(
            "**Done.** The kitchen light is on.",
            model=None,
            voice=None,
            response_format=None,
            provider=None,
            instructions=None,
        )
        play_audio.assert_called_once_with(str(tts_path), "pcm")

        assert api_transport_client.extract_response_text({"text": "plain"}) == "plain"
        assert api_transport_client.extract_response_text({"markdown": "**md**"}) == "**md**"
        assert api_transport_client.extract_response_text({
            "content": [
                {"type": "text", "text": "one"},
                {"type": "markdown", "markdown": "**two**"},
            ]
        }) == "one\n\n**two**"
        assert extract_transcript('{"transcription":"Ah, man. Hey, Jarvis.","description":"A man calls Jarvis."}') == (
            "Transcription: Ah, man. Hey, Jarvis.\n\nDescription: A man calls Jarvis."
        )
        assert extract_transcript('[{"transcription":"First."},{"description":"Second description."}]') == (
            "First.\n\nDescription: Second description."
        )
        assert extract_transcript("Plain transcription text.") == "Plain transcription text."

    print("live_transcribe_and_ask smoke test passed")


if __name__ == "__main__":
    main()
