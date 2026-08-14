# Version 2 — User Journey

Revised version of the original journey, incorporating Sarvam AI for the
Hindi/Hinglish speech layers on the frontend, and Gemini Live (native
speech-to-speech, replacing Sarvam STT + Claude + Sarvam TTS) for the phone call
loop, in place of Twilio ConversationRelay's built-in (English-first) STT/TTS.
Google Places and Twilio-as-carrier are kept as-is — those aren't speech/reasoning
problems, so there's nothing to swap.

**Status: implemented.** This document originally described a proposed redesign;
it's now been updated to describe what was actually built, including a few
deviations from the original proposal (no Pipecat — hand-rolled Node.js instead)
and details that could only be pinned down once real traffic was seen (exact wire
formats, sample rates, model IDs), plus two behavioral additions made after the
initial build: chat/search intent classification (Step 2.5) and a continuous
conversation loop (note after Step 6). Frontend speech (Steps 1–6, 16) has been
live end-to-end tested; the Gemini Live call loop (Steps 9–13) has not yet been
live-tested with a real call. See `CLAUDE.md`'s "Known-fragile areas" for what's
still best-effort.

**Update:** the call loop (Steps 9–13) uses Gemini Live instead of the Sarvam STT →
Claude → Sarvam TTS cascade from the previous revision. Gemini Live is a native
audio-in/audio-out model with built-in multilingual support (auto mid-conversation
language switching), native barge-in/turn-taking, and function calling — so it
collapses three hops (STT, LLM, TTS) into one live session and removes Claude from
the call path entirely. **Claude/Anthropic is no longer used anywhere in this
project.**

**Deviation from the original proposal:** the original doc assumed Pipecat (a
Python framework) would bridge Twilio Media Streams to Gemini Live. Since this
project is 100% JavaScript, the bridge was hand-rolled in Node.js instead
(`server/mediaStreamBridge.js` + `server/audioBridge.js`), reusing the existing
Twilio/WebSocket patterns already in the codebase and talking to Gemini Live
directly via Google's official `@google/genai` SDK. This meant writing the
audio format conversion (mulaw↔PCM16, resampling) by hand rather than getting it
for free from a framework — see Step 10.

## Summary of changes from v1

| Area | v1 | v2 (as built) | Why |
|---|---|---|---|
| Frontend STT (Step 2) | Web Speech API | Sarvam Saarika STT (codemix mode), Web Speech API as automatic fallback | Native Hinglish handling; code-switched speech sees a large WER jump on generic ASR |
| Query extraction (new Step 2.5) | — (raw transcript searched directly) | Gemini (`gemini-flash-latest`, non-Live) distills the raw transcript into a short English search phrase | Google Places' text search handles full English sentences far better than full Hindi/Hinglish sentences — confirmed live, a raw Hindi sentence returned zero Places results |
| Frontend TTS (Step 5, 16) | Web Speech API | Sarvam Bulbul V3, Web Speech API as fallback | Natural Hindi/Hinglish voice, correct Indian name pronunciation |
| Call audio + reasoning (Steps 9–13) | Twilio ConversationRelay (built-in STT/TTS) + Claude | Twilio Media Streams + hand-rolled Node.js bridge + Gemini Live | ConversationRelay's engine isn't tuned for Hindi/Hinglish; Gemini Live handles STT, reasoning, TTS, turn-taking, and tool calling natively in one multilingual session, instead of chaining three separate services |
| Response language (Steps 5, 16) | Always English | Detected language (`language_code` from Sarvam STT) selects English or Hindi response templates | User explicitly chose "respond in the language they spoke" over "always Hinglish" |
| Query extraction (Step 2.5) | Query extraction only | Extraction + chat/search intent classification, `/classify-request` (not `/extract-query`) | Non-search utterances (jokes, small talk) were being force-fed into Places searches and returning nonsense results |
| Conversation flow (Steps 1, 6, 16) | Single-shot: one tap → one exchange → idle | Continuous: "Stop Conversation" button, loops back to listening after every natural end-of-turn until the user explicitly stops | Avoids requiring a fresh tap for every exchange in a multi-turn conversation |
| Everything else | — | Unchanged | Geolocation, Places search mechanics, card selection, HTTP plumbing, in-memory state aren't speech-layer concerns |

---

### Step 1 — User taps the "Tap to Speak" button

- **What happens:** Mic permission (`getUserMedia`) and mic/`AudioContext`/
  `AudioWorklet` setup run in parallel with the Sarvam relay WebSocket
  connecting — this used to run only after the WS opened, which was adding
  real, user-visible latency (the UI invited speech before the app was
  actually capturing it). An `onListening` callback now fires only once both
  are ready, so the status text ("Listening... speak now") stays accurate.
