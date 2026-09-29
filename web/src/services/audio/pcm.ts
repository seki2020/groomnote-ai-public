export const STT_SAMPLE_RATE = 16_000;
export const STT_CHUNK_SAMPLES = 1_600; // 100 ms, inside the provider's 50–1000 ms guidance.

export function downmixChannels(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array();
  const length = channels[0].length;
  if (channels.some(channel => channel.length !== length)) throw new Error("Audio channel lengths differ");
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i += 1) mono[i] += channel[i] / channels.length;
  }
  return mono;
}

export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(samples.length * 2);
  const view = new DataView(bytes);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(i * 2, clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), true);
  }
  return bytes;
}

export class StreamingResampler {
  private inputOffset = 0;
  private nextOutputPosition = 0;
  private previousSample = 0;

  constructor(readonly inputRate: number, readonly outputRate = STT_SAMPLE_RATE) {
    if (!Number.isFinite(inputRate) || inputRate < 8_000 || inputRate > 192_000 || outputRate <= 0 || outputRate > inputRate) {
      throw new Error("Unsupported audio sample rate");
    }
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array();
    const start = this.inputOffset;
    const end = start + input.length - 1;
    const step = this.inputRate / this.outputRate;
    const output: number[] = [];
    while (this.nextOutputPosition <= end + 1e-9) {
      const left = Math.floor(this.nextOutputPosition);
      const right = Math.min(left + 1, end);
      const a = left < start ? this.previousSample : input[left - start];
      const b = right < start ? this.previousSample : input[right - start];
      output.push(a + (b - a) * (this.nextOutputPosition - left));
      this.nextOutputPosition += step;
    }
    this.previousSample = input[input.length - 1];
    this.inputOffset += input.length;
    return Float32Array.from(output);
  }
}

export class PcmChunker {
  private pending: number[] = [];
  constructor(private readonly send: (chunk: ArrayBuffer) => void, readonly chunkSamples = STT_CHUNK_SAMPLES) {}

  push(samples: Float32Array): void {
    for (const sample of samples) this.pending.push(sample);
    while (this.pending.length >= this.chunkSamples) {
      this.send(floatToPcm16(Float32Array.from(this.pending.splice(0, this.chunkSamples))));
    }
  }

  flush(): void {
    if (this.pending.length) {
      while (this.pending.length < STT_SAMPLE_RATE / 20) this.pending.push(0);
      this.send(floatToPcm16(Float32Array.from(this.pending)));
      this.pending = [];
    }
  }
}
