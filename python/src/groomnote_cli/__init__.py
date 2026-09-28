"""GroomNote AI engineering CLI package."""

__version__ = "0.0.0"

from .client import ApiError, GroomNoteClient

__all__ = ["ApiError", "GroomNoteClient", "__version__"]
