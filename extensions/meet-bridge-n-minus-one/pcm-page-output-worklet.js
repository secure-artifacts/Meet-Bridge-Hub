class MeetBridgePcmPageOutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.chunkOffset = 0;
    this.queuedFrames = 0;
    this.started = false;
    this.closed = false;
    this.lastReportFrame = 0;

    this.port.onmessage = (event) => {
      if (event.data?.type === "close") {
        this.closed = true;
        this.chunks.length = 0;
        this.queuedFrames = 0;
        return;
      }

      const buffer = event.data;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 10) return;
      const samples = new Int16Array(buffer, 8);
      this.chunks.push(samples);
      this.queuedFrames += samples.length;
      if (this.queuedFrames > 28800) this.discard(this.queuedFrames - 14400);
    };
  }

  discard(count) {
    let remaining = count;
    while (remaining > 0 && this.chunks.length) {
      const available = this.chunks[0].length - this.chunkOffset;
      const take = Math.min(remaining, available);
      this.chunkOffset += take;
      this.queuedFrames -= take;
      remaining -= take;
      if (this.chunkOffset >= this.chunks[0].length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
  }

  process(_inputs, outputs) {
    if (this.closed) return false;
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (!this.started && this.queuedFrames < 7680) {
      output.fill(0);
    } else {
      this.started = true;
      if (this.queuedFrames > 19200) this.discard(this.queuedFrames - 14400);
      let sum = 0;
      for (let index = 0; index < output.length; index += 1) {
        let sample = 0;
        if (this.chunks.length) {
          sample = this.chunks[0][this.chunkOffset++] / 32768;
          this.queuedFrames -= 1;
          if (this.chunkOffset >= this.chunks[0].length) {
            this.chunks.shift();
            this.chunkOffset = 0;
          }
        }
        output[index] = sample;
        sum += sample * sample;
      }
      if (this.queuedFrames === 0) this.started = false;

      if (currentFrame - this.lastReportFrame >= sampleRate) {
        this.lastReportFrame = currentFrame;
        this.port.postMessage({
          type: "render-level",
          rms: Math.sqrt(sum / output.length),
          queuedFrames: this.queuedFrames,
        });
      }
    }

    return true;
  }
}

registerProcessor(
  "meet-bridge-pcm-page-output",
  MeetBridgePcmPageOutputProcessor,
);
