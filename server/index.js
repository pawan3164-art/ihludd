require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");
const { attachConversationRelay } = require("./conversationRelay");

const PORT = process.env.PORT || 3001;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const CALL_HARD_CAP_MS = Number(process.env.CALL_HARD_CAP_MS || 60_000);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();

// The frontend (served from a different port, e.g. localhost:5500) calls this
// backend directly from the browser — allow that cross-origin request.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio webhooks are form-encoded

// In-memory, single-process state — fine at personal-use scale, no DB needed.
const callContexts = new Map(); // callSid -> { phoneNumber, shopName, itemQuery, deliveryAddress }
const callResults = new Map(); // callSid -> { status, ...summary }
const callTimers = new Map(); // callSid -> Timeout

app.post("/call-shop", async (req, res) => {
  const { phoneNumber, shopName, itemQuery, deliveryAddress } = req.body;
  if (!phoneNumber || !shopName || !itemQuery || !deliveryAddress) {
    res
      .status(400)
      .json({ error: "Missing phoneNumber, shopName, itemQuery, or deliveryAddress." });
    return;
  }
  if (!PUBLIC_BASE_URL) {
    res
      .status(500)
      .json({ error: "Server misconfigured: PUBLIC_BASE_URL is not set." });
    return;
  }

  // Testing safety override: always dial our own test number, never the real
  // shop, while the conversation itself still references the real shop/item/
  // address. Remove this override once ready to call real shops.
  const destination = process.env.TEST_CALL_PHONE_NUMBER;
  if (!destination) {
    res
      .status(500)
      .json({ error: "Server misconfigured: TEST_CALL_PHONE_NUMBER is not set." });
    return;
  }

  try {
    const call = await twilioClient.calls.create({
      to: destination,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${PUBLIC_BASE_URL}/twiml/connect`,
      statusCallback: `${PUBLIC_BASE_URL}/status-callback`,
      statusCallbackEvent: ["completed"],
    });

    callContexts.set(call.sid, { phoneNumber, shopName, itemQuery, deliveryAddress });
    callResults.set(call.sid, { status: "in-progress" });

    const timer = setTimeout(() => forceEndCall(call.sid), CALL_HARD_CAP_MS);
    callTimers.set(call.sid, timer);

    res.json({ callSid: call.sid });
  } catch (err) {
    console.error("Failed to place call", err);
    res.status(500).json({ error: "Failed to place call." });
  }
});

app.post("/twiml/connect", (req, res) => {
  const host = new URL(PUBLIC_BASE_URL).host;
  res.type("text/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${host}/conversation-relay" />
  </Connect>
</Response>`);
});

app.post("/status-callback", (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus; // e.g. 'completed', 'no-answer', 'busy', 'failed'
  const existing = callResults.get(callSid);

  if ((!existing || existing.status === "in-progress") && status !== "completed") {
    callResults.set(callSid, { status: "no-answer" });
  }

  const timer = callTimers.get(callSid);
  if (timer) {
    clearTimeout(timer);
    callTimers.delete(callSid);
  }

  res.sendStatus(204);
});

app.get("/call-status/:callSid", (req, res) => {
  const result = callResults.get(req.params.callSid);
  res.json(result || { status: "in-progress" });
});

async function forceEndCall(callSid) {
  const result = callResults.get(callSid);
  if (result && result.status !== "in-progress") return;

  callResults.set(callSid, { status: "timed-out" });
  try {
    await twilioClient.calls(callSid).update({ status: "completed" });
  } catch (err) {
    console.error(`Failed to force-end call ${callSid}`, err);
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/conversation-relay" });
attachConversationRelay(wss, { callContexts, callResults });

server.listen(PORT, () => {
  console.log(`Find It Nearby call server listening on port ${PORT}`);
});
