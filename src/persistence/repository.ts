import {
  appointmentInputSchema,
  deserializeHandoverContent,
  handoverContentSchema,
  identifierSchema,
  petInputSchema,
  serializeHandoverContent,
  type AppointmentInput,
  type HandoverContent,
  type PetInput,
} from "./schemas";

export type PetRecord = PetInput & { createdAt: string };

export async function createPet(db: D1Database, input: PetInput): Promise<PetRecord> {
  const pet = petInputSchema.parse(input);
  await db
    .prepare(
      `INSERT INTO pets (id, name, breed, distinguishing_details)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(pet.id, pet.name, pet.breed, pet.distinguishingDetails)
    .run();
  const stored = await getPet(db, pet.id);
  if (!stored) throw new Error("Pet insert did not produce a row.");
  return stored;
}

export async function getPet(db: D1Database, id: string): Promise<PetRecord | null> {
  const validId = identifierSchema.parse(id);
  const row = await db
    .prepare(
      `SELECT id, name, breed, distinguishing_details AS distinguishingDetails,
              created_at AS createdAt
       FROM pets WHERE id = ?`,
    )
    .bind(validId)
    .first<PetRecord>();
  return row ?? null;
}

export async function createAppointment(
  db: D1Database,
  input: AppointmentInput,
): Promise<void> {
  const appointment = appointmentInputSchema.parse(input);
  await db
    .prepare(
      `INSERT INTO appointments (id, pet_id, scheduled_at, status)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      appointment.id,
      appointment.petId,
      appointment.scheduledAt,
      appointment.status,
    )
    .run();
}

export type TranscriptTurnInput = {
  id: string;
  sessionId: string;
  roundId: string;
  providerTurnId: string;
  transcript: string;
};

export async function insertTranscriptTurn(
  db: D1Database,
  input: TranscriptTurnInput,
): Promise<boolean> {
  const id = identifierSchema.parse(input.id);
  const sessionId = identifierSchema.parse(input.sessionId);
  const roundId = identifierSchema.parse(input.roundId);
  const providerTurnId = input.providerTurnId.trim();
  const transcript = input.transcript.trim();
  if (!providerTurnId || !transcript) throw new Error("Transcript turn fields are required.");

  const result = await db
    .prepare(
      `INSERT INTO transcript_turns
         (id, session_id, stt_round_id, provider_turn_id, transcript)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, provider_turn_id) DO NOTHING`,
    )
    .bind(id, sessionId, roundId, providerTurnId, transcript)
    .run();
  return result.meta.changes === 1;
}

export type SaveHandoverNoteInput = {
  id: string;
  sessionId: string;
  appointmentId: string;
  petId: string;
  draftRevision: number;
  content: HandoverContent;
};

export type HandoverNoteRecord = SaveHandoverNoteInput & { createdAt: string };

export async function getHandoverNoteForSession(
  db: D1Database,
  sessionId: string,
): Promise<HandoverNoteRecord | null> {
  const validSessionId = identifierSchema.parse(sessionId);
  const row = await db
    .prepare(
      `SELECT id, session_id AS sessionId, appointment_id AS appointmentId,
              pet_id AS petId, draft_revision AS draftRevision,
              content_json AS contentJson, created_at AS createdAt
       FROM handover_notes WHERE session_id = ?`,
    )
    .bind(validSessionId)
    .first<Omit<HandoverNoteRecord, "content"> & { contentJson: string }>();
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.sessionId,
    appointmentId: row.appointmentId,
    petId: row.petId,
    draftRevision: row.draftRevision,
    content: deserializeHandoverContent(row.contentJson),
    createdAt: row.createdAt,
  };
}

export async function saveHandoverNote(
  db: D1Database,
  input: SaveHandoverNoteInput,
): Promise<HandoverNoteRecord> {
  const validated = {
    id: identifierSchema.parse(input.id),
    sessionId: identifierSchema.parse(input.sessionId),
    appointmentId: identifierSchema.parse(input.appointmentId),
    petId: identifierSchema.parse(input.petId),
    draftRevision: input.draftRevision,
    content: handoverContentSchema.parse(input.content),
  };
  if (!Number.isInteger(validated.draftRevision) || validated.draftRevision < 1) {
    throw new Error("Draft revision must be a positive integer.");
  }

  await db
    .prepare(
      `INSERT INTO handover_notes
         (id, session_id, appointment_id, pet_id, draft_revision, content_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .bind(
      validated.id,
      validated.sessionId,
      validated.appointmentId,
      validated.petId,
      validated.draftRevision,
      serializeHandoverContent(validated.content),
    )
    .run();

  const row = await getHandoverNoteForSession(db, validated.sessionId);
  if (!row) throw new Error("Handover note save did not produce a row.");
  return row;
}
