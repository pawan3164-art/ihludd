// WebSocket handler for Twilio ConversationRelay sessions.
// Message shapes confirmed against live traffic (see call log):
//   in  — {type: "setup", callSid, ...}, {type: "prompt", voicePrompt, last}
//   out — {type: "text", token, last}, {type: "end"}
const { getOpeningLine, getNextTurn } = require("./callAgent");

function attachConversationRelay(wss, { callContexts, callResults }) {
  wss.on("connection", (ws) => {
    let callSid = null;
    let context = null;
    const transcript = [];

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.error("Bad ConversationRelay message", err);
        return;
      }

      console.log("ConversationRelay message:", JSON.stringify(msg));

      if (msg.type === "setup") {
        callSid = msg.callSid;
        context = callContexts.get(callSid);
        if (!context) {
          console.error(`No call context found for call ${callSid}`);
          ws.close();
          return;
        }

        const opening = getOpeningLine(context);
        transcript.push({ role: "assistant", text: opening });
        ws.send(JSON.stringify({ type: "text", token: opening, last: true }));
        return;
      }

      if (msg.type === "prompt") {
        if (!context) return;
        if (!msg.voicePrompt) {
          console.warn("Prompt event had no text, ignoring:", JSON.stringify(msg));
          return;
        }
        transcript.push({ role: "user", text: msg.voicePrompt });

        let turn;
        try {
          turn = await getNextTurn(context, transcript);
        } catch (err) {
          console.error(`Claude turn failed for call ${callSid}`, err);
          ws.send(
            JSON.stringify({
              type: "text",
              token: "Sorry, I'm having trouble right now. Thanks for your time, goodbye.",
              last: true,
            })
          );
          ws.send(JSON.stringify({ type: "end" }));
          return;
        }

        if (turn.type === "end") {
          callResults.set(callSid, { status: "completed", ...turn.summary });
          transcript.push({ role: "assistant", text: turn.closingLine });
          ws.send(
            JSON.stringify({ type: "text", token: turn.closingLine, last: true })
          );
          ws.send(JSON.stringify({ type: "end" }));
          return;
        }

        transcript.push({ role: "assistant", text: turn.text });
        ws.send(JSON.stringify({ type: "text", token: turn.text, last: true }));
        return;
      }

      // "interrupt" (caller spoke over the agent) needs no handling here —
      // ConversationRelay itself manages truncating playback.
    });

    ws.on("close", () => {
      if (callSid && callResults.get(callSid)?.status === "in-progress") {
        callResults.set(callSid, { status: "no-answer" });
      }
    });
  });
}

module.exports = { attachConversationRelay };
