import { z } from "zod";

export const identifierSchema = z.uuid();

export const petInputSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(120),
  breed: z.string().trim().min(1).max(120).nullable(),
  distinguishingDetails: z.string().trim().min(1).max(500).nullable(),
});

export const appointmentInputSchema = z.object({
  id: identifierSchema,
  petId: identifierSchema,
  scheduledAt: z.iso.datetime(),
  status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
});

export const handoverContentSchema = z.object({
  petName: z.string().trim().min(1),
  servicesCompleted: z.array(z.string().trim().min(1)),
  nextVisitInstructions: z.array(z.string().trim().min(1)),
  breed: z.string().nullable().optional(),
  identityStatus: z.enum(["matched", "ambiguous", "unknown"]).optional(),
  servicesNotCompleted: z.array(z.string()).optional(),
  groomingDetails: z.array(z.string()).optional(),
  ownerRequests: z.array(z.string()).optional(),
  observedBehavior: z.array(z.string()).optional(),
  behaviorTrigger: z.array(z.string()).optional(),
  handlingAction: z.array(z.string()).optional(),
  observedOutcome: z.array(z.string()).optional(),
  unresolvedItems: z.array(z.string()).optional(),
  fullInternalHandover: z.string().optional(),
});

export type PetInput = z.infer<typeof petInputSchema>;
export type AppointmentInput = z.infer<typeof appointmentInputSchema>;
export type HandoverContent = z.infer<typeof handoverContentSchema>;

export function serializeHandoverContent(content: HandoverContent): string {
  return JSON.stringify(handoverContentSchema.parse(content));
}

export function deserializeHandoverContent(serialized: string): HandoverContent {
  return handoverContentSchema.parse(JSON.parse(serialized));
}
