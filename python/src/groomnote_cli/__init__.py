"""GroomNote AI engineering CLI package."""

__version__ = "0.0.0"

from .audio import play_wav_bytes
from .client import ApiError, GroomNoteClient, SpeechAudio

__all__ = ["ApiError", "GroomNoteClient", "SpeechAudio", "play_wav_bytes", "__version__"]
