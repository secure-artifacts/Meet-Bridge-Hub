class MeetBridgePcmOutputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requestedChunkFrames = options?.processorOptions?.chunkFrames;
    this.chunkFrames =
      Number.isInteger(requestedChunkFrames) &&
      requestedChunkFrames >= 128 &&
      requestedChunkFrames <= 4096
        ? requestedChunkFrames
        : 1280;
    this.buffer = new Float32Array(this.chunkFrames);
    this.offset = 0;
    this.chunkStartFrame = 0;
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || [];
    const output = outputs[0]?.[0];
    const frames = output?.length || inputChannels[0]?.length || 128;

    for (let frame = 0; frame < frames; frame += 1) {
      let sample = 0;
      if (inputChannels.length) {
        for (const channel of inputChannels) sample += channel[frame] || 0;
        sample /= inputChannels.length;
      }
      if (output) output[frame] = sample;
      if (this.offset === 0) this.chunkStartFrame = currentFrame + frame;
      this.buffer[this.offset] = sample;
      this.offset += 1;

      if (this.offset === this.chunkFrames) {
        const samples = this.buffer;
        this.port.postMessage(
          {
            samples: samples.buffer,
            sampleRate,
            timestamp: Math.round((this.chunkStartFrame * 1_000_000) / sampleRate),
          },
          [samples.buffer],
        );
        this.buffer = new Float32Array(this.chunkFrames);
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("meet-bridge-pcm-output", MeetBridgePcmOutputProcessor);
