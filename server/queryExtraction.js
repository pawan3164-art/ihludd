// Classifies a spoken request into either a nearby-search request (and
// extracts a concise English search query, e.g. "मुझे कुछ tennis balls
// चाहिए" -> "tennis balls", since Google Places' text search handles full
// English sentences far better than full Hindi/Hinglish sentences) or
// general conversation (e.g. jokes, small talk) that should just get a
// direct spoken reply instead of triggering a places search at all.
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Plain (non-Live) text model. Confirmed live against the account's actual
// ListModels response — "gemini-3.1-flash" (the earlier guess) doesn't
// exist; there's no bare "gemini-3.1-flash" at all. Using the "-latest"
// alias rather than a pinned dated model since this is a lightweight
// utility call with no need for version-pinned reproducibility, and it
// avoids this exact class of bug recurring as models are retired/renamed.
const EXTRACTION_MODEL = "gemini-flash-latest";

const SYSTEM_INSTRUCTION = `You are the language-understanding layer for a voice assistant called "Find It Nearby" that finds and calls nearby local shops. The input may be in English, Hindi, or a Hindi/English mix.

Classify the input into exactly one of two intents and respond with ONLY a JSON object — no markdown, no code fences, no explanation:

- If the user is asking to find, locate, or buy a product or service nearby: {"intent": "search", "query": "<short 2-5 word English search phrase suitable for a maps app, e.g. \\"tennis balls\\", \\"plumber\\", \\"cricket bat store\\">"}
- Otherwise (greetings, jokes, small talk, general questions not about finding a nearby place): {"intent": "chat", "reply": "<a short, natural, spoken-style reply, 1-3 sentences, in the same language/script the user spoke>"}

Respond with ONLY the JSON object, nothing else.`;

// The SDK call has no built-in timeout — an occasional hang here previously
// left the frontend stuck on "Thinking…" indefinitely. Race it against a
// timer so a stuck call fails fast (and falls back to a raw-transcript
// search, same as any other classification failure) instead of hanging.
const GEMINI_CALL_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function classifyRequest(transcript) {
  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: EXTRACTION_MODEL,
        contents: transcript,
        config: { systemInstruction: SYSTEM_INSTRUCTION },
      }),
      GEMINI_CALL_TIMEOUT_MS
    );
    const raw = (response.text || "").trim();
    // Defensive: models asked for "only JSON" occasionally still wrap it in
    // a ```json fence — strip that before parsing rather than failing on it.
    const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(jsonText);

    if (parsed.intent === "chat" && parsed.reply) {
      return { intent: "chat", reply: parsed.reply };
    }
    if (parsed.intent === "search" && parsed.query) {
      return { intent: "search", query: parsed.query };
    }
    throw new Error(`Unexpected classification shape: ${jsonText}`);
  } catch (err) {
    console.error("Request classification failed, defaulting to search with raw transcript:", err.message);
    return { intent: "search", query: transcript };
  }
}

module.exports = { classifyRequest };
