from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from groomnote_cli import (
    GroomNoteClient,
    __version__,
    list_microphones,
    play_wav_bytes,
    select_microphone,
)
from groomnote_cli.streaming import (
    DirectAssemblyAIStreamingRound,
    SoundDeviceMicrophone,
    run_keyboard_round,
)
from groomnote_cli.workflow import VoiceWorkflow


APPOINTMENTS = {
    "bella": "44444444-4444-4444-8444-444444444444",
    "charlie": "55555555-5555-4555-8555-555555555555",
}


def _read_env_value(path: Path, name: str) -> str | None:
    if not path.is_file():
        return None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() != name:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        return value.replace("\\$", "$") or None
    return None


def resolve_demo_key(explicit: str | None) -> str | None:
    return explicit or os.environ.get("DEMO_API_KEY") or _read_env_value(
        Path.cwd() / ".env", "DEMO_API_KEY"
    )


def run_script(client: GroomNoteClient, case: str, play_speech: bool = False) -> dict[str, object]:
    client.create_session(APPOINTMENTS[case])
    opening_audio = client.speech("opening", f"{case}-opening")
    if play_speech:
        play_wav_bytes(opening_audio.data)
    if case == "bella":
        client.add_turn(
            "bella-turn-1",
            "Bella had a bath and brush. The next groomer should check her coat.",
        )
    else:
        client.add_turn("charlie-turn-1", "Charlie had a bath.")
    decision = client.complete_round()
    if decision["action"] == "follow_up":
        decision = client.reply(
            f"{case}-follow-up-1", "The next groomer should check the ears."
        )
    if decision["action"] != "review":
        raise RuntimeError("The API did not produce a reviewable draft.")
    review = client.review()
    completed = client.approve(review["revision"])
    note = client.get_note(completed["noteId"])
    return {
        "case": case,
        "sessionId": client.session_id,
        "openingAudioBytes": len(opening_audio.data),
        "openingAudioType": opening_audio.content_type,
        "reviewedContent": review["content"],
        "note": note,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="GroomNote AI text engineering client")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--base-url")
    parser.add_argument("--demo-key")
    parser.add_argument("--script", choices=sorted(APPOINTMENTS))
    parser.add_argument("--play-speech", action="store_true")
    parser.add_argument("--list-microphones", action="store_true")
    parser.add_argument("--microphone", help="Windows input device index or unique name fragment")
    parser.add_argument("--stream", action="store_true", help="Run direct AssemblyAI microphone STT")
    parser.add_argument(
        "--voice-workflow",
        action="store_true",
        help="Run the complete half-duplex multi-round voice workflow",
    )
    parser.add_argument(
        "--keyboard-turn",
        action="append",
        default=[],
        help="Submit a finalized engineering fallback turn; may be repeated",
    )
    args = parser.parse_args()
    args.demo_key = resolve_demo_key(args.demo_key)
    if args.version:
        print(f"GroomNote CLI {__version__}")
        return
    if args.list_microphones:
        for device in list_microphones():
            print(f"{device.index}: {device.name} ({device.sample_rate} Hz, mono PCM16)")
        return
    if not (args.base_url and args.demo_key and args.script):
        parser.error(
            "--base-url and --script are required; DEMO_API_KEY must come from "
            "--demo-key, the environment, or the repository-root .env"
        )
    if args.voice_workflow:
        client = GroomNoteClient(args.base_url, args.demo_key)
        device = select_microphone(args.microphone, list_microphones())

        def capture(mode: str):
            print(f"Starting {mode} listening round...", flush=True)
            return DirectAssemblyAIStreamingRound(
                client,
                SoundDeviceMicrophone(device),
                mode=mode,
                on_partial=lambda text: print(f"\r{text}", end="", flush=True),
                on_ready=lambda: print("Listening. Start speaking now.", flush=True),
                on_silence_confirmation=lambda: print(
                    "\nAre you finished? Use a clear end command when required."
                ),
            ).run_with_recovery()

        result = VoiceWorkflow(client, capture).run(APPOINTMENTS[args.script])
        print(json.dumps(result.__dict__, sort_keys=True))
        return
    if args.stream or args.keyboard_turn:
        client = GroomNoteClient(args.base_url, args.demo_key)
        client.create_session(APPOINTMENTS[args.script])
        if args.keyboard_turn:
            decision = run_keyboard_round(client, args.keyboard_turn)
            print(json.dumps({"mode": "keyboard", "decision": decision}, sort_keys=True))
            return
        selector: str | int | None = args.microphone
        device = select_microphone(selector, list_microphones())
        runner = DirectAssemblyAIStreamingRound(
            client,
            SoundDeviceMicrophone(device),
            on_partial=lambda text: print(f"\r{text}", end="", flush=True),
            on_ready=lambda: print("Listening. Start speaking now.", flush=True),
            on_silence_confirmation=lambda: print(
                "\nAre you finished? Say 'GroomNote, finish this round' when ready."
            ),
        )
        outcome = runner.run_with_recovery()
        print()
        print(json.dumps(outcome.__dict__, sort_keys=True))
        return
    result = run_script(
        GroomNoteClient(args.base_url, args.demo_key), args.script, play_speech=args.play_speech
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
