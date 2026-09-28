from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlencode

from .client import GroomNoteClient, SttToken
from .stt import (
    AudioFormat,
    MicrophoneDevice,
    RoundCoordinator,
    SilenceConfirmation,
    forward_pcm_chunk,
    pcm16_rms,
)


@dataclass(frozen=True)
class StreamingOutcome:
    terminated: bool
    business_round_completed: bool
    disconnected: bool
    decision: dict[str, Any] | None
    error: str | None = None


class SoundDeviceMicrophone:
    def __init__(self, device: MicrophoneDevice, sounddevice_module: Any | None = None) -> None:
        if sounddevice_module is None:
            import sounddevice as sounddevice_module  # type: ignore[no-redef]
        self._sounddevice = sounddevice_module
        self.device = device
        self.audio_format = AudioFormat(sample_rate=device.sample_rate)
        self.audio_format.validate()
        self._stream: Any | None = None

    def start(self, on_chunk: Callable[[bytes], None]) -> None:
        if self._stream is not None:
            raise RuntimeError("The microphone is already active.")

        def callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
            del frames, time_info
            if status:
                raise RuntimeError(f"Microphone capture error: {status}")
            on_chunk(bytes(indata))

        self._sounddevice.check_input_settings(
            device=self.device.index,
            channels=1,
            dtype="int16",
            samplerate=self.device.sample_rate,
        )
        self._stream = self._sounddevice.RawInputStream(
            device=self.device.index,
            channels=1,
            dtype="int16",
            samplerate=self.device.sample_rate,
            blocksize=max(1, self.device.sample_rate // 10),
            callback=callback,
        )
        self._stream.start()

    def stop(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            stream.stop()
            stream.close()


class _WebSocketSink:
    def __init__(self, socket: Any, websocket_module: Any) -> None:
        self.socket = socket
        self.websocket_module = websocket_module

    def send_binary(self, chunk: bytes) -> None:
        self.socket.send(chunk, self.websocket_module.ABNF.OPCODE_BINARY)


class DirectAssemblyAIStreamingRound:
    def __init__(
        self,
        client: GroomNoteClient,
        microphone: SoundDeviceMicrophone,
        *,
        on_partial: Callable[[str], None] | None = None,
        on_ready: Callable[[], None] | None = None,
        on_silence_confirmation: Callable[[], None] | None = None,
        sustained_silence_seconds: float = 8.0,
        speech_rms_threshold: float = 250.0,
        websocket_module: Any | None = None,
    ) -> None:
        if websocket_module is None:
            import websocket as websocket_module  # type: ignore[no-redef]
        self.client = client
        self.microphone = microphone
        self.on_partial = on_partial or (lambda text: None)
        self.on_ready = on_ready or (lambda: None)
        self.on_silence_confirmation = on_silence_confirmation or (lambda: None)
        self.sustained_silence_seconds = sustained_silence_seconds
        self.speech_rms_threshold = speech_rms_threshold
        self.websocket_module = websocket_module

    def _url(self, credentials: SttToken) -> str:
        params = {
            "sample_rate": self.microphone.audio_format.sample_rate,
            "speech_model": "universal-3-6-pro",
            "min_turn_silence": 200,
            "max_turn_silence": 2000,
            "language_codes": json.dumps(["en"]),
            "keyterms_prompt": json.dumps([
                "GroomNote",
                "Bella",
                "groomer",
                "bath and brush",
                "coat",
                "ears",
                "prepare my note",
                "finish this round",
            ]),
            "token": credentials.token,
        }
        return f"{credentials.websocket_url}?{urlencode(params)}"

    def run_once(self) -> StreamingOutcome:
        credentials = self.client.stt_token()
        coordinator = RoundCoordinator(self.client, credentials.round_id)
        done = threading.Event()
        termination_seen = False
        disconnect_released = False
        decision: dict[str, Any] | None = None
        failure: str | None = None
        cap_timer: threading.Timer | None = None
        silence_stop = threading.Event()
        silence = SilenceConfirmation(self.sustained_silence_seconds)

        def release_disconnect() -> None:
            nonlocal disconnect_released
            if not disconnect_released and not coordinator.completed:
                coordinator.recover_from_disconnect()
                disconnect_released = True

        def terminate(socket: Any) -> None:
            self.microphone.stop()
            if socket.sock and socket.sock.connected:
                socket.send(json.dumps({"type": "Terminate"}))

        def on_open(socket: Any) -> None:
            del socket

        def on_message(socket: Any, raw: str) -> None:
            nonlocal termination_seen, decision, cap_timer
            message = json.loads(raw)
            message_type = message.get("type")
            if message_type == "Begin":
                sink = _WebSocketSink(socket, self.websocket_module)
                def handle_chunk(chunk: bytes) -> None:
                    if pcm16_rms(self.microphone.audio_format, chunk) >= self.speech_rms_threshold:
                        silence.note_activity()
                    forward_pcm_chunk(sink, self.microphone.audio_format, chunk)

                self.microphone.start(handle_chunk)
                self.on_ready()
                def watch_silence() -> None:
                    while not silence_stop.wait(0.5):
                        if silence.should_ask():
                            self.on_silence_confirmation()

                threading.Thread(target=watch_silence, daemon=True).start()
                cap_timer = threading.Timer(
                    credentials.max_session_duration_seconds,
                    lambda: terminate(socket),
                )
                cap_timer.daemon = True
                cap_timer.start()
            elif message_type == "Turn":
                update = coordinator.handle_event(message)
                self.on_partial(update.visible_text)
                if update.finalized and update.finalized.ends_round:
                    terminate(socket)
            elif message_type == "Termination":
                termination_seen = True
                silence_stop.set()
                self.microphone.stop()
                decision = coordinator.complete_after_termination()
                if decision is None:
                    release_disconnect()
                done.set()
                socket.close()
            elif message_type in {"Error", "SessionError"}:
                raise RuntimeError(str(message.get("error") or message.get("message") or message_type))

        def on_error(socket: Any, error: Any) -> None:
            nonlocal failure
            del socket
            if isinstance(error, self.websocket_module.ABNF) and (
                error.opcode == self.websocket_module.ABNF.OPCODE_CLOSE
            ):
                return
            failure = str(error)

        def on_close(socket: Any, status: Any, message: Any) -> None:
            del socket, status, message
            self.microphone.stop()
            silence_stop.set()
            if not termination_seen:
                release_disconnect()
            done.set()

        socket = self.websocket_module.WebSocketApp(
            self._url(credentials),
            on_open=on_open,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )
        try:
            socket.run_forever()
            done.wait(timeout=5)
        finally:
            if cap_timer is not None:
                cap_timer.cancel()
            silence_stop.set()
            self.microphone.stop()
            if not termination_seen:
                release_disconnect()
        return StreamingOutcome(
            terminated=termination_seen,
            business_round_completed=coordinator.completed,
            disconnected=not termination_seen,
            decision=decision,
            error=failure,
        )

    def run_with_recovery(self, max_connections: int = 3) -> StreamingOutcome:
        if max_connections < 1:
            raise ValueError("At least one connection attempt is required.")
        last: StreamingOutcome | None = None
        for _ in range(max_connections):
            last = self.run_once()
            if last.business_round_completed:
                return last
            if not last.disconnected and last.error:
                return last
        assert last is not None
        return last


def run_keyboard_round(
    client: GroomNoteClient,
    lines: list[str],
) -> dict[str, Any] | None:
    credentials = client.stt_token()
    coordinator = RoundCoordinator(client, credentials.round_id)
    try:
        for line in lines:
            coordinator.submit_keyboard(line)
            if coordinator.finish_requested:
                return coordinator.complete_after_termination()
        return None
    finally:
        if not coordinator.completed:
            coordinator.recover_from_disconnect()
