export const WORKERS_AI_TTS_MODEL = "@cf/myshell-ai/melotts" as const;
export const MP3_CONTENT_TYPE = "audio/mpeg" as const;
export const WAV_CONTENT_TYPE = "audio/wav" as const;
export const MAX_TTS_CHARACTERS = 450;

export interface TtsRunner {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export function validateTtsText(text: string): string {
  const normalized = text.trim();
  if (!normalized) throw new Error("TTS text is required.");
  if (normalized.length > MAX_TTS_CHARACTERS) {
    throw new Error(`TTS text exceeds ${MAX_TTS_CHARACTERS} characters.`);
  }
  return normalized;
}

async function toBytes(output: unknown): Promise<Uint8Array> {
  if (
    typeof output === "object" &&
    output !== null &&
    "audio" in output &&
    typeof output.audio === "string"
  ) {
    const binary = atob(output.audio);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  if (
    typeof output === "object" &&
    output !== null &&
    "arrayBuffer" in output &&
    typeof output.arrayBuffer === "function"
  ) {
    return new Uint8Array(await output.arrayBuffer());
  }
  // Workers bindings can create streams in a different JS realm, where
  // `instanceof ReadableStream` is false. Prefer a structural check.
  if (
    typeof output === "object" &&
    output !== null &&
    "getReader" in output &&
    typeof output.getReader === "function"
  ) {
    return new Uint8Array(
      await new Response(output as ReadableStream<Uint8Array>).arrayBuffer(),
    );
  }
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (ArrayBuffer.isView(output)) {
    return new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
  }
  throw new Error("Workers AI TTS returned an unsupported payload.");
}

export function looksLikeMp3(bytes: Uint8Array): boolean {
  if (bytes.length < 3) return false;
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return id3 || frame;
}

export function looksLikeWav(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WAVE"
  );
}

export interface TtsAudio {
  bytes: Uint8Array;
  contentType: typeof MP3_CONTENT_TYPE | typeof WAV_CONTENT_TYPE;
}

export class WorkersAITts {
  constructor(private readonly ai: TtsRunner) {}

  async synthesize(text: string): Promise<TtsAudio> {
    const output = await this.ai.run(WORKERS_AI_TTS_MODEL, {
      prompt: validateTtsText(text),
      lang: "en",
    });
    const bytes = await toBytes(output);
    if (looksLikeMp3(bytes)) return { bytes, contentType: MP3_CONTENT_TYPE };
    if (looksLikeWav(bytes)) return { bytes, contentType: WAV_CONTENT_TYPE };
    throw new Error("Workers AI TTS did not return recognized MP3 or WAV audio bytes.");
  }
}

export function fakeMp3(): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);
}

/** Decodable deterministic audio for browser integration tests; never used in production. */
export function fakeWav(): Uint8Array {
  const sampleRate = 16_000;
  const sampleCount = 16_000;
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => { for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index); };
  write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVE"); write(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  for (let index = 0; index < sampleCount; index += 1) {
    view.setInt16(44 + index * 2, Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 1_000), true);
  }
  return bytes;
}
