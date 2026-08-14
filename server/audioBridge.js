// Audio format bridging between Twilio Media Streams (mulaw, 8kHz, mono) and
// Gemini Live (PCM16 in at 16kHz, PCM16 out at 24kHz).
const { mulaw } = require("alawmulaw");

// base64 mulaw bytes (as received from Twilio) -> Int16Array PCM samples.
function decodeMulawBase64(base64Payload) {
  const mulawBytes = new Uint8Array(Buffer.from(base64Payload, "base64"));
  return mulaw.decode(mulawBytes);
}

// Int16Array PCM samples -> base64 mulaw bytes (to send to Twilio).
function encodeMulawBase64(int16Samples) {
  const mulawBytes = mulaw.encode(int16Samples);
  return Buffer.from(mulawBytes).toString("base64");
}

// Simple linear-interpolation resampler. Telephony audio is already
// low-fidelity, and both conversions we need are clean ratios (8k->16k is
// exactly 2x, 24k->8k is exactly 1/3x), so this is sufficient without pulling
// in a dedicated resampling library.
function resample(int16Samples, fromRate, toRate) {
  if (fromRate === toRate) return int16Samples;

  const ratio = toRate / fromRate;
  const outLength = Math.round(int16Samples.length * ratio);
  const out = new Int16Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const srcIndexLow = Math.floor(srcPos);
    const srcIndexHigh = Math.min(srcIndexLow + 1, int16Samples.length - 1);
    const frac = srcPos - srcIndexLow;
    const low = int16Samples[srcIndexLow] ?? 0;
    const high = int16Samples[srcIndexHigh] ?? low;
    out[i] = Math.round(low + (high - low) * frac);
  }

  return out;
}

// base64-encoded raw PCM16 little-endian bytes -> Int16Array.
function pcmBase64ToInt16(base64Payload) {
  const buffer = Buffer.from(base64Payload, "base64");
  return new Int16Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.length / Int16Array.BYTES_PER_ELEMENT
  );
}

// Int16Array -> base64-encoded raw PCM16 little-endian bytes.
function int16ToPcmBase64(int16Samples) {
  const buffer = Buffer.from(
    int16Samples.buffer,
    int16Samples.byteOffset,
    int16Samples.byteLength
  );
  return buffer.toString("base64");
}

// Twilio mulaw/8kHz -> Gemini Live's expected PCM16/16kHz input, base64 both ends.
function twilioMulawToGeminiPcm(base64MulawPayload) {
  const pcm8k = decodeMulawBase64(base64MulawPayload);
  const pcm16k = resample(pcm8k, 8000, 16000);
  return int16ToPcmBase64(pcm16k);
}

// Gemini Live's PCM16/24kHz output -> Twilio mulaw/8kHz, base64 both ends.
function geminiPcmToTwilioMulaw(base64PcmPayload) {
  const pcm24k = pcmBase64ToInt16(base64PcmPayload);
  const pcm8k = resample(pcm24k, 24000, 8000);
  return encodeMulawBase64(pcm8k);
}

module.exports = {
  decodeMulawBase64,
  encodeMulawBase64,
  resample,
  pcmBase64ToInt16,
  int16ToPcmBase64,
  twilioMulawToGeminiPcm,
  geminiPcmToTwilioMulaw,
};
