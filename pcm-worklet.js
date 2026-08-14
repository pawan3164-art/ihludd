// Minimal AudioWorklet processor: forwards raw mic samples to the main
// thread untouched. All resampling/encoding happens in speech.js — keeping
// the worklet itself as simple as possible.
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // Copy required: the underlying buffer is reused by the audio thread
      // on the next render quantum.
      this.port.postMessage(channel.slice());
    }
    return true;
  }
}

registerProcessor("pcm-capture-processor", PcmCaptureProcessor);
