import { z } from "zod";
import type { HandoverContent } from "../persistence/schemas";

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;

const nullableString = z.string().nullable();
const stringList = z.array(z.string());

export const groomingExtractionSchema = z.object({
  pet_name: z.string().min(1),
  breed: nullableString,
  identity_status: z.enum(["matched", "ambiguous", "unknown"]),
  services_completed: stringList,
  services_not_completed: stringList,
  grooming_details: stringList,
  owner_requests: stringList,
  observed_behavior: stringList,
  behavior_trigger: stringList,
  handling_action: stringList,
  observed_outcome: stringList,
  next_visit_instructions: stringList,
  unresolved_items: stringList,
  full_internal_handover: z.string(),
  concise_spoken_summary: z.string().min(1).max(900),
  needs_follow_up: z.boolean(),
  follow_up_question: nullableString,
});

export type GroomingExtraction = z.infer<typeof groomingExtractionSchema>;

export const groomingJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    pet_name: { type: "string", minLength: 1 },
    breed: { type: ["string", "null"] },
    identity_status: { type: "string", enum: ["matched", "ambiguous", "unknown"] },
    services_completed: { type: "array", items: { type: "string" } },
    services_not_completed: { type: "array", items: { type: "string" } },
    grooming_details: { type: "array", items: { type: "string" } },
    owner_requests: { type: "array", items: { type: "string" } },
    observed_behavior: { type: "array", items: { type: "string" } },
    behavior_trigger: { type: "array", items: { type: "string" } },
    handling_action: { type: "array", items: { type: "string" } },
    observed_outcome: { type: "array", items: { type: "string" } },
    next_visit_instructions: { type: "array", items: { type: "string" } },
    unresolved_items: { type: "array", items: { type: "string" } },
    full_internal_handover: { type: "string" },
    concise_spoken_summary: { type: "string", minLength: 1, maxLength: 900 },
    needs_follow_up: { type: "boolean" },
    follow_up_question: { type: ["string", "null"] },
  },
  required: [
    "pet_name",
    "breed",
    "identity_status",
    "services_completed",
    "services_not_completed",
    "grooming_details",
    "owner_requests",
    "observed_behavior",
    "behavior_trigger",
    "handling_action",
    "observed_outcome",
    "next_visit_instructions",
    "unresolved_items",
    "full_internal_handover",
    "concise_spoken_summary",
    "needs_follow_up",
    "follow_up_question",
  ],
} as const;

export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type AnalysisFailureStage = "provider" | "schema" | "semantic" | "grounding";
type GroundingFailureReason = "tool_context_as_service" | "unsupported_completed_service";
type GroundingServiceCategory = "bath" | "brush" | "ear_cleaning" | "nail_trim" | "tool" | "other";

class GroundingValidationError extends Error {
  constructor(
    readonly reason: GroundingFailureReason,
    readonly serviceCategory: GroundingServiceCategory,
  ) {
    super("Grounding validation rejected a completed service.");
    this.name = "GroundingValidationError";
  }
}

export class AnalysisUnavailableError extends Error {
  constructor(
    cause?: unknown,
    readonly failureStage: AnalysisFailureStage = "provider",
  ) {
    super("Workers AI returned invalid structured grooming output.", { cause });
    this.name = "AnalysisUnavailableError";
  }
}

export function safeAnalysisFailureDiagnostics(error: AnalysisUnavailableError) {
  const cause = error.cause;
  const candidate = typeof cause === "object" && cause !== null
    ? cause as { name?: unknown; status?: unknown; statusCode?: unknown }
    : undefined;
  const causeName = cause instanceof z.ZodError
    ? "ZodError"
    : cause instanceof Error
      ? "Error"
      : typeof cause;
  const status = typeof candidate?.status === "number"
    ? candidate.status
    : candidate?.statusCode;
  return {
    stage: error.failureStage,
    causeName,
    ...(typeof status === "number" && status >= 400 && status <= 599 ? { causeStatus: status } : {}),
    ...(cause instanceof z.ZodError ? { schemaIssueCount: cause.issues.length } : {}),
    ...(cause instanceof GroundingValidationError
      ? { groundingReason: cause.reason, serviceCategory: cause.serviceCategory }
      : {}),
  };
}

export type AnalysisInput = {
  petName: string;
  breed: string | null;
  transcripts: readonly string[];
  hasFollowUpAnswer: boolean;
  correctionInstruction?: string;
  currentDraft?: HandoverContent;
};

const systemPrompt = "PRIVATE_PROMPT_NOT_INCLUDED";

const correctionPrompt = "PRIVATE_PROMPT_NOT_INCLUDED";

function responsePayload(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "response" in value) {
    return (value as { response: unknown }).response;
  }
  return value;
}

function validateSemanticRules(extraction: GroomingExtraction): GroomingExtraction {
  if (extraction.needs_follow_up && !extraction.follow_up_question?.trim()) {
    throw new Error("A follow-up decision requires one question.");
  }
  if (!extraction.needs_follow_up && extraction.follow_up_question !== null) {
    throw new Error("A complete extraction must not include a follow-up question.");
  }
  const completed = new Set(extraction.services_completed.map((service) => service.trim().toLowerCase()));
  const contradictory = extraction.services_not_completed.find((service) =>
    completed.has(service.trim().toLowerCase()),
  );
  if (contradictory) {
    throw new Error(`A service cannot be both completed and not completed: ${contradictory}`);
  }
  return extraction;
}

