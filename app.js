// Wires the UI to Speech (speech.js), Places (places.js), and the backend
// call agent: click -> listen -> locate -> search -> speak -> select -> call -> report.
(() => {
  const speakBtn = document.getElementById("speakBtn");
  const btnLabel = speakBtn.querySelector(".btn-label");
  const stopBtn = document.getElementById("stopBtn");
  const statusText = document.getElementById("statusText");
  const errorBanner = document.getElementById("errorBanner");
  const resultsEl = document.getElementById("results");

  const CALL_POLL_INTERVAL_MS = 2000;

  const ERROR_MESSAGES = {
    "not-allowed":
      "Microphone access was denied. Please allow microphone access in your browser settings and try again.",
    "no-speech": "I didn't catch that. Try again.",
    "audio-capture":
      "No microphone was found. Please connect a microphone and try again.",
    "geolocation-denied":
      "Location access is needed to find nearby places. Please allow location access and try again.",
    "geolocation-unavailable":
      "Could not determine your location. Please try again.",
    "geolocation-timeout":
      "Getting your location took too long. Please try again.",
    "places-error":
      "Something went wrong while searching for places. Please try again.",
    "call-error":
      "Something went wrong starting the call. Please try again.",
    unsupported:
      "Speech recognition isn't supported in this browser. Please use Chrome or Edge.",
  };

  const STATE_LABELS = {
    idle: "Tap to Speak",
    listening: "Listening…",
    thinking: "Thinking…",
    locating: "Locating…",
    searching: "Searching…",
    speaking: "Speaking…",
    selecting: "Listening…",
    calling: "Calling…",
    reporting: "Speaking…",
  };

  // Set once a search completes; cleared when a new search starts.
  let currentPlaces = [];
  let currentQuery = "";
  // Detected from Sarvam STT's response (e.g. "hi-IN"); drives which spoken
  // response templates get used and which TTS voice/pronunciation Sarvam
  // uses for the reply. Defaults to English (matches the Web Speech API
  // fallback, which only ever recognizes English).
  let currentLanguageCode = "en-US";
  // True once a card/voice selection has been accepted, so a cancelled
  // speech-synthesis "end" event (from clicking mid-summary) doesn't also
  // trigger the selection-listening flow.
  let selectionInProgress = false;
  // True from the first tap until the user hits "Stop Conversation" (or an
  // error ends things) — while true, every natural end-of-turn point
  // (a chat reply, a reported call outcome, no results found, ...) loops
  // back into listening for the next thing the user says, instead of
  // requiring a fresh tap for every single exchange.
  let conversationActive = false;
  // Bumped every time goIdle() runs (including "Stop Conversation"). Steps
  // that aren't covered by window.Speech's own cancellation — the
  // classify-request fetch, geolocation, Places search, the fetch to
  // /call-shop — capture the generation active when they *started* and
  // check it again after each await; a mismatch means a stop happened while
  // they were in flight, so they bail out silently instead of continuing
  // to speak/act after the user already asked to stop.
  let turnGeneration = 0;

  function init() {
    if (!window.Speech.isSupported()) {
      setError(ERROR_MESSAGES.unsupported);
      speakBtn.disabled = true;
      setState("idle");
      setStatus("Unsupported browser");
      return;
    }
    speakBtn.addEventListener("click", handleClick);
    stopBtn.addEventListener("click", handleStopConversation);
  }

  function handleClick() {
    if (conversationActive) return; // already running — the loop below drives listening
    clearError();
    clearResults();
    currentPlaces = [];
    currentQuery = "";
    selectionInProgress = false;
    conversationActive = true;
    speakBtn.disabled = true;
    stopBtn.hidden = false;
    startListeningTurn();
  }

  function handleStopConversation() {
    window.Speech.cancel();
    goIdle();
  }

  function startListeningTurn() {
    setState("listening");
    setStatus("Getting ready...");

    window.Speech.listenOnce({
      onListening: () => setStatus("Listening... speak now"),
      onResult: handleTranscript,
      onError: (err) => {
        setError(ERROR_MESSAGES[err] || `Speech recognition error: ${err}`);
        goIdle();
      },
    });
  }

  // Called at every natural end-of-turn point. Keeps the conversation going
  // (listens for the next thing the user says) while it's still active;
  // otherwise falls back to a full stop.
  function continueConversationOrIdle() {
    if (!conversationActive) {
      goIdle();
      return;
    }
    clearResults();
    currentPlaces = [];
    selectionInProgress = false;
    startListeningTurn();
  }

  async function handleTranscript(transcript, languageCode) {
    const myGen = turnGeneration;
    currentLanguageCode = languageCode || "en-US";
    setState("thinking");
    setStatus(`Heard: "${transcript}" — thinking...`);

    // Classifies the request first: general conversation (jokes, small
    // talk, weather chit-chat) gets a direct spoken reply and stops there;
    // only an actual "find X nearby" request continues into the
    // location/search/call workflow below.
    const classification = await classifyRequest(transcript);
    if (myGen !== turnGeneration) return; // stopped while classifying

    if (classification.intent === "chat") {
      setState("speaking");
      setStatus(classification.reply);
      window.Speech.speak(classification.reply, {
        languageCode: currentLanguageCode,
        onEnd: () => {
          if (myGen !== turnGeneration) return;
          continueConversationOrIdle();
        },
      });
      return;
    }

    currentQuery = classification.query || transcript;
    runSearchFlow(myGen);
  }

  function runSearchFlow(myGen) {
    const ackText = isHindi(currentLanguageCode)
      ? `ठीक है, मैं "${currentQuery}" ढूंढ रहा हूं...`
      : "Sure, let me find that for you...";

    setState("speaking");
    setStatus(ackText);

    // Kick off geolocation in parallel with speaking the acknowledgment
    // rather than waiting for the ack to finish first — no reason to make
    // the user wait through both sequentially. Attach a no-op .catch now
    // purely to avoid a spurious "unhandled rejection" console warning if
    // this rejects before the real handling below (in onEnd) awaits it.
    const locationPromise = getLocation();
    locationPromise.catch(() => {});

    window.Speech.speak(ackText, {
      languageCode: currentLanguageCode,
      onEnd: async () => {
        if (myGen !== turnGeneration) return; // stopped while ack was speaking

        setState("locating");
        setStatus("Finding your location...");

        let coords;
        try {
          coords = await locationPromise;
        } catch (reason) {
          if (myGen !== turnGeneration) return;
          setError(ERROR_MESSAGES[reason] || "Could not determine your location.");
          goIdle();
          return;
        }
        if (myGen !== turnGeneration) return;

        setState("searching");
        setStatus(`Searching nearby for "${currentQuery}"...`);

        let places;
        try {
          places = await window.Places.searchNearby(currentQuery, coords);
        } catch (err) {
          if (myGen !== turnGeneration) return;
          console.error(err);
          setError(ERROR_MESSAGES["places-error"]);
          goIdle();
          return;
        }
        if (myGen !== turnGeneration) return;

        currentPlaces = places;
        renderResults(currentQuery, places, { selectable: true });

        setState("speaking");
        setStatus("Here are the results:");
        const sentence = composeSentence(currentQuery, places, currentLanguageCode);
        window.Speech.speak(sentence, {
          languageCode: currentLanguageCode,
          onEnd: () => {
            if (myGen !== turnGeneration) return;
            if (selectionInProgress) return;
            if (places.length > 0) {
              startSelecting();
            } else {
              continueConversationOrIdle();
            }
          },
        });
      },
    });
  }

  function startSelecting() {
    setState("selecting");
    setStatus("Say \"option 1\", \"the second one\", or the shop's name — or click a card");

    // The results themselves were spoken, but silently switching to
    // listening after that gave no audible cue at all — on a voice-driven
    // app, a status-text-only change is indistinguishable from nothing
    // happening. Speak the selection prompt itself before listening.
    const promptText = isHindi(currentLanguageCode)
      ? "आप कौन सा विकल्प चाहेंगे? पहला, दूसरा, या तीसरा बोलें, या दुकान का नाम बोलें।"
      : "Which one would you like? Say the first, second, or third option, or the shop's name.";

    window.Speech.speak(promptText, {
      languageCode: currentLanguageCode,
      onEnd: () => listenForSelection(),
    });
  }

  function listenForSelection() {
    window.Speech.listenOnce({
      onResult: handleSelectionTranscript,
      onError: () => {
        setStatus("Sorry, which one — the first, second, or third? Or click a card.");
        // Re-prompt once by voice; a click always works regardless.
        window.Speech.listenOnce({
          onResult: handleSelectionTranscript,
          onError: () => {
            setError("Couldn't understand a selection. Click a card to pick one, or tap to start over.");
            goIdle();
          },
        });
      },
    });
  }

  function handleSelectionTranscript(transcript) {
    const index = parseSelection(transcript, currentPlaces);
    if (index === -1) {
      setStatus(`Didn't catch that as option 1, 2, or 3. Say again, or click a card.`);
      window.Speech.listenOnce({
        onResult: handleSelectionTranscript,
        onError: () => {
          setError("Couldn't understand a selection. Click a card to pick one, or tap to start over.");
          goIdle();
        },
      });
      return;
    }
    selectPlace(index);
  }

  function parseSelection(transcript, places) {
    const text = transcript.toLowerCase();

    if (/\b(1|one|first)\b/.test(text)) return 0;
    if (/\b(2|two|second)\b/.test(text)) return 1;
    if (/\b(3|three|third)\b/.test(text)) return 2;

    const nameMatch = places.findIndex((p) =>
      text.includes(p.name.toLowerCase())
    );
    if (nameMatch !== -1) return nameMatch;

    return -1;
  }

  async function selectPlace(index) {
    // Allow a click as soon as cards are shown (don't force waiting through
    // the full spoken summary), but guard against a stray voice-recognition
    // callback firing after a click (or vice versa) already started the call.
    const state = speakBtn.dataset.state;
    if (state !== "speaking" && state !== "selecting") return;
    if (state === "speaking") window.Speech.cancel();
    selectionInProgress = true;
    const myGen = turnGeneration;

    const place = currentPlaces[index];
    if (!place) return;

    if (!place.phoneNumber) {
      setError(`No phone number found for ${place.name}.`);
      goIdle();
      return;
    }

    setState("calling");
    setStatus(`Calling ${place.name}... this may take a minute.`);
    clearResults();
    renderResults(currentQuery, [place], { selectable: false });

    let callSid;
    try {
      const response = await fetch(`${window.BACKEND_URL}/call-shop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: place.phoneNumber,
          shopName: place.name,
          itemQuery: currentQuery,
          deliveryAddress: window.DELIVERY_ADDRESS,
        }),
      });
      if (!response.ok) throw new Error(`Backend returned ${response.status}`);
      const data = await response.json();
      callSid = data.callSid;
    } catch (err) {
      if (myGen !== turnGeneration) return;
      console.error(err);
      setError(ERROR_MESSAGES["call-error"]);
      goIdle();
      return;
    }
    if (myGen !== turnGeneration) return;

    pollCallStatus(place, callSid, myGen);
  }

  function pollCallStatus(place, callSid, myGen) {
    const poll = async () => {
      if (myGen !== turnGeneration) return; // stopped while a call was in progress

      let result;
      try {
        const response = await fetch(`${window.BACKEND_URL}/call-status/${callSid}`);
        result = await response.json();
      } catch (err) {
        console.error(err);
        setTimeout(poll, CALL_POLL_INTERVAL_MS);
        return;
      }
      if (myGen !== turnGeneration) return;

      if (result.status === "in-progress") {
        setTimeout(poll, CALL_POLL_INTERVAL_MS);
        return;
      }

      reportCallResult(place, result, myGen);
    };

    setTimeout(poll, CALL_POLL_INTERVAL_MS);
  }

  function reportCallResult(place, result, myGen) {
    setState("reporting");

    const sentence = isHindi(currentLanguageCode)
      ? composeCallResultHindi(place, result)
      : composeCallResultEnglish(place, result);

    setStatus(sentence);
    window.Speech.speak(sentence, {
      languageCode: currentLanguageCode,
      onEnd: () => {
        if (myGen !== turnGeneration) return;
        continueConversationOrIdle();
      },
    });
  }

  function composeCallResultEnglish(place, result) {
    if (result.status === "completed") {
      if (result.canDeliver) {
        const priceText = result.price ? `, it'll cost ${result.price}` : "";
        const etaText =
          result.etaMinutes != null
            ? ` and take about ${result.etaMinutes} minutes`
            : "";
        return `${place.name} can deliver your ${currentQuery}${priceText}${etaText}.`;
      }
      let sentence = `Sorry, ${place.name} can't deliver your ${currentQuery}.`;
      if (result.notes) sentence += ` ${result.notes}`;
      return sentence;
    }
    if (result.status === "no-answer") {
      return `Couldn't reach ${place.name} — the call wasn't answered.`;
    }
    if (result.status === "timed-out") {
      return `The call with ${place.name} ran too long, so I ended it before getting a clear answer.`;
    }
    return `Something went wrong on the call with ${place.name}.`;
  }

  function composeCallResultHindi(place, result) {
    if (result.status === "completed") {
      if (result.canDeliver) {
        const priceText = result.price ? `, कीमत ${result.price} होगी` : "";
        const etaText =
          result.etaMinutes != null
            ? `, और लगभग ${result.etaMinutes} मिनट लगेंगे`
            : "";
        return `${place.name} आपका ${currentQuery} डिलीवर कर सकते हैं${priceText}${etaText}।`;
      }
      let sentence = `माफ़ कीजिए, ${place.name} आपका ${currentQuery} डिलीवर नहीं कर सकते।`;
      if (result.notes) sentence += ` ${result.notes}`;
      return sentence;
    }
    if (result.status === "no-answer") {
      return `${place.name} से संपर्क नहीं हो पाया — कॉल का जवाब नहीं मिला।`;
    }
    if (result.status === "timed-out") {
      return `${place.name} के साथ कॉल बहुत लंबी चली, इसलिए साफ़ जवाब मिलने से पहले ही कॉल खत्म कर दी।`;
    }
    return `${place.name} के साथ कॉल में कुछ गड़बड़ हो गई।`;
  }

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject("geolocation-unavailable");
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) =>
          resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) => {
          if (err.code === 1) reject("geolocation-denied");
          else if (err.code === 3) reject("geolocation-timeout");
          else reject("geolocation-unavailable");
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

  // Classifies a spoken request as either "chat" (general conversation —
  // gets a direct reply) or "search" (a short English search phrase, via
  // the backend's Gemini-based classifier) — always resolves, falling back
  // to a "search" intent with the raw transcript on any failure so a
  // backend hiccup degrades to the old always-search behavior rather than
  // blocking the app.
  const CLASSIFY_TIMEOUT_MS = 10000;

  async function classifyRequest(transcript) {
    // Without a bound here, a hung backend or a slow/stuck Gemini call left
    // the UI stuck on "Thinking…" forever — fetch() has no built-in timeout,
    // so an AbortController is required to actually give up.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
    try {
      const response = await fetch(`${window.BACKEND_URL}/classify-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Backend returned ${response.status}`);
      return await response.json();
    } catch (err) {
      console.error("Request classification failed, defaulting to search with raw transcript:", err);
      return { intent: "search", query: transcript };
    } finally {
      clearTimeout(timeout);
    }
  }

  function isHindi(languageCode) {
    return !!languageCode && languageCode.toLowerCase().startsWith("hi");
  }

  function composeSentence(query, places, languageCode) {
    if (isHindi(languageCode)) {
      if (places.length === 0) {
        return `माफ़ कीजिए, मुझे "${query}" के लिए आस-पास कुछ नहीं मिला।`;
      }
      const parts = places.map((p, i) => {
        const areaText = p.area ? `, ${p.area} में,` : "";
        return `${i + 1}. ${p.name}${areaText} ${p.distanceKm.toFixed(1)} किलोमीटर दूर।`;
      });
      return `आपके लिए ${places.length} विकल्प मिले हैं। ${parts.join(
        " "
      )} कोई एक चुनिए — बोलकर या कार्ड पर क्लिक करके — ताकि मैं दुकान को कॉल करके डिलीवरी के बारे में पूछ सकूं।`;
    }

    if (places.length === 0) {
      return `I couldn't find any nearby results for "${query}".`;
    }
    const parts = places.map((p, i) => {
      const areaText = p.area ? `, in ${p.area}` : "";
      return `${i + 1}. ${p.name}, ${p.distanceKm.toFixed(1)} kilometers away${areaText}.`;
    });
    return `Here are the top ${places.length} results for ${query}. ${parts.join(
      " "
    )} Say which one, or click a card, to have me call and ask about delivery.`;
  }

  function renderResults(query, places, { selectable = false } = {}) {
    resultsEl.innerHTML = "";
    if (places.length === 0) {
      const p = document.createElement("p");
      p.className = "no-results";
      p.textContent = `No nearby matches found for "${query}".`;
      resultsEl.appendChild(p);
      return;
    }
    places.forEach((p, index) => {
      const card = document.createElement("div");
      card.className = "result-card";
      if (selectable) {
        card.classList.add("selectable");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.addEventListener("click", () => selectPlace(index));
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") selectPlace(index);
        });
      }

      const h3 = document.createElement("h3");
      h3.textContent = p.name;

      const meta = document.createElement("p");
      meta.className = "meta";
      const areaText = p.area ? `in ${p.area}` : "";
      meta.textContent = [`${p.distanceKm.toFixed(1)} km away`, areaText]
        .filter(Boolean)
        .join(" · ");
      if (p.openNow !== null) {
        const badge = document.createElement("span");
        badge.className = p.openNow ? "open" : "closed";
        badge.textContent = p.openNow ? " Open now" : " Closed";
        meta.appendChild(badge);
      }

      card.append(h3, meta);
      resultsEl.appendChild(card);
    });
  }

  function clearResults() {
    resultsEl.innerHTML = "";
  }

  function setState(state) {
    speakBtn.dataset.state = state;
    btnLabel.textContent = STATE_LABELS[state] || STATE_LABELS.idle;
  }

  function setStatus(text) {
    statusText.textContent = text;
  }

  function setError(text) {
    errorBanner.textContent = text;
    errorBanner.hidden = false;
  }

  function clearError() {
    errorBanner.hidden = true;
    errorBanner.textContent = "";
  }

  function goIdle() {
    turnGeneration++; // invalidate any in-flight async continuation from this turn
    conversationActive = false;
    speakBtn.disabled = false;
    stopBtn.hidden = true;
    setState("idle");
    setStatus("Click the button and ask what you're looking for");
  }

  init();
})();
