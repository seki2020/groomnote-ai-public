import { downmixChannels, PcmChunker, StreamingResampler } from "./pcm";
import type { Microphone } from "./types";

export async function openMicrophone(): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    await context.audioWorklet.addModule("/pcm-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(context, "groomnote-pcm");
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(processor).connect(silent).connect(context.destination);
    const resampler = new StreamingResampler(context.sampleRate);
    let chunker: PcmChunker | undefined;
    processor.port.onmessage = (event: MessageEvent<Float32Array[]>) => {
      if (chunker) chunker.push(resampler.process(downmixChannels(event.data)));
    };
    await context.resume();
    let released = false;
    return {
      label: stream.getAudioTracks()[0]?.label || "Microphone",
      startSending(send) { chunker = new PcmChunker(send); },
      stopSending() { chunker?.flush(); chunker = undefined; },
      async release() {
        if (released) return;
        released = true;
        chunker = undefined;
        processor.port.onmessage = null;
        source.disconnect();
        processor.disconnect();
        silent.disconnect();
        stream.getTracks().forEach(track => track.stop());
        await context!.close();
      },
    };
  } catch (error) {
    stream.getTracks().forEach(track => track.stop());
    if (context) await context.close();
    throw error;
  }
}
