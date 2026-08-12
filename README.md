# Find It Nearby

Tap the button, say what you're looking for (e.g. "where can I buy a cricket bat" or
"I need a plumber"), hear the top 3 nearby places read back to you, then pick one
(by voice or by clicking a card) to have an AI agent call the shop and ask about
delivery — reporting the outcome back to you out loud.

- `index.html` — page markup + Google Maps dynamic-library loader
- `styles.css` — styling and visual states
- `app.js` — state machine: click → listen → locate → search → speak → select → call → report
- `speech.js` — Web Speech API wrapper (speech-to-text + text-to-speech)
- `places.js` — Google Places API (New) text search, distance calc, top-3 ranking
- `config.js` — Google Maps API key, backend URL, delivery address (gitignored — copy `config.example.js` to create it)
- `server/` — small Node/Express + WebSocket backend that places the outbound call via Twilio and runs the conversation with Claude (see [server setup](#3-set-up-the-call-agent-backend) below)

## 1. Set up a Google Maps API key

You need this because there's no free API that can turn a spoken free-text request
("cricket bat") into ranked nearby businesses with ratings/hours and phone numbers.
The browser's own speech recognition and text-to-speech are free and used directly.

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

### Expected cost — correction

The fields this app requests (`rating`, `userRatingCount`, `currentOpeningHours`, and
now `nationalPhoneNumber`) fall under Google's **Text Search "Enterprise" tier** — the
app has actually been on this tier since it was first built, not "Pro" as an earlier
version of this doc said. Enterprise tier is **5,000 free calls/month**, then roughly
$35/1,000 after. Personal use (a handful of searches a day) won't come close to the
free allowance, so real-world cost should still be **$0/month** — this is just a
pricing-tier correction, not a new cost.

## 2. Set the delivery address

Edit `config.js`:

```js
window.DELIVERY_ADDRESS = "your address here";
```

This is the address the call agent gives to shops when asking about delivery. It's a
fixed value for now (no per-order prompt).

## 3. Set up the call agent backend

The "call the shop" feature places a real outbound phone call and runs a live AI
conversation on it — that can't happen from a browser alone, so `server/` is a small
Node/Express + WebSocket backend that handles it, built on **Twilio + Claude**.

### 3a. Twilio

1. Create an account at [twilio.com](https://www.twilio.com) and buy a phone number
   (~$1/month + per-minute usage).
2. **Twilio trial accounts can only call pre-verified numbers.** Since this app will
   dial your own test number (see below) that's fine for initial testing, but to ever
   call real shop numbers you'll need to upgrade the account (add a payment method)
   first — don't be surprised by this mid-build.
3. Note your **Account SID**, **Auth Token**, and the **phone number** you bought.

### 3b. Anthropic

Get an API key from [console.anthropic.com](https://console.anthropic.com) for the
server-side Claude calls that run the phone conversation.

### 3c. Testing safety override

For now, **every call dials a hardcoded test number (your own phone) instead of the
real shop** — regardless of which of the 3 results you pick. The conversation still
references the real shop name/item/address; only the actual phone destination is
swapped. This avoids accidentally calling real businesses while the agent is being
tested. Set your own number as `TEST_CALL_PHONE_NUMBER` below.

### 3d. Configure and run the backend

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
ANTHROPIC_API_KEY=...
PUBLIC_BASE_URL=https://xxxx.ngrok-free.app   # see 3e below
PORT=3001
CALL_HARD_CAP_MS=60000              # 1-minute hard cap on call length, for now
```

```powershell
npm start
```

### 3e. Expose it with ngrok (local dev)

Twilio needs a public HTTPS URL to reach your local backend for the webhook and the
ConversationRelay WebSocket.

```powershell
ngrok http 3001
```

Copy the `https://...ngrok-free.app` URL into `PUBLIC_BASE_URL` in `server/.env` and
restart the backend. **The free ngrok URL changes every time you restart the tunnel** —
update `PUBLIC_BASE_URL` and restart the backend again each dev session. If this gets
annoying, the upgrade path is deploying `server/` to a host with a stable URL (e.g.
Render's free tier) — not set up yet, just noted for later.

### 3f. Point the frontend at the backend

In `config.js`:

```js
window.BACKEND_URL = "http://localhost:3001"; // matches server/.env's PORT
```

(This is a plain `http://localhost` URL — the frontend calls your local backend
directly; only Twilio needs the public ngrok URL.)

### Cost expectation

Twilio per-minute voice + ConversationRelay usage charges (check Twilio's current
ConversationRelay pricing — this is a newer product), plus the phone number rental
fee (~$1/month), plus a small Claude API cost per call (a few short turns). Treat
every test call as a real, billed call.

### Consent/disclosure note (not legal advice)

The call agent always opens by identifying itself as an automated assistant calling
on behalf of a customer, and mentions the call may be recorded — a reasonable default
for personal use, not a compliance guarantee.

## 4. Run it locally

The app needs a real `http://` origin (not `file://`) for geolocation and speech
permissions to work reliably. `localhost` counts as secure, so a plain static server
is enough — no HTTPS needed for local dev.

```powershell
# Option A — Node (no install needed beyond npx)
npx serve . -l 5500

# Option B — Python, if installed
python -m http.server 5500
```

Then open **http://localhost:5500** in **Chrome or Edge**. Make sure `server/` (3d)
and ngrok (3e) are also running if you want to test the call feature.

## 5. Browser support

Speech recognition (`SpeechRecognition`) works in Chrome and Edge (desktop + Android),
and in Safari 14.1+. It's disabled by default in Firefox. The app detects this on load
and disables the button with a message if unsupported — use Chrome or Edge.

## Known limitations

- Results are limited to physical/local businesses, not online stores.
- No visual map is shown (kept out intentionally to avoid the separate billed
  "Dynamic Maps" SKU) — just a spoken summary and result cards.
- Each search re-requests your location; there's no persistent location caching across
  page reloads.
- Every call currently dials a hardcoded test number instead of the real shop (see 3c)
  — this is intentional for safe testing, not a bug.
- The call hard cap is 1 minute for now; raise `CALL_HARD_CAP_MS` in `server/.env`
  once the agent is trusted.
- The backend keeps call state in memory only — restarting it loses any in-progress
  call's context/result.