- **Tool/service:** `navigator.mediaDevices.getUserMedia()` + `AudioWorkletNode`
  (`pcm-worklet.js`) on the frontend, in parallel with `WS /relay/stt` opening.
- **Architecture layer:** Frontend, in-browser only (mic path); frontend →
  backend relay connection also begins here.

### Step 2 — User speaks a request (e.g. "cricket bat kahan milega")

- **What happens:** The worklet posts raw Float32 samples every ~2.7ms; these
  are batched into ~200ms chunks, downsampled to 16kHz PCM16, wrapped in a WAV
  header (Sarvam's streaming STT rejected raw `pcm_s16le` — confirmed live,
  it requires `audio/wav`), and sent over the relay as they're captured.
  Sarvam returns a transcript plus a detected `language_code` (e.g. `"hi-IN"`),
  which is threaded through to Steps 5/6/16 to select response language.
- **Tool/service:** Sarvam Saarika STT (streaming WebSocket API,
  `wss://api.sarvam.ai/...?mode=codemix` — codemix mode has to be appended as
  a raw URL query param, since Sarvam's Node SDK silently drops the `mode`
  parameter), reached via a thin backend relay `WS /relay/stt`
  (`server/sttRelay.js`) since the API key can't live in browser JS. Web
  Speech API remains as an automatic fallback if the relay WS fails to open
  or errors.
- **Architecture layer:** Frontend → backend (relay only, WAV-wrapping is the
  only processing) → Sarvam API.
- **Decided against gating:** every session is always routed through Sarvam
  (no language-detection gating to fall back to Web Speech API for
  English-only sessions) — an explicit choice, since Web Speech API already
  covers the "relay unreachable" case as a safety net.

### Step 2.5 — Backend classifies the transcript: chat or search (new step, updated)

- **What happens:** The raw transcript (which can be a full sentence, e.g.
  "मुझे कुछ tennis balls चाहिए") is sent to a lightweight, non-Live Gemini call
  that first classifies the intent, then branches:
  - `"search"` — a request to find something nearby. The same call also
    distills the transcript into a short 2–5 word English search phrase
    (e.g. "tennis balls") before it's handed to Google Places, since
    Google Places' text search handles full English sentences far better
    than full Hindi/Hinglish sentences. Flow continues into Step 3/4 below.
  - `"chat"` — general conversation (jokes, small talk, questions not about
    finding a nearby place). The model also returns a short, natural,
    spoken-style reply in the same language the user spoke; the app speaks
    that reply directly and **skips geolocation/Places/search entirely** —
    see the "Continuous conversation loop" note after Step 6.
  This was originally scoped as pure query extraction (no chat branch); the
  chat intent was added afterward once it became clear that non-search
  utterances (e.g. "tell me a joke") were being force-fed into Places
  searches and returning nonsense results. On any failure (timeout, bad
  JSON, network error) this endpoint fails open to
  `{intent: "search", query: <raw transcript>}` rather than blocking the
  app — an 8s client-side timeout guards against the SDK call hanging
  indefinitely (an earlier real failure mode: no timeout left the frontend
  stuck on "Thinking…" forever).
- **Tool/service:** `POST /classify-request` (`server/queryExtraction.js`,
  `classifyRequest()`) → `ai.models.generateContent()` on
  `gemini-flash-latest` (confirmed against a live `ListModels` call with the
  real API key — an earlier guess, `"gemini-3.1-flash"`, doesn't exist and
  returned a 404).
- **Architecture layer:** Frontend → backend → third-party (Google), plain
  request/response (not a live session).

### Step 3 — App gets the user's current location

