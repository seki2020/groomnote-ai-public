import type { BusinessController } from "../business/controller";
import type { SttController } from "../stt/controller";
import type { TtsController } from "../tts/controller";
import type { HalfDuplexGate } from "../audio/halfDuplex";

export type OrchestrationState = "IDLE" | "STARTING" | "SPEAKING_OPENING" | "LISTENING_REPORT" | "FINALIZING_REPORT" | "ANALYZING" | "SPEAKING_FOLLOWUP" | "LISTENING_FOLLOWUP" | "FINALIZING_FOLLOWUP" | "SPEAKING_REVIEW" | "LISTENING_DECISION" | "SPEAKING_CORRECTION_PROMPT" | "LISTENING_CORRECTION" | "PROCESSING_CORRECTION" | "SPEAKING_CONFIRMATION" | "LISTENING_CONFIRMATION" | "FINALIZING_DECISION" | "SAVING" | "SPEAKING_SUCCESS" | "COMPLETED" | "CANCELLED" | "REVIEW_CONTROLS" | "EXPERIMENT_COMPLETE" | "RECOVERABLE_ERROR" | "MANUAL";
export interface OrchestrationOptions { experimentOnly?: boolean; voiceAssisted?: boolean; silenceMs?: number; forceOpeningFailure?: boolean }
export interface OrchestrationSnapshot { state: OrchestrationState; ownsWorkflow: boolean; message: string }
export interface OrchestrationPorts {
  stt: Pick<SttController, "snapshot" | "start" | "finish" | "completeBufferedCapture" | "discardBufferedCapture" | "acknowledgeBufferedCaptureConsumed">;
  tts: Pick<TtsController, "snapshot" | "unlock" | "play">;
  business: Pick<BusinessController, "snapshot" | "canAnalyze" | "recordRound" | "analyze" | "correct" | "approve" | "cancel">;
  gate: Pick<HalfDuplexGate, "active">;
}
