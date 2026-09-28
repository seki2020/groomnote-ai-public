from __future__ import annotations

import argparse
import json

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


APPOINTMENTS = {
    "bella": "44444444-4444-4444-8444-444444444444",
    "charlie": "55555555-5555-4555-8555-555555555555",
}


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
        "--keyboard-turn",
        action="append",
        default=[],
        help="Submit a finalized engineering fallback turn; may be repeated",
    )
    args = parser.parse_args()
    if args.version:
        print(f"GroomNote CLI {__version__}")
        return
    if args.list_microphones:
        for device in list_microphones():
            print(f"{device.index}: {device.name} ({device.sample_rate} Hz, mono PCM16)")
        return
    if not (args.base_url and args.demo_key and args.script):
        parser.error("--base-url, --demo-key, and --script are required unless --version is used")
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
