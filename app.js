// Wires the UI to Speech (speech.js), Places (places.js), and the backend
// call agent: click -> listen -> locate -> search -> speak -> select -> call -> report.
(() => {
  const speakBtn = document.getElementById("speakBtn");
  const btnLabel = speakBtn.querySelector(".btn-label");
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
  // True once a card/voice selection has been accepted, so a cancelled
  // speech-synthesis "end" event (from clicking mid-summary) doesn't also
  // trigger the selection-listening flow.
  let selectionInProgress = false;

  function init() {
    if (!window.Speech.isSupported()) {
      setError(ERROR_MESSAGES.unsupported);
      speakBtn.disabled = true;
      setState("idle");
      setStatus("Unsupported browser");
      return;
    }
    speakBtn.addEventListener("click", handleClick);
  }

  function handleClick() {
    clearError();
    clearResults();
    currentPlaces = [];
    currentQuery = "";
    selectionInProgress = false;
    setState("listening");
    setStatus("Listening... speak now");

    window.Speech.listenOnce({
      onResult: handleTranscript,
      onError: (err) => {
        setError(ERROR_MESSAGES[err] || `Speech recognition error: ${err}`);
        goIdle();
      },
    });
  }

  async function handleTranscript(transcript) {
    currentQuery = transcript;
    setState("locating");
    setStatus(`Heard: "${transcript}" — finding your location...`);

    let coords;
    try {
      coords = await getLocation();
    } catch (err) {
      setError(ERROR_MESSAGES[err] || "Could not determine your location.");
      goIdle();
      return;
    }

    setState("searching");
    setStatus(`Searching nearby for "${transcript}"...`);

    let places;
    try {
      places = await window.Places.searchNearby(transcript, coords);
    } catch (err) {
      console.error(err);
      setError(ERROR_MESSAGES["places-error"]);
      goIdle();
      return;
    }

    currentPlaces = places;
    renderResults(transcript, places, { selectable: true });

    setState("speaking");
    setStatus("Here are the results:");
    const sentence = composeSentence(transcript, places);
    window.Speech.speak(sentence, {
      onEnd: () => {
        if (selectionInProgress) return;
        if (places.length > 0) {
          startSelecting();
        } else {
          goIdle();
        }
      },
    });
  }

  function startSelecting() {
    setState("selecting");
    setStatus("Say \"option 1\", \"the second one\", or the shop's name — or click a card");

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
    if (state === "speaking") window.speechSynthesis.cancel();
    selectionInProgress = true;

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
      console.error(err);
      setError(ERROR_MESSAGES["call-error"]);
      goIdle();
      return;
    }

    pollCallStatus(place, callSid);
  }

  function pollCallStatus(place, callSid) {
    const poll = async () => {
      let result;
      try {
        const response = await fetch(`${window.BACKEND_URL}/call-status/${callSid}`);
        result = await response.json();
      } catch (err) {
        console.error(err);
        setTimeout(poll, CALL_POLL_INTERVAL_MS);
        return;
      }

      if (result.status === "in-progress") {
        setTimeout(poll, CALL_POLL_INTERVAL_MS);
        return;
      }

      reportCallResult(place, result);
    };

    setTimeout(poll, CALL_POLL_INTERVAL_MS);
  }

  function reportCallResult(place, result) {
    setState("reporting");

    let sentence;
    if (result.status === "completed") {
      if (result.canDeliver) {
        const priceText = result.price ? `, it'll cost ${result.price}` : "";
        const etaText =
          result.etaMinutes != null
            ? ` and take about ${result.etaMinutes} minutes`
            : "";
        sentence = `${place.name} can deliver your ${currentQuery}${priceText}${etaText}.`;
      } else {
        sentence = `Sorry, ${place.name} can't deliver your ${currentQuery}.`;
        if (result.notes) sentence += ` ${result.notes}`;
      }
    } else if (result.status === "no-answer") {
      sentence = `Couldn't reach ${place.name} — the call wasn't answered.`;
    } else if (result.status === "timed-out") {
      sentence = `The call with ${place.name} ran too long, so I ended it before getting a clear answer.`;
    } else {
      sentence = `Something went wrong on the call with ${place.name}.`;
    }

    setStatus(sentence);
    window.Speech.speak(sentence, { onEnd: goIdle });
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

  function composeSentence(query, places) {
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
    setState("idle");
    setStatus("Click the button and ask what you're looking for");
  }

  init();
})();
