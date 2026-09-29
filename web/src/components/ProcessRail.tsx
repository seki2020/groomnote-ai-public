export type ProcessStep = "session" | "grooming" | "recap" | "saved";

const steps: { id: ProcessStep; label: string }[] = [
  { id: "session", label: "Session" },
  { id: "grooming", label: "Grooming" },
  { id: "recap", label: "Voice recap" },
  { id: "saved", label: "Saved note" },
];

export function ProcessRail({ current }: { current: ProcessStep }) {
  const currentIndex = steps.findIndex(step => step.id === current);
  return <ol className="process-rail" aria-label="Process progress">
    {steps.map((step, index) => {
      const state = index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming";
      return <li className={`process-step process-step--${state}`} key={step.id} aria-current={state === "current" ? "step" : undefined}>
        <span className="process-step__marker" aria-hidden="true">{index < currentIndex ? <CheckCircle size={19} weight="fill" /> : String(index + 1).padStart(2, "0")}</span>
        <span className="process-step__label">{step.label}</span>
      </li>;
    })}
  </ol>;
}
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
