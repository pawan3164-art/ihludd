// WebSocket relay: browser <-> backend <-> Sarvam Bulbul V3 TTS.
//
// CONFIRMED from a live session: Sarvam doesn't reliably send a "this
// utterance is finished" message the way earlier docs-based guesses assumed
// — leaving the connection open eventually gets it killed server-side with
// a 408 ("Websocket was left open without any messages for too long"),
// minutes later. We now close the connection ourselves shortly after the
// last message, instead of waiting indefinitely for a signal that may never
// arrive. speech_sample_rate is also now requested explicitly (24000, Bulbul
// V3's own default) rather than left unset and guessed on the playback side.
const WebSocket = require("ws");

const SARVAM_TTS_URL = "wss://api.sarvam.ai/text-to-speech/ws";
const IDLE_CLOSE_MS = 800;

// Logs the full message structure (sample rate, format, etc.) without
// dumping the (often huge) base64 audio payload itself into the terminal.
function summarizeForLog(rawString) {
  try {
    const msg = JSON.parse(rawString);
    if (msg.data?.audio) {
      msg.data = { ...msg.data, audio: `<base64, ${msg.data.audio.length} chars>` };
    }
    return JSON.stringify(msg);
  } catch (err) {
    return rawString.slice(0, 200);
  }
}

function isCompletionMessage(msg) {
  if (msg.type === "event" && msg.data?.event_type === "final") return true;
  return ["done", "end", "complete", "flush_done"].includes(msg.type);
}

function attachTtsRelay(wss) {
  wss.on("connection", (browserWs) => {
    const sarvamWs = new WebSocket(SARVAM_TTS_URL, {
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
    });

    let sarvamReady = false;
    let pending = null; // { text, languageCode } — the browser's request may
    // arrive before Sarvam's connection finishes opening.
    let idleTimer = null;

    // The browser previously inferred "utterance finished" from this
    // connection closing — but that conflated "Sarvam's WS closed" with
    // "audio fully delivered", and risked truncating the final (often
    // largest) message if close() raced its send. Sending an explicit,
    // backend-controlled signal first removes that ambiguity entirely: the
    // browser no longer needs to guess from Sarvam's raw protocol at all.
    const signalCompleteThenClose = () => {
      clearTimeout(idleTimer);
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(JSON.stringify({ type: "relay-complete" }));
      }
      sarvamWs.close();
    };

    const scheduleIdleClose = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(signalCompleteThenClose, IDLE_CLOSE_MS);
    };

    // Config is sent per-request (not eagerly on open) because it depends on
    // the detected language of what's being spoken, which we only know once
    // the browser tells us.
    const sendConfigAndText = ({ text, languageCode }) => {
      sarvamWs.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker: "anushka",
            // Respond in kind: Sarvam's STT reports a detected language_code
            // (e.g. "hi-IN") that app.js passes straight through here.
            // Falls back to Hindi if nothing was detected (e.g. a call
            // opening line synthesized before any speech has been heard).
            language_code: languageCode || "hi-IN",
            output_audio_codec: "linear16",
            speech_sample_rate: 24000,
            send_completion_event: true,
          },
        })
      );
      sarvamWs.send(JSON.stringify({ type: "text", data: { text } }));
    };

    sarvamWs.on("open", () => {
      sarvamReady = true;
      if (pending) {
        sendConfigAndText(pending);
        pending = null;
      }
    });

    sarvamWs.on("message", (raw) => {
      console.log("Sarvam TTS message:", summarizeForLog(raw.toString()));
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(raw.toString());
      }

      let msg = {};
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        // fall through — treated as a non-completion message below
      }

      if (isCompletionMessage(msg)) {
        signalCompleteThenClose();
        return;
      }

      // No (recognized) explicit completion signal — close shortly after
      // the last message instead of risking Sarvam's own idle-timeout 408.
      scheduleIdleClose();
    });

    sarvamWs.on("error", (err) => {
      console.error("Sarvam TTS connection error:", err.message);
      clearTimeout(idleTimer);
      browserWs.close();
    });

    sarvamWs.on("close", () => {
      clearTimeout(idleTimer);
      browserWs.close();
    });

    browserWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg.text) return;

        const request = { text: msg.text, languageCode: msg.languageCode };
        if (sarvamReady) {
          sendConfigAndText(request);
        } else {
          pending = request;
        }
      } catch (err) {
        // Never let a bad/unexpected message crash the whole backend —
        // log it and keep the relay (and every other in-flight call) alive.
        console.error("Error handling TTS relay message from browser", err);
      }
    });

    browserWs.on("close", () => {
      clearTimeout(idleTimer);
      sarvamWs.close();
    });
    browserWs.on("error", () => sarvamWs.close());
  });
}

module.exports = { attachTtsRelay };
