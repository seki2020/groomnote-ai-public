import { z } from "zod";
import { identifierSchema } from "../persistence/schemas";

export const createSessionRequestSchema = z.object({ appointmentId: identifierSchema });
export const addTurnRequestSchema = z.object({
  providerTurnId: z.string().trim().min(1).max(200),
  transcript: z.string().trim().min(1).max(8_000),
});
export const replyRequestSchema = addTurnRequestSchema;
export const approveRequestSchema = z.object({ revision: z.number().int().positive() });
