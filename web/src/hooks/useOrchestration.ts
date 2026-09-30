import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { BusinessController } from "../services/business/controller";
import type { SttController, SttSnapshot } from "../services/stt/controller";
import type { TtsController } from "../services/tts/controller";
import type { HalfDuplexGate } from "../services/audio/halfDuplex";
import { OrchestrationController } from "../services/orchestration/controller";
import type { OrchestrationSnapshot } from "../services/orchestration/types";

export function useOrchestration(stt: SttController | null, tts: TtsController | null, business: BusinessController | null, gate: HalfDuplexGate, capture: SttSnapshot, unlock: () => Promise<void>, create: () => Promise<void>) {
  const query = new URLSearchParams(window.location.search);
  const experimentOnly = query.get("w07Experiment") === "1";
  const voiceAssisted = query.get("voiceAssisted") === "1";
  const forceOpeningFailure = import.meta.env.DEV && query.get("forceAutoFailure") === "opening";
  const [snapshot, setSnapshot] = useState<OrchestrationSnapshot>({ state: "IDLE", ownsWorkflow: false, message: "" });
  const [requested, setRequested] = useState(false);
  const starting = useRef(false);
  const mounted = useRef(false);
  const mountedController = useRef<OrchestrationController | null>(null);
  const controller = useMemo(() => stt && tts && business ? new OrchestrationController({ stt, tts, business, gate }, setSnapshot, { experimentOnly, voiceAssisted, forceOpeningFailure }) : null, [stt, tts, business, gate, experimentOnly, voiceAssisted, forceOpeningFailure]);
  useEffect(() => { controller?.observe(capture); }, [controller, capture]);
  useEffect(() => { if (requested && controller) void controller.start(); }, [requested, controller]);
  useEffect(() => {
    mounted.current = true; mountedController.current = controller;
    return () => {
      mounted.current = false;
      // StrictMode reattaches synchronously. Only a real detach/session change
      // relinquishes ownership; effect replay must not cancel or repeat Start.
      queueMicrotask(() => { if (!mounted.current || mountedController.current !== controller) controller?.handoff(); });
    };
  }, [controller]);
  async function start() {
    if (starting.current) return;
    starting.current = true;
    try {
      // Invoke unlock in the real Start event, before session/network awaits.
      await unlock();
      if (controller) await controller.start();
      else { setRequested(true); await create(); }
    } catch (error) {
      setSnapshot({ state: "RECOVERABLE_ERROR", ownsWorkflow: false, message: error instanceof Error ? error.message : "Start failed. Use the manual controls." });
    } finally { starting.current = false; }
  }
  function manualClick(event: MouseEvent<HTMLElement>) {
    if (snapshot.ownsWorkflow && event.target instanceof Element && event.target.closest("button:not([data-orchestration])")) controller?.handoff();
  }
  return { snapshot, start, manualClick, resumeReview: () => controller?.resumeReview(), manualReview: (action: "correct" | "repeat" | "save" | "cancel") => controller?.manualReview(action) };
}
