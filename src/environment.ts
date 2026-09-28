export const expectedSecretNames = [
  "ASSEMBLYAI_API_KEY",
  "DEMO_API_KEY",
] as const;

export type SecretPresence = Record<
  (typeof expectedSecretNames)[number],
  boolean
>;

export function inspectSecretPresence(
  environment: Readonly<Record<string, string | undefined>>,
): SecretPresence {
  return Object.fromEntries(
    expectedSecretNames.map((name) => [
      name,
      typeof environment[name] === "string" && environment[name]!.trim().length > 0,
    ]),
  ) as SecretPresence;
}

