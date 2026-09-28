from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Literal

from .audio import play_wav_bytes
from .client import ApiError, GroomNoteClient, SpeechAudio
from .streaming import StreamingOutcome


ReviewIntent = Literal["approve", "correct", "unknown"]


def classify_review_intent(text: str) -> ReviewIntent:
    normalized = " ".join(re.sub(r"[^a-z0-9\s]", " ", text.casefold()).split())
    if re.fullmatch(
        r"(?:yes\s+)?(?:approve|approved|save(?:\s+it|\s+the\s+note)?|looks\s+good|"
        r"that(?:s|\s+is)\s+correct)(?:\s+please)?",
        normalized,
    ):
        return "approve"
    if re.match(
        r"^(?:correction|correct|change|actually|add|remove|replace)\s+\S+",
        normalized,
    ):
        return "correct"
    return "unknown"


@dataclass
class HalfDuplexGate:
    active: str | None = None

    def run(self, channel: Literal["tts", "stt"], operation: Callable[[], Any]) -> Any:
        if self.active is not None:
            raise RuntimeError(f"Cannot start {channel} while {self.active} is active.")
        self.active = channel
        try:
            return operation()
        finally:
            self.active = None


@dataclass(frozen=True)
class WorkflowResult:
    note: dict[str, Any]
    revision: int
    follow_up_used: bool
    corrections: int


CaptureRound = Callable[[str], StreamingOutcome]
AudioPlayer = Callable[[SpeechAudio], None]


def default_audio_player(audio: SpeechAudio) -> None:
    if audio.content_type not in {"audio/wav", "audio/x-wav"}:
        raise RuntimeError(f"Unsupported Windows playback type: {audio.content_type}")
    play_wav_bytes(audio.data)


class VoiceWorkflow:
    def __init__(
        self,
        client: GroomNoteClient,
        capture_round: CaptureRound,
        *,
        play_audio: AudioPlayer = default_audio_player,
        max_corrections: int = 2,
        tts_attempts: int = 3,
        gate: HalfDuplexGate | None = None,
    ) -> None:
        if max_corrections < 0:
            raise ValueError("The correction limit cannot be negative.")
        if tts_attempts < 1:
            raise ValueError("At least one TTS attempt is required.")
        self.client = client
        self.capture_round = capture_round
        self.play_audio = play_audio
        self.max_corrections = max_corrections
        self.tts_attempts = tts_attempts
        self.gate = gate or HalfDuplexGate()

    def _speak(self, utterance: str) -> None:
        request_id = f"stage08-{utterance}-{uuid.uuid4()}"
        last_error: Exception | None = None
        for attempt in range(self.tts_attempts):
            try:
                audio = self.client.speech(utterance, request_id)
                break
            except Exception as error:
                last_error = error
                if attempt + 1 < self.tts_attempts:
                    time.sleep(0.5)
        else:
            assert last_error is not None
            raise RuntimeError(
                f"TTS failed after {self.tts_attempts} attempts: {last_error}"
            ) from last_error
        self.gate.run("tts", lambda: self.play_audio(audio))

    def _capture(self, mode: str) -> StreamingOutcome:
        outcome = self.gate.run("stt", lambda: self.capture_round(mode))
        if outcome.error:
            raise RuntimeError(f"STT failed: {outcome.error}")
        if not outcome.terminated or outcome.decision is None:
            raise RuntimeError("STT ended without a completed response.")
        return outcome

    def run(self, appointment_id: str) -> WorkflowResult:
        self.client.create_session(appointment_id)
        self._speak("opening")
        decision = self._capture("initial").decision
        assert decision is not None
        follow_up_used = decision.get("action") == "follow_up"
        if follow_up_used:
            self._speak("follow_up")
            decision = self._capture("follow_up").decision
            assert decision is not None
        if decision.get("action") != "review":
            raise RuntimeError("The analysis did not produce a reviewable draft.")

        corrections = 0
        while True:
            review = self.client.review()
            self._speak("summary")
            response = self._capture("review").decision
            assert response is not None
            transcript = str(response.get("transcript", "")).strip()
            intent = classify_review_intent(transcript)
            if intent == "approve":
                completed = self.client.approve(review["revision"])
                note = self.client.get_note(completed["noteId"])
                self._speak("save_confirmation")
                return WorkflowResult(note, review["revision"], follow_up_used, corrections)
            if intent != "correct":
                raise RuntimeError("Review response was neither a clear approval nor a correction.")
            if corrections >= self.max_corrections:
                raise RuntimeError("The correction limit was reached.")
            try:
                decision = self.client.correct(
                    f"spoken-correction-{uuid.uuid4()}", transcript
                )
            except ApiError as error:
                if error.code != "ANALYSIS_UNAVAILABLE":
                    raise
                continue
            if decision.get("action") != "review":
                raise RuntimeError("The correction did not produce a new reviewable draft.")
            corrections += 1
