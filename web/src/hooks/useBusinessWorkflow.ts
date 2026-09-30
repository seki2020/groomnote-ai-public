import { useEffect, useMemo, useState } from "react";
import type { BrowserSession } from "../services/api";
import { HttpBusinessApi } from "../services/business/api";
import { BusinessController, type BusinessSnapshot } from "../services/business/controller";
import type { SttSnapshot } from "../services/stt/controller";

const idle: BusinessSnapshot = { phase: "COLLECTING", backendState: "COLLECTING", question: "", draft: null, transcriptRounds: [], error: "", noteId: null, savedNote: null, reviewedRevision: null, saveStatus: "NONE" };

export function useBusinessWorkflow(session: BrowserSession | null, stt: SttSnapshot, baseUrl: string, fetcher: typeof fetch) {
  const [snapshot, setSnapshot] = useState<BusinessSnapshot>(idle);
  const controller = useMemo(() => session ? new BusinessController(session, new HttpBusinessApi(baseUrl, fetcher), setSnapshot) : null, [session, baseUrl, fetcher]);
  useEffect(() => {
    if (controller && stt.state === "CLOSED" && stt.captureMode === "business" && stt.completedRoundId) controller.recordRound(stt.completedRoundId, stt.finalTurns);
  }, [controller, stt]);
  function analysisRound() {
    // A silence-confirmation command can close an empty new round. Manual
    // recovery still needs the earlier persisted report/answer fragment.
    if (controller && stt.state === "CLOSED" && stt.captureMode === "business" && stt.persisted === 0) {
      const rounds = controller.snapshot.transcriptRounds;
      for (let index = rounds.length - 1; index >= 0; index--) {
        if (rounds[index].turns.length) return { id: rounds[index].roundId, persisted: rounds[index].turns.length };
      }
    }
    return { id: stt.completedRoundId, persisted: stt.persisted };
  }
  return {
    controller,
    snapshot: controller ? snapshot : idle,
    canStartListening: () => controller?.canStartListening() ?? false,
    canAnalyze: () => { const round = analysisRound(); return controller?.canAnalyze(round.id, round.persisted) ?? false; },
    analyze: () => controller?.analyze(analysisRound().id),
    resumeReview: () => controller?.resumeReview(),
    correct: (transcript: string, roundId: string) => controller?.correct(transcript, roundId),
    approve: () => controller?.approve(),
    retrySavedNoteVerification: () => controller?.retrySavedNoteVerification(),
    cancel: () => controller?.cancel(),
    canStartReviewCapture: () => controller?.canStartReviewCapture() ?? false,
  };
}
