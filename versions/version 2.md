# Version 2 — User Journey

Revised version of the original journey, incorporating Sarvam AI for the
Hindi/Hinglish speech layers on the frontend, and Gemini 3.1 Flash Live (native
speech-to-speech, replacing Sarvam STT + Claude + Sarvam TTS) for the phone call
loop, in place of Twilio ConversationRelay's built-in (English-first) STT/TTS.
Google Places and Twilio-as-carrier are kept as-is — those aren't speech/reasoning
problems, so there's nothing to swap.

**Update:** the call loop (Steps 9–13) now uses Gemini 3.1 Flash Live instead of
the Sarvam STT → Claude → Sarvam TTS cascade from the previous revision. Gemini
Live is a native audio-in/audio-out model with built-in multilingual support
(auto mid-conversation language switching, ~90 languages), native barge-in/
turn-taking, and function calling — so it collapses three hops (STT, LLM, TTS)
into one live session and removes Claude from the call path entirely. Claude is
no longer used anywhere in this architecture.

## Summary of changes from v1

| Area | v1 | v2 (this doc) | Why |
|---|---|---|---|
| Frontend STT (Step 2) | Web Speech API | Sarvam Saarika (codemix mode), Web Speech API as fallback | Native Hinglish handling; code-switched speech sees a 30–50% WER jump on generic ASR |
| Frontend TTS (Step 5, 16) | Web Speech API | Sarvam Bulbul V3, Web Speech API as fallback | Natural Hindi/Hinglish voice, correct Indian name pronunciation |
| Call audio + reasoning (Steps 9–13) | Twilio ConversationRelay (built-in STT/TTS) + Claude | Twilio Media Streams + Pipecat + Gemini 3.1 Flash Live | ConversationRelay's engine isn't tuned for Hindi/Hinglish; Gemini Live handles STT, reasoning, TTS, turn-taking, and tool calling natively in one multilingual session, instead of chaining three separate services |
| Everything else | — | Unchanged | Geolocation, Places search, card selection, HTTP plumbing, in-memory state aren't speech-layer concerns |

---

### Step 1 — User taps the "Tap to Speak" button

*(unchanged)*

