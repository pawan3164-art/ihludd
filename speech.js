// Thin wrapper around the browser's Web Speech API (speech-to-text + text-to-speech).
window.Speech = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function isSupported() {
    return !!SR && !!window.speechSynthesis;
  }

  // Captures a single spoken utterance and resolves it via callbacks.
  // Always settles exactly once, through either onResult or onError.
  function listenOnce({ onResult, onError }) {
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let settled = false;

    recognition.onresult = (event) => {
      settled = true;
      onResult(event.results[0][0].transcript);
    };

    recognition.onerror = (event) => {
      settled = true;
      onError(event.error);
    };

    // Some browsers end without ever firing onresult/onerror (e.g. silence timeout).
    recognition.onend = () => {
      if (!settled) onError("no-speech");
    };

    recognition.start();
    return recognition;
  }

  function speak(text, { onEnd } = {}) {
    const synth = window.speechSynthesis;
    synth.cancel(); // clear anything queued from a previous search
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    if (onEnd) utterance.onend = onEnd;
    synth.speak(utterance);
  }

  return { isSupported, listenOnce, speak };
})();
