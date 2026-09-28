from __future__ import annotations

from collections.abc import Callable


def play_wav_bytes(data: bytes, player: Callable[[bytes], None] | None = None) -> None:
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("Windows playback requires RIFF/WAVE audio.")
    if player is None:
        import winsound

        player = lambda value: winsound.PlaySound(value, winsound.SND_MEMORY)
    player(data)
