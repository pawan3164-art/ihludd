// Twilio Media Streams <-> Gemini Live bridge for the delivery-check call.
// Replaces the old Twilio ConversationRelay + Claude call loop entirely —
// Claude is no longer used anywhere in this project.
//
// NOTE: Gemini Live's exact serverContent/toolCall event shapes, and the
// `tools` config shape for function calling, are a best-effort
// reconstruction from Google's docs — not yet verified against a live
// session. Raw Twilio and Gemini events are both logged; expect to fix
// field names from a real test call's logs, the same way Twilio's
// ConversationRelay format needed correcting earlier in this project.
const WebSocket = require("ws");
const { GoogleGenAI, Modality } = require("@google/genai");
const {
  twilioMulawToGeminiPcm,
  geminiPcmToTwilioMulaw,
} = require("./audioBridge");

// Verify this exact model ID in Google AI Studio's model picker before
// shipping — "Gemini 3.1 Flash Live" is the name, this is research's best
// guess at the API model string.
const GEMINI_MODEL = "gemini-3.1-flash-live-preview";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const END_CALL_FUNCTION = {
  name: "end_call",
  description:
    "Call this once you have a clear answer about delivery (or a clear no), or the other person has nothing more useful to add. Ends the call and reports the outcome.",
  parameters: {
    type: "object",
    properties: {
      canDeliver: {
        type: "boolean",
        description:
          "Whether the shop can deliver the requested item to the given address.",
      },
      price: {
        type: "string",
        description:
          "Delivery price/cost as stated, or an empty string if not mentioned.",
      },
      etaMinutes: {
        type: "integer",
        description:
          "Estimated delivery time in minutes, or -1 if not mentioned.",
      },
      notes: {
        type: "string",
        description:
          "Any other relevant detail (e.g. minimum order, hours, an alternative they suggested).",
      },
    },
    required: ["canDeliver", "price", "etaMinutes", "notes"],
  },
};

function buildSystemInstruction({ shopName, itemQuery, deliveryAddress }) {
  return `You are an automated phone assistant calling ${shopName} on behalf of a customer, to ask whether they can deliver "${itemQuery}" to "${deliveryAddress}".

Goals, in order: (1) confirm they have the item, (2) confirm they deliver to that address, (3) get the delivery price and estimated time.

Keep every turn short and conversational, like a real phone call — one or two sentences.

The caller has already heard a pre-recorded opening line identifying you as an automated assistant and mentioning the call may be recorded — do not repeat that.

Match the language the other person speaks — if they respond in Hindi or Hinglish, continue in Hindi/Hinglish; if English, continue in English.

Once you have a clear answer, say a short closing line (e.g. "Great, thanks for your help!") and call the end_call function. Also call end_call if the conversation is clearly going nowhere (wrong number, hostile, no relevant information) after a couple of exchanges — set canDeliver to false and explain why in notes.`;
}

// Pre-synthesizes the compliance-critical opening line as mulaw/8kHz audio
// (Sarvam supports mulaw output directly, so no resampling is needed here)
// and plays it in full BEFORE the Gemini Live session opens — this is the
// guard against a live model's barge-in cutting off the disclosure.
const TTS_IDLE_CLOSE_MS = 800;

function isTtsCompletionMessage(msg) {
  if (msg.type === "event" && msg.data?.event_type === "final") return true;
  return ["done", "end", "complete", "flush_done"].includes(msg.type);
}

function synthesizeOpeningLineMulaw({ itemQuery, deliveryAddress }) {
  const text = `Hi, this is an automated assistant calling on behalf of a customer. This call may be recorded. I'm calling to ask about ${itemQuery} — do you have it in stock, and can you deliver it to ${deliveryAddress}?`;

  return new Promise((resolve, reject) => {
    const sarvamWs = new WebSocket("wss://api.sarvam.ai/text-to-speech/ws", {
      headers: { "api-subscription-key": process.env.SARVAM_API_KEY },
    });
    const chunks = [];
    let idleTimer = null;

    const scheduleIdleClose = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => sarvamWs.close(), TTS_IDLE_CLOSE_MS);
    };

    sarvamWs.on("open", () => {
      sarvamWs.send(
        JSON.stringify({
          type: "config",
          data: {
            speaker: "anushka",
            language_code: "hi-IN",
            output_audio_codec: "mulaw",
            // Twilio Media Streams requires exactly mulaw/8kHz — request it
            // explicitly rather than assuming Sarvam's mulaw output happens
            // to default there.
            speech_sample_rate: 8000,
            send_completion_event: true,
          },
        })
      );
      sarvamWs.send(JSON.stringify({ type: "text", data: { text } }));
    });

    sarvamWs.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.log("Sarvam TTS (opening line) message (unparsed):", raw.toString().slice(0, 200));
        scheduleIdleClose();
        return;
      }
      const logMsg = msg.data?.audio
        ? { ...msg, data: { ...msg.data, audio: `<base64, ${msg.data.audio.length} chars>` } }
        : msg;
      console.log("Sarvam TTS (opening line) message:", JSON.stringify(logMsg));
      const audio = msg.data?.audio ?? msg.audio;
      if (audio) chunks.push(Buffer.from(audio, "base64"));

      if (isTtsCompletionMessage(msg)) {
        clearTimeout(idleTimer);
        sarvamWs.close();
        return;
      }
      // No (recognized) explicit completion signal — Sarvam doesn't
      // reliably send one (confirmed live: it can leave the connection
      // open until ITS OWN idle timeout errors with a 408). Close shortly
      // after the last message ourselves instead of risking that.
      scheduleIdleClose();
    });

    sarvamWs.on("close", () => {
      clearTimeout(idleTimer);
      resolve(Buffer.concat(chunks));
    });
    sarvamWs.on("error", (err) => {
      clearTimeout(idleTimer);
      reject(err);
    });
  });
}

