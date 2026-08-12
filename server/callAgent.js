// Claude conversation logic for the outbound delivery-check call.
// Uses a templated opening line (guarantees the disclosure wording is always
// exact) and Claude for every turn after that, with an `end_call` tool so
// the model itself signals when it has a clean, structured answer.
const Anthropic = require("@anthropic-ai/sdk");

// Requesting plain (non-gzip) responses avoids a class of "Premature close"
// stream errors seen when a network hop interrupts a chunked+gzipped response.
const anthropic = new Anthropic({
  defaultHeaders: { "accept-encoding": "identity" },
});

const END_CALL_TOOL = {
  name: "end_call",
  description:
    "Call this once you have a clear answer about delivery (or a clear no), or the other person has nothing more useful to add. Ends the call and reports the outcome.",
  input_schema: {
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

function getOpeningLine({ itemQuery, deliveryAddress }) {
  return `Hi, this is an automated assistant calling on behalf of a customer. This call may be recorded. I'm calling to ask about ${itemQuery} — do you have it in stock, and can you deliver it to ${deliveryAddress}?`;
}

function buildSystemPrompt({ shopName, itemQuery, deliveryAddress }) {
  return `You are an automated phone assistant calling ${shopName} on behalf of a customer, to ask whether they can deliver "${itemQuery}" to "${deliveryAddress}".

Goals, in order: (1) confirm they have the item, (2) confirm they deliver to that address, (3) get the delivery price and estimated time.

Keep every turn short and conversational, like a real phone call — one or two sentences, no lists.

You already identified yourself as an automated assistant and mentioned the call may be recorded in your opening line; do not repeat that.

Once you have a clear answer (they can or can't deliver, with whatever price/time detail they give), call the end_call tool. Include a short closing line as your text response in that same turn (e.g. "Great, thanks for your help!" or "No problem, thanks anyway!") and then stop. Also call end_call if the conversation is clearly going nowhere (wrong number, hostile, no relevant information) after a couple of exchanges — set canDeliver to false and explain why in notes.`;
}

async function getNextTurn(context, transcript) {
  const messages = transcript.map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: turn.text,
  }));

  const request = {
    model: "claude-opus-5",
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: buildSystemPrompt(context),
    tools: [END_CALL_TOOL],
    messages,
  };

  // A live call shouldn't drop entirely over one flaky network blip — retry once.
  let response;
  try {
    response = await anthropic.messages.create(request);
  } catch (err) {
    console.warn("Claude request failed, retrying once:", err.message);
    response = await anthropic.messages.create(request);
  }

  const toolUse = response.content.find(
    (block) => block.type === "tool_use" && block.name === "end_call"
  );

  if (toolUse) {
    const { canDeliver, price, etaMinutes, notes } = toolUse.input;
    const textBlock = response.content.find((block) => block.type === "text");
    return {
      type: "end",
      closingLine: textBlock
        ? textBlock.text
        : "Thanks for your help, have a good day!",
      summary: {
        canDeliver: Boolean(canDeliver),
        price: price || null,
        etaMinutes: typeof etaMinutes === "number" && etaMinutes >= 0 ? etaMinutes : null,
        notes: notes || null,
      },
    };
  }

  const textBlock = response.content.find((block) => block.type === "text");
  return {
    type: "speak",
    text: textBlock ? textBlock.text : "Sorry, could you say that again?",
  };
}

module.exports = { getOpeningLine, getNextTurn };
