import { useEffect, useMemo, useState } from "react";
import type { BrowserSession } from "../services/api";
import { openMicrophone } from "../services/audio/microphone";
import type { HalfDuplexGate } from "../services/audio/halfDuplex";
import { SttController, type SttSnapshot } from "../services/stt/controller";
import { HttpSttWorkerApi } from "../services/stt/workerApi";

const idle: SttSnapshot = { state: "IDLE", microphone: "", partial: "", finalTurns: [], persisted: 0, completedRoundId: null, round: "NONE", error: "" };

export function useStt(session: BrowserSession | null, baseUrl: string, fetcher: typeof fetch, gate?: HalfDuplexGate) {
  const [snapshot, setSnapshot] = useState<SttSnapshot>(idle);
  const controller = useMemo(() => session ? new SttController(
    session,
    new HttpSttWorkerApi(baseUrl, fetcher),
    openMicrophone,
    url => new WebSocket(url),
    setSnapshot,
    gate,
  ) : null, [session, baseUrl, fetcher, gate]);
  useEffect(() => () => { if (controller) void controller.dispose(); }, [controller]);
  return { snapshot: controller ? snapshot : idle, start: () => controller?.start(), finish: () => controller?.finish() };
}
