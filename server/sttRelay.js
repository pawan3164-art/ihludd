// WebSocket relay: browser <-> backend <-> Sarvam Saarika STT (codemix mode).
//
// Hand-rolled WS client to Sarvam (not the official SDK's
// speechToTextStreaming.connect() helper) because the Node SDK silently drops
// the `mode` parameter needed for codemix (Hindi/English mixed) transcription
// — it has to be appended to the URL directly instead.
//
// CONFIRMED from a live session: Sarvam's raw API only accepts
// `audio.encoding: "audio/wav"` — raw `pcm_s16le` is rejected. Each audio
// chunk sent to Sarvam is therefore wrapped in a minimal WAV header here.
const WebSocket = require("ws");

const SARVAM_STT_URL = "wss://api.sarvam.ai/speech-to-text/ws?mode=codemix";

function buildWavHeader(dataLength, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM (uncompressed)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return header;
}

function wrapPcmAsWav(pcmBuffer, sampleRate) {
  return Buffer.concat([buildWavHeader(pcmBuffer.length, sampleRate), pcmBuffer]);
}

function attachSttRelay(wss) {
  wss.on("connection", (browserWs) => {
    const sarvamWs = new WebSocket(SARVAM_STT_URL, {
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
    });

    let sarvamReady = false;
    const pendingFrames = [];

    const sendFrame = (frame) => {
      sarvamWs.send(frame);
    };

    sarvamWs.on("open", () => {
      sarvamReady = true;
      for (const frame of pendingFrames) sendFrame(frame);
      pendingFrames.length = 0;
    });

    sarvamWs.on("message", (raw) => {
      console.log("Sarvam STT message:", raw.toString());
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(raw.toString());
      }
    });

    sarvamWs.on("error", (err) => {
      console.error("Sarvam STT connection error:", err.message);
      browserWs.close();
    });

    sarvamWs.on("close", () => browserWs.close());

    // Browser sends base64 PCM16/16kHz audio chunks (~200ms each) as JSON;
    // wrapped as WAV and forwarded to Sarvam once its connection is ready
    // (buffering anything sent before that).
    browserWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.audio) return;

        const pcmBuffer = Buffer.from(msg.audio, "base64");
        const wavBuffer = wrapPcmAsWav(pcmBuffer, 16000);
        const frame = JSON.stringify({
          audio: {
            data: wavBuffer.toString("base64"),
            encoding: "audio/wav",
            sample_rate: 16000,
          },
        });

        if (sarvamReady) {
          sendFrame(frame);
        } else {
          pendingFrames.push(frame);
        }
      } catch (err) {
        // Never let a bad/unexpected message crash the whole backend — log
        // it and keep the relay (and every other in-flight call) alive.
        console.error("Error handling STT relay message from browser", err);
      }
    });

    browserWs.on("close", () => sarvamWs.close());
    browserWs.on("error", () => sarvamWs.close());
  });
}

module.exports = { attachSttRelay };
