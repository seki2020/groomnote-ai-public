from __future__ import annotations

import re
import time
from array import array
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol

@dataclass(frozen=True)
class AudioFormat:
    sample_rate: int
    channels: int = 1
    sample_width_bytes: int = 2

    def validate(self) -> None:
        if not 8_000 <= self.sample_rate <= 96_000:
            raise ValueError("The microphone sample rate must be between 8000 and 96000 Hz.")
        if self.channels != 1:
            raise ValueError("AssemblyAI microphone capture must be mono.")
        if self.sample_width_bytes != 2:
            raise ValueError("AssemblyAI microphone capture must use 16-bit PCM.")

    def validate_chunk(self, chunk: bytes) -> None:
        self.validate()
        if not chunk or len(chunk) % self.sample_width_bytes:
            raise ValueError("PCM16 audio chunks must be nonempty and sample-aligned.")


@dataclass(frozen=True)
class MicrophoneDevice:
    index: int
    name: str
    sample_rate: int
    input_channels: int


def list_microphones(sounddevice_module: Any | None = None) -> list[MicrophoneDevice]:
    if sounddevice_module is None:
        import sounddevice as sounddevice_module  # type: ignore[no-redef]

    devices: list[MicrophoneDevice] = []
    for index, raw in enumerate(sounddevice_module.query_devices()):
        channels = int(raw.get("max_input_channels", 0))
        if channels < 1:
            continue
        rate = int(round(float(raw.get("default_samplerate", 0))))
        audio_format = AudioFormat(sample_rate=rate)
        audio_format.validate()
        sounddevice_module.check_input_settings(
            device=index,
            channels=1,
            dtype="int16",
            samplerate=rate,
        )
        devices.append(MicrophoneDevice(index, str(raw.get("name", index)), rate, channels))
    return devices


def select_microphone(
    selector: str | int | None,
    devices: Iterable[MicrophoneDevice],
) -> MicrophoneDevice:
    choices = list(devices)
    if not choices:
        raise RuntimeError("No compatible Windows input microphone was found.")
    if selector is None:
        return choices[0]
    if isinstance(selector, int) or str(selector).isdigit():
        index = int(selector)
        matches = [device for device in choices if device.index == index]
    else:
        needle = str(selector).casefold()
        matches = [device for device in choices if needle in device.name.casefold()]
    if len(matches) != 1:
        raise ValueError("The microphone selector must match exactly one input device.")
    return matches[0]


_END_COMMAND = re.compile(
    r"^(?:okay\s+)?(?:groom\s*note\s+)?(?:finish\s+(?:this|the)\s+round|"
    r"prepare\s+my\s+note|that(?:s|\s+is)\s+everything)(?:\s+please)?$",
)


def normalize_spoken_command(text: str) -> str:
    normalized = text.casefold().replace("’", "'")
    normalized = re.sub(r"[^a-z0-9'\s]", " ", normalized)
    normalized = normalized.replace("'", "")
    return " ".join(normalized.split())


def is_round_end_command(text: str) -> bool:
    return bool(_END_COMMAND.fullmatch(normalize_spoken_command(text)))


@dataclass(frozen=True)
class FinalizedTurn:
    turn_order: int
    transcript: str
    ends_round: bool


@dataclass(frozen=True)
class TranscriptUpdate:
    visible_text: str
    finalized: FinalizedTurn | None = None
    duplicate: bool = False


