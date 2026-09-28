import { z } from "zod";

export const runtimeConfigSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]),
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

export function validateRuntimeConfig(input: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(input);
}

