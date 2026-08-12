# User Journey — Find It Nearby (Voice Search + AI Call Agent)

Step-by-step walk-through of a single user journey, from tapping the button to
hearing the final outcome. Each step lists what happens, which tool/service
handles it, and which part of the architecture (frontend / backend / third-party)
it runs in.

---

### Step 1 — User taps the "Tap to Speak" button
- **What happens:** Browser requests microphone permission and starts listening.
- **Tool/service:** Web Speech API — `SpeechRecognition` (via `speech.js`'s
  `Speech.listenOnce()`).
- **Architecture layer:** Frontend, in-browser only. Free, no network call.

### Step 2 — User speaks a request (e.g. "where can I buy a cricket bat")
- **What happens:** Browser's speech recognizer transcribes the audio to text and
  returns it via a callback.
- **Tool/service:** Web Speech API (`SpeechRecognition.onresult`).
- **Architecture layer:** Frontend, in-browser only.

### Step 3 — App gets the user's current location
- **What happens:** Browser prompts for location permission and returns
  coordinates.
- **Tool/service:** Browser Geolocation API (`navigator.geolocation.getCurrentPosition`).
- **Architecture layer:** Frontend, in-browser only.

### Step 4 — App searches for nearby places matching the request
- **What happens:** The transcribed text + coordinates are sent to Google's
  Places search; results come back with name, address components, rating,
  opening hours, and phone number.
- **Tool/service:** Google Places API (New) — `Place.searchByText()`, called
  directly from the browser via `google.maps.importLibrary("places")`
  (`places.js`).
- **Architecture layer:** Frontend → third-party API (Google), no backend
  involved. Client-side distance calculation (haversine) and area-name
  extraction (from `addressComponents`) happen locally in `places.js`, then the
  list is trimmed to the top 3.

### Step 5 — App speaks the 3 results back to the user
- **What happens:** A sentence like "Here are the top 3 results... 1. Decathlon
  Sports, 1.2 kilometers away, in Koramangala..." is generated and spoken aloud;
  the same 3 results render as clickable cards.
- **Tool/service:** Web Speech API — `SpeechSynthesis` (`Speech.speak()`).
- **Architecture layer:** Frontend, in-browser only.

### Step 6 — User selects one of the 3 results
- **What happens:** The app listens again for a spoken selection ("option 2",
  "the second one", or a shop name) while the cards are simultaneously clickable
  — whichever happens first wins.
- **Tool/service:** Web Speech API (`SpeechRecognition`) for the voice path;
  plain DOM click/keyboard events for the card path (`app.js`'s
  `parseSelection()` / `selectPlace()`).
- **Architecture layer:** Frontend, in-browser only.

### Step 7 — App asks the backend to call the shop
- **What happens:** The frontend sends the selected shop's phone number, name,
  the original spoken query, and the (fixed, pre-configured) delivery address to
  the backend.
- **Tool/service:** `fetch()` → `POST /call-shop` on the local Node/Express
  backend (`server/index.js`).
- **Architecture layer:** Frontend → backend, over plain HTTP on `localhost`
  (different port than the frontend, so CORS is enabled backend-side).

### Step 8 — Backend places the outbound phone call
- **What happens:** The backend calls Twilio's API to dial out. It stores the
  call's context (shop name/item/address) in memory keyed by the call ID, starts
  a 1-minute hard-cap timer, and returns the call ID to the frontend.
- **Tool/service:** Twilio Programmable Voice (`twilioClient.calls.create()`),
  via the `twilio` Node SDK.
- **Architecture layer:** Backend → third-party API (Twilio). (Currently dials a
  hardcoded test number instead of the real shop, as a safety override during
  testing — the conversation itself still references the real shop/item/address.)

### Step 9 — Twilio connects the call and asks the backend how to handle it
- **What happens:** Once the call is answered, Twilio makes an HTTP request to
  the backend asking for call instructions.
- **Tool/service:** Twilio webhook → `POST /twiml/connect` on the backend,
  responding with TwiML (`<Connect><ConversationRelay url="wss://.../conversation-relay"/></Connect>`).
