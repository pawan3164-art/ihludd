# Find It Nearby

Tap the button, say what you're looking for (e.g. "cricket bat kahan milega" or
"where can I buy a cricket bat"), hear the top 3 nearby places read back to you, then
pick one (by voice or by clicking a card) to have an AI agent call the shop and ask
about delivery — reporting the outcome back to you out loud.

Speech is now handled by **Sarvam AI** (Saarika STT in codemix mode + Bulbul V3 TTS)
for native Hindi/Hinglish support, with the browser's own Web Speech API kept as an
automatic fallback if Sarvam is unreachable. The phone-call agent runs on **Gemini
Live** (native speech-in/speech-out + tool calling in one live session) over raw
Twilio Media Streams — **Claude is no longer used anywhere in this project.**

- `index.html` — page markup + Google Maps dynamic-library loader
- `styles.css` — styling and visual states
- `app.js` — state machine: click → listen → locate → search → speak → select → call → report
- `speech.js` — Sarvam AI STT/TTS via the backend relay, with Web Speech API as fallback
- `pcm-worklet.js` — AudioWorklet processor that captures raw mic samples for the Sarvam relay
- `places.js` — Google Places API (New) text search, distance calc, top-3 ranking
- `config.js` — Google Maps API key, backend URL, delivery address (gitignored — copy `config.example.js` to create it)
- `server/` — Node/Express + WebSocket backend: Sarvam STT/TTS relays, and the Twilio
  Media Streams ↔ Gemini Live call agent (see [server setup](#3-set-up-the-backend) below)
  - `sttRelay.js` / `ttsRelay.js` — thin WebSocket proxies to Sarvam (hold the API key)
  - `mediaStreamBridge.js` — Twilio Media Streams ↔ Gemini Live audio/tool-call bridge
  - `audioBridge.js` — mulaw ↔ PCM16 codec + resampling between Twilio's and Gemini's audio formats

> **Heads up — newer integrations, expect some rough edges.** The exact WebSocket
> message shapes for Sarvam and Gemini Live in this codebase are a best-effort
> reconstruction from their docs, not yet verified against real traffic. The backend
> logs every raw message from both — the same approach that was needed to get Twilio's
> ConversationRelay working correctly earlier in this project's history (see
> `versions/version 1.md`). Expect to fix a field name or two after your first real
> test call/session, not because anything was done wrong.

## 1. Set up a Google Maps API key

You need this because there's no free API that can turn a spoken free-text request
("cricket bat") into ranked nearby businesses with ratings/hours and phone numbers.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create (or
   select) a project.
2. **APIs & Services → Library** → enable **"Places API (New)"** and
   **"Maps JavaScript API"**.
3. **Billing** → link a billing account. A card is required to enable the API even
   though your usage should stay free — see costs below.
4. **APIs & Services → Credentials** → **Create Credentials → API key**.
5. Click the new key to restrict it:
   - **Application restrictions → HTTP referrers**, add:
     - `http://localhost:5500/*`
     - `http://127.0.0.1:5500/*`
     - (add your LAN IP too if you want to test on your phone, e.g. `http://192.168.1.23:5500/*`)
   - **API restrictions** → restrict to just "Places API (New)" and "Maps JavaScript API".
6. Copy `config.example.js` to `config.js` (gitignored, so your key never gets committed) and
   paste the key in:
   ```js
   window.GOOGLE_MAPS_API_KEY = "paste-your-key-here";
   ```

### Expected cost

Text Search Enterprise tier (the fields this app requests) includes **5,000 free
calls/month**, then roughly $35/1,000 after. Personal use (a handful of searches a
day) won't come close to the free allowance, so real-world cost should stay **$0/month**.

## 2. Set the delivery address

Edit `config.js`:

```js
window.DELIVERY_ADDRESS = "your address here";
```

This is the address the call agent gives to shops when asking about delivery. It's a
fixed value for now (no per-order prompt).

## 3. Set up the backend

The Sarvam speech relays and the outbound call agent both need a backend — Sarvam and
Gemini API keys can't live in browser JS, and placing/running a live phone call can't
happen from a browser at all.

### 3a. Twilio

1. Create an account at [twilio.com](https://www.twilio.com) and buy a phone number
   (~$1/month + per-minute usage).
2. **Twilio trial accounts can only call pre-verified numbers.** Since this app will
   dial your own test number (see below) that's fine for initial testing, but to ever
   call real shop numbers you'll need to upgrade the account (add a payment method)
   first — don't be surprised by this mid-build.
3. Note your **Account SID**, **Auth Token**, and the **phone number** you bought.

### 3b. Sarvam AI

Get an API key from [dashboard.sarvam.ai](https://dashboard.sarvam.ai) — powers the
frontend's speech-to-text (Saarika, codemix mode for Hindi/Hinglish) and text-to-speech
(Bulbul V3), plus the pre-synthesized call-opening line.

### 3c. Google Gemini

Get an API key from [aistudio.google.com](https://aistudio.google.com) — powers the
live phone-call agent (Gemini Live).

### 3d. Testing safety override

For now, **every call dials a hardcoded test number (your own phone) instead of the
real shop** — regardless of which of the 3 results you pick. The conversation still
references the real shop name/item/address; only the actual phone destination is
swapped. This avoids accidentally calling real businesses while the agent is being
tested. Set your own number as `TEST_CALL_PHONE_NUMBER` below.

### 3e. Configure and run the backend

```powershell
cd server
npm install
copy .env.example .env
```

Fill in `server/.env`:

```
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+1...
TEST_CALL_PHONE_NUMBER=+1...        # your own phone, for safe testing
SARVAM_API_KEY=...
GEMINI_API_KEY=...
PUBLIC_BASE_URL=https://xxxx.ngrok-free.app   # see 3f below
PORT=3001
CALL_HARD_CAP_MS=60000              # 1-minute hard cap on call length, for now
```

```powershell
npm start
```

### 3f. Expose it with ngrok (local dev)

Twilio needs a public HTTPS URL to reach your local backend for the webhook and the
Media Streams WebSocket.

```powershell
ngrok http 3001
```

Copy the `https://...ngrok-free.app` URL into `PUBLIC_BASE_URL` in `server/.env` and
restart the backend. **The free ngrok URL changes every time you restart the tunnel** —
update `PUBLIC_BASE_URL` and restart the backend again each dev session. If this gets
annoying, the upgrade path is deploying `server/` to a host with a stable URL (e.g.
Render's free tier) — not set up yet, just noted for later.

### 3g. Point the frontend at the backend

In `config.js`:

```js
window.BACKEND_URL = "http://localhost:3001"; // matches server/.env's PORT
```

(This is a plain `http://localhost` URL — the frontend calls your local backend
directly, including for the Sarvam speech relays; only Twilio needs the public ngrok URL.)

### Cost expectation

Sarvam AI usage (STT + TTS, billed per their current pricing), Twilio per-minute voice
+ Media Streams usage, the phone number rental fee (~$1/month), and Gemini Live usage
per call. Treat every test call/session as real, billed usage.

### Consent/disclosure note (not legal advice)

The call agent always opens with a pre-synthesized line identifying itself as an
automated assistant calling on behalf of a customer, and mentions the call may be
recorded — played in full *before* the live Gemini session starts, so a caller talking
over it can't cut off the disclosure. A reasonable default for personal use, not a
compliance guarantee.

## 4. Run it locally

The app needs a real `http://` origin (not `file://`) for geolocation, microphone
access, and the Sarvam relay WebSockets to work reliably. `localhost` counts as
secure, so a plain static server is enough — no HTTPS needed for local dev.

```powershell
# Option A — Node (no install needed beyond npx)
npx serve . -l 5500

# Option B — Python, if installed
python -m http.server 5500
```

Then open **http://localhost:5500**. Make sure `server/` (3e) and ngrok (3f) are also
running.

## 5. Browser support

The primary speech path (Sarvam via the backend relay) needs `getUserMedia`,
`AudioContext`/`AudioWorklet`, and `WebSocket` — supported in every modern browser
(Chrome, Edge, Firefox, Safari), a meaningfully wider footprint than the old
Web-Speech-API-only version. The automatic fallback (used only if the Sarvam relay is
unreachable) still relies on `SpeechRecognition`, which works in Chrome/Edge/Safari
14.1+ but is disabled by default in Firefox — on Firefox, expect the fallback itself
to be unavailable if Sarvam can't be reached, rather than the whole app being blocked
up front the way it was in the Web-Speech-only version.

## Known limitations

- Results are limited to physical/local businesses, not online stores.
- No visual map is shown (kept out intentionally to avoid the separate billed
  "Dynamic Maps" SKU) — just a spoken summary and result cards.
- Each search re-requests your location; there's no persistent location caching across
  page reloads.
- Every call currently dials a hardcoded test number instead of the real shop (see 3d)
  — this is intentional for safe testing, not a bug.
- The call hard cap is 1 minute for now; raise `CALL_HARD_CAP_MS` in `server/.env`
  once the agent is trusted.
- The backend keeps call state in memory only — restarting it loses any in-progress
  call's context/result.
- Sarvam/Gemini Live message shapes are unverified against real traffic — see the
  callout at the top of this file.
- TTS playback (both the frontend's Sarvam voice and the call's opening line) assumes
  specific sample rates/voice names that may need adjusting once you can hear real
  output — check `speech.js` and `mediaStreamBridge.js` if audio sounds wrong (pitch,
  speed) rather than assuming it's broken.