Only reached for the `"search"` branch of Step 2.5 (the `"chat"` branch
returns from Step 2.5 straight to speaking a reply — see the "Continuous
conversation loop" note after Step 6). The app first speaks a short
acknowledgment ("Sure, let me find that for you..." / Hindi equivalent,
chosen from the Step 2 `language_code`) so the user gets an immediate
audible response instead of dead air while geolocation/search run;
geolocation itself is kicked off in parallel with that acknowledgment being
spoken, not after it finishes.

- **Tool/service:** Browser Geolocation API.
- **Architecture layer:** Frontend, in-browser only.

### Step 4 — App searches for nearby places matching the request

*(unchanged, aside from searching the Step 2.5 output instead of the raw
transcript)*

- **Tool/service:** Google Places API (New) — `Place.searchByText()`, client-side.
- **Architecture layer:** Frontend → third-party (Google), no backend involved.

### Step 5 — App speaks the 3 results back to the user

- **What happens:** The results sentence (English or Hindi/Devanagari template,
  chosen from the Step 2 `language_code`) is sent to Sarvam Bulbul V3 over its
  streaming TTS WebSocket, which speaks shop names and Hinglish phrasing
  naturally rather than in a generic browser voice. `speech_sample_rate: 24000`
  is requested explicitly (Bulbul V3's own real default, confirmed live — an
  earlier guess of 22050Hz was wrong and caused garbled/wrong-pitch playback).
  Completion detection no longer relies on interpreting Sarvam's own message
  types or on the WebSocket closing (both were unreliable/ambiguous, and the
  latter risked truncating the last, largest audio chunk mid-flight) — the
  backend now sends its own explicit `{type: "relay-complete"}` signal to the
  browser right before it closes the Sarvam connection, either on a detected
  Sarvam completion event or an 800ms idle timer as a fallback (Sarvam doesn't
  reliably signal "done"; left open too long it gets killed server-side with a
  408).
- **Tool/service:** Sarvam Bulbul V3 (streaming TTS) via `WS /relay/tts`
  (`server/ttsRelay.js`). Web Speech API `SpeechSynthesis` as fallback.
- **Architecture layer:** Frontend → backend relay → Sarvam API.

### Step 6 — User selects one of the 3 results

- **What happens:** After the results are spoken, the app now speaks an
  explicit selection prompt ("Which one would you like? Say the first,
  second, or third option, or the shop's name" / Hindi equivalent) before it
  starts listening — the original implementation only updated on-screen
  status text at this point, which on a voice-driven app read as "nothing
  happened" if the user wasn't looking at the screen. Voice selection
  (parsing "option 1"/"pehla"/the shop's name from the transcript) is still
  English-number-word-only — **not yet language-aware** for the selection
  words themselves, even though the surrounding prompts are.
- **Tool/service:** Sarvam Saarika (voice path, same relay as Step 2) or DOM
  click/keyboard (card path, always available as a fallback).
- **Architecture layer:** Frontend, in-browser only (card path) / frontend →
  relay → Sarvam (voice path).

**Continuous conversation loop (new, not in the original proposal):** the app
no longer returns to idle after a single exchange. A "Stop Conversation"
button appears once the user taps "Tap to Speak"; a `conversationActive` flag
stays true until that button is pressed (or an unrecoverable error occurs).
Every natural end-of-turn point — a spoken chat reply (Step 2.5's `"chat"`
branch), zero search results, or a call outcome reported back (Step 16) —
loops back into listening for the next thing the user says
(`continueConversationOrIdle()` in `app.js`) instead of requiring a fresh tap
per exchange. A monotonically increasing `turnGeneration` counter is checked
after every `await` in the turn (classification, geolocation, Places search,
the `/call-shop` fetch) so that pressing "Stop Conversation" mid-turn causes
in-flight work to bail out silently rather than speaking/acting after the
user asked to stop.

### Step 7 — App asks the backend to call the shop

*(unchanged)*

- **Tool/service:** `fetch()` → `POST /call-shop` on the Node/Express backend.
- **Architecture layer:** Frontend → backend, HTTP.

### Step 8 — Backend places the outbound phone call

- **What happens:** Same as v1, with one intentional safety override during
  development: the call always dials `TEST_CALL_PHONE_NUMBER` from
  `server/.env`, never the real shop's number, regardless of which of the 3
  results was selected. The conversation content (shop name, item, address)
  still reflects the real selection — only the actual PSTN destination is
  swapped, so real businesses aren't called while the agent is being tested.
- **Tool/service:** Twilio Programmable Voice (`twilioClient.calls.create()`).
- **Architecture layer:** Backend → third-party (Twilio).

### Step 9 — Twilio connects the call and asks the backend how to handle it

*(unchanged from the proposal)*

- **What happens:** Once answered, Twilio requests instructions. Instead of
  `<Connect><ConversationRelay>` (which hands STT/TTS to Twilio's own engine),
  the backend responds with `<Connect><Stream>`, opening a raw bidirectional
  audio WebSocket (`/media-stream`) that the backend fully controls.
- **Tool/service:** Twilio webhook → `POST /twiml/connect`, responding with
  TwiML for Media Streams.
- **Architecture layer:** Twilio's cloud → backend, over the ngrok tunnel.

### Step 10 — Twilio streams raw call audio to a live Gemini session

- **What happens:** Twilio's Media Streams opens a WebSocket and streams raw
  mulaw audio (always 8kHz, mono — confirmed, no format negotiation available)
  in both directions. **No Pipecat** — a hand-rolled Node.js bridge
  (`server/mediaStreamBridge.js`) does this directly: inbound audio is
  mulaw-decoded and linearly resampled 8kHz→16kHz before being sent to Gemini
  Live (`sendRealtimeInput({audio: {data, mimeType: "audio/pcm;rate=16000"}})`);
  outbound audio from Gemini (PCM/24kHz) is resampled 24kHz→8kHz and
  mulaw-encoded before being sent back to Twilio as `media` events.
- **Tool/service:** Twilio Media Streams ↔ `server/mediaStreamBridge.js` ↔
  Gemini Live (`server/audioBridge.js` does the codec/resampling work, using
  the `alawmulaw` npm package for mulaw↔PCM16 and simple linear-interpolation
  resampling — sufficient since the two conversions needed are clean ratios,
  8k→16k exactly 2×, 24k→8k exactly 1/3×).
- **Architecture layer:** Third-party (Twilio) ↔ backend (hand-rolled bridge,
  not Pipecat) ↔ third-party (Google), over ngrok.

### Step 11 — Backend speaks the opening line

- **What happens:** The compliance-critical opening line (identifies itself
  as automated, mentions recording, states the item/delivery question) is
  still pre-synthesized and templated, not model-generated. It's synthesized
  once per call via Sarvam Bulbul V3, requesting `output_audio_codec: "mulaw"`
  and `speech_sample_rate: 8000` directly from Sarvam (Sarvam supports mulaw
  output natively, so no resampling is needed for this one line — unlike
  Step 10's general audio path). Critically, this now plays in full **before
  the Gemini Live session is even opened** — not just before turn-taking is
  enabled within an already-open session — closing the "could barge-in cut
  off the disclosure" gap flagged as an open question in the original
  proposal.
- **Tool/service:** Backend (`synthesizeOpeningLineMulaw()` in
  `mediaStreamBridge.js`) → Sarvam Bulbul V3 (same idle-timer-based completion
  pattern as Step 5) → Media Streams → Twilio.
- **Architecture layer:** Backend + Sarvam. No Gemini Live call yet.

### Step 12 — The person responds; Gemini Live handles the turn natively

- **What happens:** Once the opening line finishes, the Gemini Live session
  opens and the caller's speech goes straight into it — no separate
  transcription step, no separate LLM call, no separate TTS call. Gemini Live
  transcribes, reasons, and responds in one round trip, and its native
  multilingual support means it should follow the caller into Hindi, Hinglish,
  or English without an explicit language-detection step (system instruction
  explicitly tells it to mirror the caller's language).
- **Tool/service:** Gemini Live, model ID `gemini-3.1-flash-live-preview`
  (**unverified against a live session so far** — confirm in Google AI
  Studio's model picker before relying on it; unlike the Step 2.5 extraction
  model, this one hasn't yet been checked against a real `ListModels`
  response). Configured with a system instruction (goal, tone/directness
  guidance, explicit language-mirroring instruction) and an `end_call`
  function-calling tool (`canDeliver`, `price`, `etaMinutes`, `notes`).
- **Architecture layer:** Backend (`mediaStreamBridge.js`) orchestrates the
  session; the live audio/reasoning round trip is backend → Google, never
  exposed to the frontend.

### Step 13 — This repeats until Gemini has an answer

- **What happens:** The conversation continues inside the same live session
  until Gemini calls `end_call` with a structured result, or the 1-minute hard
  cap forces the call to end. On `end_call`, the backend sends a required
  `sendToolResponse` acknowledgment (Live API function calling is synchronous
  — Gemini won't continue until this is sent), lets Gemini speak its closing
  line, then ends the Twilio call once its turn completes.
- **Tool/service:** Same live session as Step 12, continued;
  `CALL_HARD_CAP_MS` (default 60,000ms / 1 minute) unchanged from v1.
- **Architecture layer:** Backend ↔ Twilio (audio transport) ↔ Google (Gemini
  Live), one continuous session instead of repeated discrete API calls.
- **Not yet live-tested end to end** — the frontend speech/search flow
  (Steps 1–6, 16) has been tested against real traffic; this call loop has
  only been implemented and code-reviewed so far, not exercised with a real
  phone call. Expect a round of "log a real session → fix field names" the
  same way ConversationRelay's field names needed correcting earlier in this
  project — raw Twilio and Gemini events are both logged for exactly this
  reason.

### Step 14 — Backend records the outcome and ends the call

*(unchanged)*

- **Tool/service:** Backend in-memory store (`callResults` Map); Twilio
  `status-callback` webhook.
- **Architecture layer:** Backend only.

### Step 15 — Frontend polls for the result

*(unchanged)*

- **Tool/service:** `fetch()` → `GET /call-status/:callSid`.
- **Architecture layer:** Frontend → backend, HTTP.

### Step 16 — App speaks the outcome to the user

*(unchanged from the proposal)*

- **What happens:** Same composition logic as Step 5, in the language detected
  back in Step 2, spoken via Sarvam Bulbul V3, with Web Speech API as fallback.
- **Tool/service:** Sarvam Bulbul TTS (relay), Web Speech API fallback.
- **Architecture layer:** Frontend → backend relay → Sarvam API.

---

## Resolved since the original proposal

- **Pipecat vs. hand-rolled** — resolved in favor of hand-rolled Node.js (see
  the deviation note at the top). No Python in this project.
- **Language gating on the frontend** — resolved: always route through
  Sarvam, no gating. Web Speech API's role is purely "relay unreachable"
  fallback, not "English-only fast path."
- **Compliance-line enforcement** — resolved: the opening line plays in full
  before the Gemini Live session even opens (Step 11), not merely before
  turn-taking within an open session.
- **Audio format bridging for Gemini Live** — resolved: `server/audioBridge.js`
  handles mulaw↔PCM16 codec + linear resampling in both directions.
- **Sarvam auth header** — confirmed live: `api-subscription-key`.
- **Sarvam STT input encoding** — confirmed live: requires WAV-wrapped audio,
  rejects raw `pcm_s16le`.
- **Sarvam TTS sample rate** — confirmed live: Bulbul V3's real default is
  24000Hz (not the originally guessed 22050Hz).
- **Sarvam TTS completion signaling** — confirmed live: no reliable "done"
  message; the client must close the connection itself (idle-timer-based, now
  with an explicit `relay-complete` signal sent to the browser first — see
  Step 5).
- **Query extraction model** — confirmed via live `ListModels`:
  `gemini-flash-latest` (the originally guessed `gemini-3.1-flash` doesn't
  exist).
- **Multiple `WebSocketServer` instances on one `http.Server`** — the
  obvious-looking `{server, path}` option per instance is broken with more
  than one instance sharing a server (only the first-registered worked,
  every other path got a blanket 400). Fixed with `{noServer: true}` +
  manual `server.on("upgrade", ...)` routing by pathname.

## Open questions / things to validate

- **Latency budget.** Sub-250ms first-byte TTS is solid on paper but hasn't
  been measured end-to-end for either the frontend (Steps 2, 5, 16) or the
  call loop (Steps 12–13).
- **Gemini Live model ID.** `gemini-3.1-flash-live-preview` is still a
  best-effort guess, unlike the extraction model which was confirmed against
  a real `ListModels` response — verify before shipping.
- **Tool-calling reliability under Gemini Live.** The `end_call` function
  needs to fire reliably with correctly structured output inside a live,
  interruptible, multilingual session. Needs real-call testing, especially
  near the 1-minute hard cap — not yet exercised at all (see Step 13).
- **Gemini Live's tone/directness in Hindi.** Whether Gemini is vaguer or
  less transactional in Hindi than in English (the same category of risk
  originally flagged for Claude) hasn't been validated for Gemini Live
  specifically.
- **Gemini Live's exact event shapes.** `serverContent`/`toolCall` field
  names in `mediaStreamBridge.js` are a best-effort reconstruction from docs,
  not yet verified against a live session's raw logs — the same class of
  risk that turned out wrong for Twilio ConversationRelay earlier in this
  project.
- **Voice selection language-awareness (Step 6).** Selection words
  ("option 1", "pehla", etc.) are still English-number-word-only, even though
  the surrounding prompts/results are now language-aware.

## Future exploration: Sarvam as a cost-benefit comparison

This version moved the call loop to Gemini Live for capability reasons (native
multilingual, native tool calling, single-session simplicity). It's still worth
running Sarvam (Saaras STT + an LLM + Bulbul TTS, or a hybrid using Sarvam for
the frontend and Gemini only for the call) as a side-by-side cost comparison
once the Gemini Live call loop has been live-call-tested — Sarvam's
INR-denominated, India-hosted pricing could be meaningfully cheaper at volume,
even if Gemini Live wins on architectural simplicity today.
