"""GroomNote AI engineering CLI package."""

__version__ = "0.0.0"

from .audio import play_wav_bytes
from .client import ApiError, GroomNoteClient, SpeechAudio, SttToken
from .stt import (
    AudioFormat,
    MicrophoneDevice,
    RoundCoordinator,
    SilenceConfirmation,
    TranscriptAccumulator,
    is_round_end_command,
    list_microphones,
    select_microphone,
)

__all__ = [
    "ApiError",
    "GroomNoteClient",
    "SpeechAudio",
    "SttToken",
    "AudioFormat",
    "MicrophoneDevice",
    "RoundCoordinator",
    "SilenceConfirmation",
    "TranscriptAccumulator",
    "is_round_end_command",
    "list_microphones",
    "select_microphone",
    "play_wav_bytes",
    "__version__",
]
