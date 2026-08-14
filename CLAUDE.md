# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Find It Nearby" — a voice-driven web app. The user speaks a request (English or
Hindi/Hinglish), the app finds the top 3 nearby physical businesses via Google Places,
speaks the results back, and — once the user picks one — places a real outbound phone
call to that shop where an AI agent (Gemini Live, over Twilio) asks about delivery and
reports the outcome back by voice.

**Claude/Anthropic is not used anywhere in the current codebase.** An earlier version
of this app used Twilio ConversationRelay + Claude for the call agent; it was replaced
with Twilio Media Streams + Gemini Live (see `versions/version 1.md` and
`versions/version 2.md` for that history/rationale — those are point-in-time design
docs, not living documentation; don't treat them as current).

## Commands

No build step, no test suite, no linter — don't go looking for one.

**Frontend** (plain HTML/CSS/JS, no npm dependencies, no root `package.json`):
```powershell
npx serve . -l 5500        # or: python -m http.server 5500
```
Open `http://localhost:5500` in Chrome or Edge.

**Backend** (`server/`, Node/Express — this is the only directory with `npm`):
```powershell
cd server
npm install
npm start                  # node index.js, listens on PORT (default 3001)
```

**For the phone-call feature to work end to end**, all three of these must be running
simultaneously: the frontend static server, the backend (`server/`), and `ngrok http
3001` (Twilio needs a public URL to reach the local backend — see README.md for the
full env var / API key setup, which is not repeated here).

Sanity-check any change with `node --check <file>` — that's the extent of the
verification tooling in this repo.

## Architecture

Three external services, each doing a different job, coordinated by a thin
Node/Express backend:

- **Google Places API (New)** — called directly from the browser (`places.js`), no
  backend involved. Client-side only integration in this app.
- **Sarvam AI** (Saarika STT + Bulbul V3 TTS) — powers all frontend speech (both
  directions). The API key can't live in browser JS, so the browser talks to it only
  through backend WebSocket proxies: `server/sttRelay.js` and `server/ttsRelay.js`.
  `speech.js` captures mic audio via an AudioWorklet (`pcm-worklet.js`), batches it,
  and streams it through the relay; Web Speech API (`SpeechRecognition`/
  `SpeechSynthesis`) is kept as an automatic fallback if the relay fails.
- **Twilio + Gemini Live** — the phone-call agent. `server/mediaStreamBridge.js`
  bridges Twilio's raw Media Streams audio (mulaw, 8kHz, fixed — no format
  negotiation) to a Gemini Live session (PCM16/16kHz in, PCM/24kHz out) via
  `server/audioBridge.js` (mulaw↔PCM codec + linear resampling). Gemini Live handles
  STT, reasoning, and TTS in one live session and signals the outcome via an
  `end_call` function-calling tool.

Backend request flow for a call: `POST /call-shop` → `twilioClient.calls.create()` →
Twilio requests TwiML from `POST /twiml/connect` (returns `<Connect><Stream>`) →
Twilio opens a WebSocket to `/media-stream` → `mediaStreamBridge.js` plays a
pre-synthesized (Sarvam TTS, not live-generated) disclosure line in full *before*
opening the Gemini Live session, so the caller can't barge in over the disclosure →
live conversation runs until Gemini calls `end_call` or the hard-cap timer fires →
result lands in an in-memory `callResults` Map, polled by the frontend via
`GET /call-status/:callSid`.

All call/session state (`callContexts`, `callResults`, timers in `server/index.js`)
is in-memory, single-process — restarting the backend loses any in-progress call.

**Request classification step**: the raw spoken transcript is never searched or
routed directly — `POST /classify-request` (`server/queryExtraction.js`) uses a
plain (non-Live) Gemini call to first classify it as either `chat` (general
conversation — jokes, small talk; the app speaks a direct reply and returns to
idle, no search happens) or `search` (a request to find something nearby). For
`search`, the same call also distills the transcript (which can be a full
sentence, e.g. "मुझे कुछ tennis balls चाहिए") into a short English search phrase,
because Google Places' text search handles full English sentences much better
than full Hindi/Hinglish sentences. On any failure this endpoint fails open to
`{intent: "search", query: <raw transcript>}` rather than blocking the app.

**Language handling**: Sarvam's STT response includes a detected `language_code`
(e.g. `"hi-IN"`); `app.js` threads this through to select English or Hindi
(Devanagari) response templates and to tell the TTS relay which voice/language to
synthesize with. Selection input (saying "option 1"/"pehla"/etc.) is still
English-number-word-only — not yet language-aware.

**Safety override, intentional, don't "fix" without being asked**: every call
currently dials `TEST_CALL_PHONE_NUMBER` from `server/.env` — never the real shop's
number — regardless of which of the 3 results was selected. The conversation content
(shop name, item, address) still reflects the real selection; only the actual PSTN
destination is swapped. This exists to avoid placing real calls to businesses while
the agent is being developed/tested.

### Known-fragile areas

- **Sarvam AI and Gemini Live wire formats are best-effort reconstructions from
  docs/SDK type definitions, not fully verified against production traffic.** Expect
  message-shape surprises. Every relay/bridge module logs raw messages from these
  services specifically so field-name mismatches can be diagnosed from real traffic
  rather than guessed again — check those logs first when something in the speech or
  call pipeline misbehaves, don't assume the code's current assumption is correct.
- **Multiple `WebSocketServer` instances share one `http.Server`** (`/media-stream`,
  `/relay/stt`, `/relay/tts` in `server/index.js`). This must use `noServer: true` +
  manual `server.on("upgrade", ...)` routing by pathname — the more obvious-looking
  `new WebSocketServer({server, path})` per instance is broken when more than one
  instance shares a server (confirmed: only the first-registered instance actually
  worked; every other path, including nonexistent ones, silently got a blanket 400).
- Audio sample rates/voice names in the Sarvam TTS playback path (`speech.js`,
  `mediaStreamBridge.js`) are best-guess and may need correcting once real audio
  output can be heard — if playback sounds wrong (pitch/speed/garbled), check the
  assumed sample rate against what Sarvam's response actually reports before assuming
  a logic bug elsewhere.
