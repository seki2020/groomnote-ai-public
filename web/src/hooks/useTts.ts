import { useEffect, useMemo, useState } from "react";
import type { BrowserSession } from "../services/api";
import { HalfDuplexGate } from "../services/audio/halfDuplex";
import { HttpSpeechApi } from "../services/tts/api";
import { TtsController, type TtsSnapshot, type TtsTarget } from "../services/tts/controller";
import { WebAudioPlayer } from "../services/tts/player";

const idle: TtsSnapshot = { state: "IDLE", ready: false, error: "", current: null, providerCalls: 0 };

export function useTts(session: BrowserSession | null, baseUrl: string, fetcher: typeof fetch, gate: HalfDuplexGate) {
  const [snapshot, setSnapshot] = useState<TtsSnapshot>(idle);
  const controller = useMemo(() => session ? new TtsController(session, new HttpSpeechApi(baseUrl, fetcher), new WebAudioPlayer(), gate, setSnapshot) : null,
    [session, baseUrl, fetcher, gate]);
  useEffect(() => {
    setSnapshot(controller?.snapshot ?? idle);
    return () => { if (controller) void controller.dispose(); };
  }, [controller]);
  return {
    snapshot: controller ? snapshot : idle,
    unlock: () => controller?.unlock(),
    play: (target: TtsTarget) => controller?.play(target),
    autoPlay: (target: TtsTarget) => controller?.autoPlay(target),
    stop: () => controller?.stop(),
  };
}
