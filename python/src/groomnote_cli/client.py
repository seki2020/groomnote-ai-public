from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class ApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.status = status
        self.code = code


Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None], tuple[int, dict[str, Any]]]
BinaryTransport = Callable[
    [str, str, dict[str, str], dict[str, Any] | None], tuple[int, str, bytes]
]


def _urllib_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | None,
) -> tuple[int, dict[str, Any]]:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = Request(url, data=encoded, headers=headers, method=method)
    try:
        with urlopen(request, timeout=15) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        payload = json.loads(error.read().decode("utf-8"))
        return error.code, payload


def _urllib_binary_transport(
    method: str,
    url: str,
    headers: dict[str, str],
    body: dict[str, Any] | None,
) -> tuple[int, str, bytes]:
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = Request(url, data=encoded, headers=headers, method=method)
    try:
        with urlopen(request, timeout=30) as response:
            return response.status, response.headers.get_content_type(), response.read()
    except HTTPError as error:
        return error.code, error.headers.get_content_type(), error.read()


@dataclass(frozen=True)
class SpeechAudio:
    content_type: str
    data: bytes


@dataclass(frozen=True)
class SttToken:
    token: str
    round_id: str
    expires_in_seconds: int
    max_session_duration_seconds: int
    websocket_url: str


@dataclass
class GroomNoteClient:
    base_url: str
    demo_api_key: str
    transport: Transport = _urllib_transport
    binary_transport: BinaryTransport = _urllib_binary_transport
    session_id: str | None = None
    session_token: str | None = None

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        use_demo_key: bool = False,
    ) -> dict[str, Any]:
        token = self.demo_api_key if use_demo_key else self.session_token
        if not token:
            raise RuntimeError("A session must be created first.")
        status, payload = self.transport(
            method,
            f"{self.base_url.rstrip('/')}{path}",
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            body,
        )
        if status >= 400:
            error = payload.get("error", {})
            raise ApiError(status, error.get("code", "HTTP_ERROR"), error.get("message", "Request failed"))
        return payload

    def create_session(self, appointment_id: str) -> dict[str, Any]:
        payload = self._request(
            "POST", "/v1/sessions", {"appointmentId": appointment_id}, use_demo_key=True
        )
        self.session_id = payload["id"]
        self.session_token = payload["sessionToken"]
        return payload

    def add_turn(self, provider_turn_id: str, transcript: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/sessions/{self.session_id}/turns",
            {"providerTurnId": provider_turn_id, "transcript": transcript},
        )

    def stt_token(self) -> SttToken:
        payload = self._request("POST", f"/v1/sessions/{self.session_id}/stt-token", {})
        return SttToken(
            token=payload["token"],
            round_id=payload["roundId"],
            expires_in_seconds=payload["expiresInSeconds"],
            max_session_duration_seconds=payload["maxSessionDurationSeconds"],
            websocket_url=payload["websocketUrl"],
        )

    def close_stt_round(self, round_id: str) -> dict[str, Any]:
        return self._request(
            "POST", f"/v1/sessions/{self.session_id}/stt-rounds/{round_id}/close", {}
        )

    def complete_round(self) -> dict[str, Any]:
        return self._request("POST", f"/v1/sessions/{self.session_id}/complete-round", {})

    def reply(self, provider_turn_id: str, transcript: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v1/sessions/{self.session_id}/reply",
            {"providerTurnId": provider_turn_id, "transcript": transcript},
        )

    def review(self) -> dict[str, Any]:
        return self._request("POST", f"/v1/sessions/{self.session_id}/review", {})

    def approve(self, revision: int) -> dict[str, Any]:
        return self._request(
            "POST", f"/v1/sessions/{self.session_id}/approve", {"revision": revision}
        )

    def get_note(self, note_id: str) -> dict[str, Any]:
        query = urlencode({"sessionId": self.session_id})
        return self._request("GET", f"/v1/notes/{note_id}?{query}")

    def speech(self, utterance: str, request_id: str) -> SpeechAudio:
        if not (self.session_id and self.session_token):
            raise RuntimeError("A session must be created first.")
        status, content_type, data = self.binary_transport(
            "POST",
            f"{self.base_url.rstrip('/')}/v1/sessions/{self.session_id}/speech",
            {
                "Authorization": f"Bearer {self.session_token}",
                "Content-Type": "application/json",
            },
            {"requestId": request_id, "utterance": utterance},
        )
        if status >= 400:
            try:
                payload = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload = {}
            error = payload.get("error", {})
            raise ApiError(status, error.get("code", "HTTP_ERROR"), error.get("message", "Request failed"))
        if not data or not content_type.startswith("audio/"):
            raise RuntimeError("Speech endpoint returned invalid audio.")
        return SpeechAudio(content_type=content_type, data=data)