function correctionExplicitlyAddsNailTrim(correctionInstruction?: string): boolean {
  if (!correctionInstruction) return false;
  const nailTrim = String.raw`(?:the\s+)?nails?\s+(?:trim|trimming|clip|clipping)`;
  const positiveAddition = new RegExp(String.raw`\b(?:add|include)\s+${nailTrim}\b`, "i");
  const negatedAddition = new RegExp(String.raw`\b(?:do not|don't|never|not)\s+(?:add|include)\s+${nailTrim}\b`, "i");
  const explicitlyNotCompleted = new RegExp(
    String.raw`(?:\b${nailTrim}\b[^.!?]{0,40}\b(?:not completed|not done|not performed|unfinished)\b|\b(?:not completed|not done|not performed|unfinished)\b[^.!?]{0,40}\b${nailTrim}\b)`,
    "i",
  );
  return positiveAddition.test(correctionInstruction) &&
    !negatedAddition.test(correctionInstruction) &&
    !explicitlyNotCompleted.test(correctionInstruction);
}

function groundingServiceCategory(service: string): GroundingServiceCategory {
  const normalized = service.trim().toLowerCase();
  if (normalized === "bath") return "bath";
  if (normalized === "brush") return "brush";
  if (normalized === "ear cleaning") return "ear_cleaning";
  if (/^nail(?:s)? trimm?(?:ing)?$/.test(normalized)) return "nail_trim";
  if (["dryer", "clippers", "scissors", "grooming table"].includes(normalized)) return "tool";
  return "other";
}

function validateGrounding(
  extraction: GroomingExtraction,
  transcripts: readonly string[],
  correctionInstruction?: string,
): GroomingExtraction {
  const source = transcripts.join(" ").toLowerCase();
  for (const service of extraction.services_completed) {
    const normalized = service.toLowerCase();
    if (["dryer", "clippers", "scissors", "grooming table"].includes(normalized)) {
      throw new GroundingValidationError("tool_context_as_service", "tool");
    }
    const supported =
      (normalized === "bath" && /\bbath(?:ed)?\b/.test(source)) ||
      (normalized === "brush" && /\bbrush(?:ed|ing)?\b/.test(source)) ||
      (normalized === "ear cleaning" && /\bclean(?:ed|ing)?\s+(?:(?:his|her|their|the)\s+)?ears?\b/.test(source)) ||
      (/^nail(?:s)? trimm?(?:ing)?$/.test(normalized) &&
        (/\btrim(?:med|ming)?\s+(?:(?:his|her|their|the)\s+)?nails?\b/.test(source) ||
          /\bnails?\s+(?:(?:were|was)\s+)?trimmed\b/.test(source) ||
          correctionExplicitlyAddsNailTrim(correctionInstruction))) ||
      (!/^nail(?:s)? trimm?(?:ing)?$/.test(normalized) && source.includes(normalized));
    if (!supported) {
      throw new GroundingValidationError("unsupported_completed_service", groundingServiceCategory(service));
    }
  }
  return extraction;
}

export class WorkersAIAnalyzer {
  constructor(private readonly ai: AiRunner) {}

  async analyze(input: AnalysisInput): Promise<GroomingExtraction> {
    // Public technical showcase: the owner's private model instructions are omitted.
    throw new Error("PRIVATE_PROMPT_NOT_INCLUDED: this showcase cannot run live analysis.");

    const prompt = input.correctionInstruction && input.currentDraft ? correctionPrompt : systemPrompt;
    const userPayload = {
      known_identity: { pet_name: input.petName, breed: input.breed },
      transcript_turns: input.transcripts,
      follow_up_already_answered: input.hasFollowUpAnswer,
      correction_instruction: input.correctionInstruction ?? null,
      current_draft: input.currentDraft ?? null,
    };
    let lastError: unknown;
    let lastFailureStage: AnalysisFailureStage = "provider";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: unknown;
      try {
        response = await this.ai.run(WORKERS_AI_MODEL, {
          messages: [
            { role: "system", content: "PRIVATE_PROMPT_NOT_INCLUDED" },
            {
              role: "user",
              content: JSON.stringify(userPayload),
            },
          ],
          response_format: { type: "json_schema", json_schema: groomingJsonSchema },
          temperature: 0,
          max_tokens: 1_200,
        });
      } catch (error) {
        lastError = error;
        lastFailureStage = "provider";
        continue;
      }

      let extraction: GroomingExtraction;
      try {
        extraction = groomingExtractionSchema.parse(responsePayload(response));
      } catch (error) {
        lastError = error;
        lastFailureStage = "schema";
        continue;
      }
      try {
        extraction = validateSemanticRules(extraction);
      } catch (error) {
        lastError = error;
        lastFailureStage = "semantic";
        continue;
      }
      try {
        return validateGrounding(extraction, input.transcripts, input.correctionInstruction);
      } catch (error) {
        lastError = error;
        lastFailureStage = "grounding";
      }
    }
    throw new AnalysisUnavailableError(lastError, lastFailureStage);
  }
}

export function extractionToHandover(extraction: GroomingExtraction): HandoverContent {
  return {
    petName: extraction.pet_name,
    breed: extraction.breed,
    identityStatus: extraction.identity_status,
    servicesCompleted: extraction.services_completed,
    servicesNotCompleted: extraction.services_not_completed,
    groomingDetails: extraction.grooming_details,
    ownerRequests: extraction.owner_requests,
    observedBehavior: extraction.observed_behavior,
    behaviorTrigger: extraction.behavior_trigger,
    handlingAction: extraction.handling_action,
    observedOutcome: extraction.observed_outcome,
    nextVisitInstructions: extraction.next_visit_instructions,
    unresolvedItems: extraction.unresolved_items,
    fullInternalHandover: extraction.full_internal_handover,
  };
}