@dataclass
class TranscriptAccumulator:
    finalized_by_order: dict[int, str] = field(default_factory=dict)
    partial_by_order: dict[int, str] = field(default_factory=dict)

    def consume(self, event: dict[str, Any]) -> TranscriptUpdate:
        if event.get("type") != "Turn":
            return TranscriptUpdate(self.visible_text)
        order = event.get("turn_order")
        transcript = str(event.get("transcript", "")).strip()
        if not isinstance(order, int) or order < 0:
            raise ValueError("A Turn event requires a nonnegative integer turn_order.")
        if not event.get("end_of_turn", False):
            self.partial_by_order[order] = transcript
            return TranscriptUpdate(self.visible_text)
        self.partial_by_order.pop(order, None)
        if order in self.finalized_by_order:
            return TranscriptUpdate(self.visible_text, duplicate=True)
        if not transcript:
            return TranscriptUpdate(self.visible_text)
        self.finalized_by_order[order] = transcript
        final = FinalizedTurn(order, transcript, is_round_end_command(transcript))
        return TranscriptUpdate(self.visible_text, finalized=final)

    @property
    def visible_text(self) -> str:
        combined = {**self.finalized_by_order, **self.partial_by_order}
        return " ".join(combined[index] for index in sorted(combined) if combined[index]).strip()

    @property
    def finalized_transcripts(self) -> list[str]:
        return [self.finalized_by_order[index] for index in sorted(self.finalized_by_order)]


@dataclass
class SilenceConfirmation:
    sustained_seconds: float = 8.0
    clock: Callable[[], float] = time.monotonic
    last_activity_at: float = field(init=False)
    prompted: bool = False

    def __post_init__(self) -> None:
        if self.sustained_seconds <= 0:
            raise ValueError("Sustained silence must be positive.")
        self.last_activity_at = self.clock()

    def note_activity(self) -> None:
        self.last_activity_at = self.clock()
        self.prompted = False

    def should_ask(self) -> bool:
        if self.prompted or self.clock() - self.last_activity_at < self.sustained_seconds:
            return False
        self.prompted = True
        return True


class RoundApi(Protocol):
    def add_turn(self, provider_turn_id: str, transcript: str) -> dict[str, Any]: ...
    def complete_round(self) -> dict[str, Any]: ...
    def close_stt_round(self, round_id: str) -> dict[str, Any]: ...


@dataclass
class RoundCoordinator:
    client: RoundApi
    round_id: str
    accumulator: TranscriptAccumulator = field(default_factory=TranscriptAccumulator)
    finish_requested: bool = False
    completed: bool = False

    def handle_event(self, event: dict[str, Any]) -> TranscriptUpdate:
        update = self.accumulator.consume(event)
        if update.finalized is not None:
            provider_id = f"{self.round_id}:{update.finalized.turn_order}"
            self.client.add_turn(provider_id, update.finalized.transcript)
            self.finish_requested = self.finish_requested or update.finalized.ends_round
        return update

    def submit_keyboard(self, transcript: str) -> TranscriptUpdate:
        text = transcript.strip()
        if not text:
            raise ValueError("Keyboard fallback text cannot be empty.")
        order = max(
            [*self.accumulator.finalized_by_order, *self.accumulator.partial_by_order, -1]
        ) + 1
        event = {
            "type": "Turn",
            "turn_order": order,
            "end_of_turn": True,
            "transcript": text,
        }
        return self.handle_event(event)

    def complete_after_termination(self) -> dict[str, Any] | None:
        if not self.finish_requested or self.completed:
            return None
        result = self.client.complete_round()
        self.completed = True
        return result

    def recover_from_disconnect(self) -> dict[str, Any] | None:
        if self.completed:
            return None
        return self.client.close_stt_round(self.round_id)


class AudioSink(Protocol):
    def send_binary(self, chunk: bytes) -> None: ...


def forward_pcm_chunk(sink: AudioSink, audio_format: AudioFormat, chunk: bytes) -> None:
    audio_format.validate_chunk(chunk)
    sink.send_binary(chunk)


def pcm16_rms(audio_format: AudioFormat, chunk: bytes) -> float:
    audio_format.validate_chunk(chunk)
    samples = array("h")
    samples.frombytes(chunk)
    if not samples:
        return 0.0
    return (sum(sample * sample for sample in samples) / len(samples)) ** 0.5