- **What happens:** Browser requests microphone permission and starts listening.
- **Tool/service:** Web Speech API — `SpeechRecognition` (via `speech.js`'s `Speech.listenOnce()`).
- **Architecture layer:** Frontend, in-browser only.

### Step 2 — User speaks a request (e.g. "cricket bat kahan milega")

- **What happens:** Audio is streamed to Sarvam's Saarika STT over WebSocket in codemix mode, which returns a transcript handling Hindi/English mixing natively, instead of a monolingual engine guessing at code-switched speech.
- **Tool/service:** Sarvam Saarika STT (streaming WebSocket API) — called through a thin backend relay (`POST /stt-token` or a proxied WS) since the API key can't live in browser JS. Web Speech API remains as a zero-setup fallback for English-only sessions or if the relay is unavailable.
- **Architecture layer:** Frontend → backend (relay only, no processing) → Sarvam API. This is the one place v2 adds a network hop v1 didn't have.
- **Trade-off:** loses the "free, in-browser, no backend" property of v1 for this step. If Hindi/Hinglish usage is a small fraction of traffic, consider gating this behind a detected/selected language rather than always routing through Sarvam.

### Step 3 — App gets the user's current location

*(unchanged)*

- **Tool/service:** Browser Geolocation API.
- **Architecture layer:** Frontend, in-browser only.

### Step 4 — App searches for nearby places matching the request

*(unchanged)*

- **Tool/service:** Google Places API (New) — `Place.searchByText()`, client-side.
- **Architecture layer:** Frontend → third-party (Google), no backend involved.
- **Note:** No Sarvam equivalent exists for geo-search/reviews/hours data — this step stays exactly as-is regardless of which speech stack you use.

### Step 5 — App speaks the 3 results back to the user

- **What happens:** The results sentence is sent to Sarvam Bulbul V3 over its low-latency WebSocket TTS API (sub-250ms first byte), which speaks shop names and Hinglish phrasing naturally rather than in a generic browser voice.
- **Tool/service:** Sarvam Bulbul V3 (streaming TTS), same backend relay pattern as Step 2. Web Speech API `SpeechSynthesis` as fallback.
- **Architecture layer:** Frontend → backend relay → Sarvam API.

### Step 6 — User selects one of the 3 results

*(unchanged)*

- **Tool/service:** Sarvam Saarika (voice path, same relay as Step 2) or DOM click/keyboard (card path).
- **Architecture layer:** Frontend, in-browser only (card path) / frontend → relay → Sarvam (voice path).

### Step 7 — App asks the backend to call the shop

*(unchanged)*

- **Tool/service:** `fetch()` → `POST /call-shop` on the Node/Express backend.
- **Architecture layer:** Frontend → backend, HTTP.

### Step 8 — Backend places the outbound phone call

*(unchanged)*

- **Tool/service:** Twilio Programmable Voice (`twilioClient.calls.create()`).
- **Architecture layer:** Backend → third-party (Twilio). Twilio remains the carrier — Sarvam doesn't place calls, it only handles the audio intelligence once a call exists.

### Step 9 — Twilio connects the call and asks the backend how to handle it

- **What happens:** Once answered, Twilio requests instructions. Instead of `<Connect><ConversationRelay>` (which hands STT/TTS to Twilio's own engine), the backend responds with `<Connect><Stream>`, opening a raw bidirectional audio WebSocket that the backend fully controls.
- **Tool/service:** Twilio webhook → `POST /twiml/connect`, responding with TwiML for Media Streams.
- **Architecture layer:** Twilio's cloud → backend, over the ngrok tunnel.
- **Trade-off:** ConversationRelay bundles STT, TTS, VAD, and interruption handling for you. Raw Media Streams hands that back to the backend — Pipecat is still used here as the Twilio bridge, but it now bridges to Gemini Live rather than to separate Sarvam STT/TTS calls.

### Step 10 — Twilio streams raw call audio to a live Gemini session

- **What happens:** Twilio's Media Streams opens a WebSocket and streams raw μ-law audio (8kHz) in both directions. Pipecat bridges this to a persistent Gemini 3.1 Flash Live session for the duration of the call, resampling audio to the format Gemini's Live API expects.
- **Tool/service:** Twilio Media Streams ↔ Pipecat ↔ Gemini 3.1 Flash Live (Google's real-time multimodal API), replacing the Sarvam STT/TTS connectors from the prior revision and the hand-rolled `ws`-based `conversationRelay.js` from v1.
- **Architecture layer:** Third-party (Twilio) ↔ backend (Pipecat bridge) ↔ third-party (Google), over ngrok.
- **New engineering detail:** audio format bridging (Twilio's 8kHz μ-law vs. Gemini Live's expected PCM sample rate) is now on the critical path — this didn't exist when Twilio's own ConversationRelay handled encoding internally.

### Step 11 — Backend speaks the opening line

- **What happens:** The compliance-critical opening line (identifies itself as automated, mentions recording, states the item/delivery question) is still pre-synthesized and templated, not model-generated — same principle as v1 and the prior revision, just enforced differently. It's played as a fixed audio clip before the Gemini Live session takes over the conversation, so the exact disclosure wording stays guaranteed rather than left to the live model's phrasing.
- **Tool/service:** Backend (`getOpeningLine()`) → pre-synthesized audio (Sarvam Bulbul or Gemini TTS, generated once and cached) → Media Streams → Twilio.
- **Architecture layer:** Backend, no live model call yet.

### Step 12 — The person responds; Gemini Live handles the turn natively

- **What happens:** The caller's speech goes straight into the live Gemini session — no separate transcription step, no separate LLM call, no separate TTS call. Gemini Live transcribes, reasons, and responds in one round trip, and its native multilingual support means it should follow the caller into Hindi, Hinglish, or English without an explicit language-detection step.
- **Tool/service:** Gemini 3.1 Flash Live, configured with system instructions (goal, tone/directness guidance, explicit language-mirroring instruction) and a function-calling tool matching the `end_call` schema (`canDeliver`, `price`, `etaMinutes`, `notes`).
- **Architecture layer:** Backend (Pipecat) orchestrates the session; the live audio/reasoning round trip is backend → Google, never exposed to the frontend.

### Step 13 — This repeats until Gemini has an answer

- **What happens:** The conversation continues inside the same live session — Gemini Live's native barge-in and turn-taking handle interruptions without Pipecat needing to manage VAD itself — until Gemini calls the `end_call` function with a structured result, or the 1-minute hard cap forces the call to end.
- **Tool/service:** Same live session as Step 12, continued; hard-cap timer unchanged (`twilioClient.calls(sid).update({status: "completed"})`).
- **Architecture layer:** Backend ↔ Twilio (audio transport) ↔ Google (Gemini Live), one continuous session instead of repeated discrete API calls.

### Step 14 — Backend records the outcome and ends the call

*(unchanged)*

- **Tool/service:** Backend in-memory store (`callResults` Map); Twilio `status-callback` webhook.
- **Architecture layer:** Backend only.

### Step 15 — Frontend polls for the result

*(unchanged)*

- **Tool/service:** `fetch()` → `GET /call-status/:callSid`.
- **Architecture layer:** Frontend → backend, HTTP.

### Step 16 — App speaks the outcome to the user

- **What happens:** Same composition logic, now spoken via Sarvam Bulbul for consistency with Steps 2/5/6, with Web Speech API as fallback.
- **Tool/service:** Sarvam Bulbul TTS (relay), Web Speech API fallback.
- **Architecture layer:** Frontend → backend relay → Sarvam API.

---

## Open questions / things to validate before committing to this version

- **Latency budget.** For the frontend (Steps 2, 5, 16), Sarvam adds a backend hop v1 didn't have; sub-250ms first-byte is solid on paper but should be measured end-to-end. For the call loop, Gemini Live's single-session model should reduce round trips versus a chained STT→LLM→TTS design, but this needs to be measured against both the ConversationRelay baseline and the prior Sarvam+Claude cascade before assuming it's faster in practice.
- **Audio format bridging for Gemini Live.** Twilio Media Streams delivers 8kHz μ-law; Gemini Live's API expects its own PCM format. Pipecat needs to handle this resampling reliably in both directions — this is new integration surface that didn't exist with ConversationRelay (which handled encoding internally) or wasn't fully specified in the prior Sarvam-based revision.
- **Tool-calling reliability under Gemini Live.** The `end_call` function needs to fire reliably with correctly structured output (`canDeliver`, `price`, `etaMinutes`, `notes`) inside a live, interruptible, multilingual session — a different reliability profile than a discrete Claude API call with a single clear turn. Needs real-call testing, especially near the 1-minute hard cap.
- **Gemini Live's tone/directness in Hindi.** Claude's tendency to be warmer and less direct in Hindi (per Anthropic's own cross-language research) was flagged as a risk for the prior Claude-based design. That specific finding doesn't automatically transfer to Gemini — but the same category of risk (a model being vaguer or less transactional in Hindi than in English) should be re-validated for Gemini Live specifically before relying on it for a task that needs a crisp, structured outcome.
- **Language gating on the frontend.** Routing every browser session through Sarvam via a relay adds infra even for English-only users. Worth detecting language/locale first and only using Sarvam when Hindi/Hinglish is likely, keeping Web Speech API as the default for English.
- **Compliance-line enforcement.** Confirm the pre-synthesized opening line (Step 11) actually plays in full before Gemini Live's session takes over turn-taking — a live model with barge-in enabled could technically let the caller interrupt before the disclosure finishes, which needs to be explicitly guarded against.

## Future exploration: Sarvam as a cost-benefit comparison

This version moves the call loop to Gemini 3.1 Flash Live for capability reasons
(native multilingual, native tool calling, single-session simplicity). It's still
worth running Sarvam (Saaras STT + Sarvam-30B/105B + Bulbul TTS, or a hybrid using
Sarvam for the frontend and Gemini only for the call) as a side-by-side cost
comparison once the Gemini Live version is working — Sarvam's INR-denominated,
India-hosted pricing could be meaningfully cheaper at volume, even if Gemini Live
wins on architectural simplicity today.