- **Architecture layer:** Third-party (Twilio's cloud) → backend, reachable
  only because the backend is tunneled to a public URL via **ngrok** (Twilio
  cannot reach `localhost` directly).

### Step 10 — Twilio opens a live conversation channel to the backend
- **What happens:** Twilio's ConversationRelay opens a WebSocket connection to
  the backend and sends a `setup` message containing the call ID.
- **Tool/service:** Twilio ConversationRelay (handles the call's speech-to-text
  and text-to-speech itself) ↔ backend WebSocket server (`server/conversationRelay.js`,
  built on the `ws` library, sharing the same HTTP server as Express).
- **Architecture layer:** Third-party (Twilio) ↔ backend, over the ngrok tunnel.

### Step 11 — Backend speaks the opening line
- **What happens:** The backend looks up the call's context and sends a
  templated opening line (identifies itself as an automated assistant, mentions
  the call may be recorded, states the item/delivery question) back over the
  WebSocket.
- **Tool/service:** Backend (`callAgent.js`'s `getOpeningLine()`) → Twilio
  ConversationRelay, which converts the text to speech and plays it into the
  call.
- **Architecture layer:** Backend, no LLM call yet — this line is templated, not
  generated, so the exact disclosure wording is guaranteed.

### Step 12 — The person on the call responds, and the backend asks Claude what to say next
- **What happens:** Whoever answers speaks; ConversationRelay transcribes it and
  sends a `prompt` message to the backend. The backend appends it to the
  conversation transcript and asks Claude for the next turn.
- **Tool/service:** Twilio ConversationRelay (speech-to-text) → backend →
  **Claude API** (`claude-opus-5`, via the Anthropic Node SDK in `callAgent.js`),
  with a system prompt describing the goal and an `end_call` tool Claude can
  invoke once it has a clear answer.
- **Architecture layer:** Backend orchestrates; the LLM call is backend → third-
  party API (Anthropic), never exposed to the frontend or the call itself.

### Step 13 — This repeats until Claude has an answer
- **What happens:** Each further response from the other party goes through the
  same loop (transcribe → send to Claude → speak Claude's reply) until Claude
  calls the `end_call` tool with a structured result (`canDeliver`, `price`,
  `etaMinutes`, `notes`), or the 1-minute hard cap forces the call to end.
- **Tool/service:** Same as Step 12, looped; the hard-cap timer uses
  `twilioClient.calls(sid).update({status: "completed"})` to force-end if needed.
- **Architecture layer:** Backend ↔ Twilio ↔ Claude API, repeated turns.

### Step 14 — Backend records the outcome and ends the call
- **What happens:** Once Claude signals completion (or the call times out, goes
  unanswered, or fails), the backend stores the final result in memory, keyed by
  call ID.
- **Tool/service:** Backend in-memory store (`callResults` Map); Twilio's
  `status-callback` webhook (`POST /status-callback`) also reports final call
  status (e.g. "no-answer") if the call never got that far.
- **Architecture layer:** Backend only.

### Step 15 — Frontend polls for the result
- **What happens:** While the call is happening, the frontend has been polling
  the backend every 2 seconds for a result, showing "Calling... this may take a
  minute."
- **Tool/service:** `fetch()` → `GET /call-status/:callSid`, polled from
  `app.js`.
- **Architecture layer:** Frontend → backend, plain HTTP.

### Step 16 — App speaks the outcome to the user
- **What happens:** Once a final result arrives, the frontend composes a
  sentence (e.g. "Decathlon Sports can deliver your cricket bat — it'll cost
  150 rupees and take about 30 minutes") and speaks it aloud, then returns to
  idle, ready for the next request.
- **Tool/service:** Web Speech API — `SpeechSynthesis` (`Speech.speak()`).
- **Architecture layer:** Frontend, in-browser only.

---

## Tools/services touched across the whole journey

| Tool/service | Role | Layer |
|---|---|---|
| Web Speech API (`SpeechRecognition` + `SpeechSynthesis`) | All speech in/out on the user's device | Frontend, browser-native, free |
| Browser Geolocation API | User's current location | Frontend, browser-native |
| Google Places API (New) | Nearby business search | Frontend → third-party API |
| Node/Express backend (`server/`) | Orchestrates the call, holds secrets, exposes REST endpoints | Backend (local process) |
| `ws` (WebSocket library) | Live channel for the in-call conversation | Backend |
| ngrok | Public tunnel so Twilio's cloud can reach the local backend | Infrastructure (dev-only) |
| Twilio Programmable Voice + ConversationRelay | Places the call, handles in-call STT/TTS | Third-party API |
| Claude API (`claude-opus-5`, Anthropic SDK) | Drives the phone conversation, produces the structured outcome | Backend → third-party API |
