class GroomNotePcmProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const channels = inputs[0];
    if (channels && channels.length && channels[0].length) {
      const copies = channels.map(channel => channel.slice());
      this.port.postMessage(copies, copies.map(channel => channel.buffer));
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}

registerProcessor("groomnote-pcm", GroomNotePcmProcessor);