function sendMulawBase64ToTwilio(twilioWs, streamSid, base64Payload) {
  if (twilioWs.readyState !== WebSocket.OPEN) return;
  twilioWs.send(
    JSON.stringify({ event: "media", streamSid, media: { payload: base64Payload } })
  );
}

async function endTwilioCall(callSid, twilioClient) {
  try {
    await twilioClient.calls(callSid).update({ status: "completed" });
  } catch (err) {
    console.error(`Failed to end call ${callSid}`, err);
  }
}

function attachMediaStreamBridge(wss, { callContexts, callResults, twilioClient }) {
  wss.on("connection", (twilioWs) => {
    let callSid = null;
    let streamSid = null;
    let context = null;
    let geminiSession = null;
    let openingLinePlaying = false;

    async function openGeminiSession() {
      geminiSession = await ai.live.connect({
        model: GEMINI_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          // Without this, Gemini Live picks its own default voice — which
          // turned out to sound male, an audible mismatch right after the
          // female voice (Sarvam "anushka") used for the pre-recorded
          // opening line (synthesizeOpeningLineMulaw) and every frontend
          // TTS call. "Kore" is Gemini Live's commonly-documented
          // female-sounding prebuilt voice — unverified against a real call
          // like GEMINI_MODEL itself below; confirm in a live test and swap
          // if it doesn't match, or pick a different name from the voice
          // list in Google AI Studio.
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Kore" },
            },
          },
          systemInstruction: buildSystemInstruction(context),
          tools: [{ functionDeclarations: [END_CALL_FUNCTION] }],
        },
        callbacks: {
          onopen: () => console.log(`Gemini Live session open for call ${callSid}`),
          onmessage: (message) => handleGeminiMessage(message),
          onerror: (err) =>
            console.error(`Gemini Live error for call ${callSid}:`, err.message),
          onclose: (e) =>
            console.log(`Gemini Live session closed for call ${callSid}:`, e.reason),
        },
      });
    }

    function handleGeminiMessage(message) {
      console.log("Gemini Live message:", JSON.stringify(message).slice(0, 300));

      const parts = message.serverContent?.modelTurn?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData?.data) {
            const mulawBase64 = geminiPcmToTwilioMulaw(part.inlineData.data);
            sendMulawBase64ToTwilio(twilioWs, streamSid, mulawBase64);
          }
        }
      }

      if (message.toolCall) {
        for (const fc of message.toolCall.functionCalls) {
          if (fc.name === "end_call") {
            const { canDeliver, price, etaMinutes, notes } = fc.args;
            callResults.set(callSid, {
              status: "completed",
              canDeliver: Boolean(canDeliver),
              price: price || null,
              etaMinutes:
                typeof etaMinutes === "number" && etaMinutes >= 0 ? etaMinutes : null,
              notes: notes || null,
            });
            geminiSession.sendToolResponse({
              functionResponses: [{ name: fc.name, id: fc.id, response: { result: "ok" } }],
            });
          }
        }
      }

      if (
        message.serverContent?.turnComplete &&
        callResults.get(callSid)?.status === "completed"
      ) {
        // Gemini's closing line has finished streaming out — end the call.
        setTimeout(() => endTwilioCall(callSid, twilioClient), 500);
      }
    }

    twilioWs.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.error("Bad Media Streams message", err);
        return;
      }

      // "media" events are high-frequency (~50/sec) — don't log those.
      if (msg.event !== "media") {
        console.log("Twilio Media Streams event:", JSON.stringify(msg));
      }

      if (msg.event === "start") {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        context = callContexts.get(callSid);
        if (!context) {
          console.error(`No call context found for call ${callSid}`);
          twilioWs.close();
          return;
        }

        openingLinePlaying = true;
        try {
          const openingAudio = await synthesizeOpeningLineMulaw(context);
          sendMulawBase64ToTwilio(
            twilioWs,
            streamSid,
            openingAudio.toString("base64")
          );
          // mulaw/8kHz mono = 1 byte/sample = 8000 bytes/sec.
          const playbackMs = (openingAudio.length / 8000) * 1000;
          setTimeout(() => {
            openingLinePlaying = false;
            openGeminiSession();
          }, playbackMs + 200);
        } catch (err) {
          console.error("Failed to synthesize opening line", err);
          openingLinePlaying = false;
          openGeminiSession();
        }
        return;
      }

      if (msg.event === "media") {
        // Don't feed Gemini any audio until the disclosure has fully played.
        if (openingLinePlaying || !geminiSession) return;
        const pcmBase64 = twilioMulawToGeminiPcm(msg.media.payload);
        geminiSession.sendRealtimeInput({
          audio: { data: pcmBase64, mimeType: "audio/pcm;rate=16000" },
        });
        return;
      }

      if (msg.event === "stop") {
        if (callSid && callResults.get(callSid)?.status === "in-progress") {
          callResults.set(callSid, { status: "no-answer" });
        }
        geminiSession?.close();
        return;
      }
    });

    twilioWs.on("close", () => {
      if (callSid && callResults.get(callSid)?.status === "in-progress") {
        callResults.set(callSid, { status: "no-answer" });
      }
      geminiSession?.close();
    });
  });
}

module.exports = { attachMediaStreamBridge };
