// Speech layer: Sarvam AI (via the backend relay) as the primary path for
// both speech-to-text and text-to-speech, with the browser's own Web Speech
// API kept as an automatic fallback if the relay can't be reached.
//
// listenOnce's onResult now receives (transcript, languageCode) — Sarvam's
// STT response includes a detected `language_code` (confirmed live, e.g.
// "hi-IN") so the caller can respond in kind. speak() takes an optional
// `languageCode` option to select the matching TTS voice/pronunciation.
// listenOnce also accepts an optional `onListening` callback, fired once
// the mic is actually capturing — mic/AudioContext/worklet setup happens in
// parallel with the relay WebSocket connecting, so callers shouldn't assume
// listening starts the instant listenOnce() is called.
//
// NOTE: the exact Sarvam WebSocket message shapes here are a best-effort
// reconstruction from docs, corrected in places from real traffic — see the
// git history / README for what's been fixed so far. Confirmed live: Sarvam
// can take several seconds to synthesize longer text, so the TTS path uses
// a much longer "waiting for audio" timeout than the initial connection-open
// check.
window.Speech = (() => {
  const NativeSR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const STT_OPEN_TIMEOUT_MS = 4000;
  const TTS_OPEN_TIMEOUT_MS = 4000;
  // Long text (e.g. a 3-result summary) can legitimately take Sarvam many
  // seconds to synthesize — this needs much more headroom than a simple
  // connection-open check.
  const TTS_AUDIO_WAIT_TIMEOUT_MS = 20000;

  // Confirmed report: "breaking up" TTS audio happened even with the old
  // plain Web Speech API (SpeechSynthesis) implementation, which has zero
  // custom streaming/scheduling code of ours to blame — and only on
  // Bluetooth headphones, and specifically the *start* of playback (it
  // smooths out by the last few words). That fingerprint matches a
  // well-known Bluetooth behavior, not an app bug: while the mic is
  // capturing, a headset negotiates HFP (mono, low-bitrate, needed for
  // simultaneous mic+speaker); switching back to A2DP (full quality,
  // playback-only) isn't instant, and it's often *demand-driven* — nothing
  // tells the headset to switch back until something actually starts
  // playing, which meant our real TTS audio was itself the trigger and had
  // to play through the glitchy switch-over. A blind fixed delay before
  // speaking helped a little but wasn't long/reliable enough on its own.
  // Instead, the moment the mic is released, immediately play a very quiet,
  // near-silent tone through a *reused* AudioContext — this kicks off the
  // HFP->A2DP switch right away, in parallel with whatever network work
  // (classification, search) happens next, instead of only starting the
  // switch once the real reply is ready to speak. Reusing the same
  // AudioContext (rather than closing this one and opening a fresh one for
  // the real speech) avoids a second gap where the headset could drop back
  // out of A2DP between the priming tone and the real audio.
  const MIC_RELEASE_SETTLE_MS = 400;
  const PRIMED_CONTEXT_MAX_AGE_MS = 15000;
  let lastMicReleaseAt = 0;
  let primedAudioContext = null;
  let primedAt = 0;

  function markMicReleased() {
    lastMicReleaseAt = performance.now();
    primeAudioOutput();
  }

  function primeAudioOutput() {
    try {
      const ctx = new AudioContext();
      const durationSec = 0.15;
      const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * durationSec), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      // A true-silent buffer sometimes doesn't register as "real" playback
      // to the OS/Bluetooth stack — a very quiet audible tone reliably does.
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.sin((i / ctx.sampleRate) * 2 * Math.PI * 440) * 0.015;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start();
      primedAudioContext = ctx;
      primedAt = performance.now();
      // If nothing ever consumes this (e.g. the turn ends in an error before
      // any speak() call), don't leave it open indefinitely.
      setTimeout(() => {
        if (primedAudioContext === ctx) {
          primedAudioContext = null;
          try {
            ctx.close();
          } catch (_) {}
        }
      }, PRIMED_CONTEXT_MAX_AGE_MS);
    } catch (err) {
      console.warn("[TTS] audio priming failed (non-fatal):", err);
    }
  }

  // Hands back the primed AudioContext from the most recent mic release (if
  // still fresh) so real TTS playback continues the same audio session
  // instead of opening a new one, or a plain new AudioContext otherwise.
  function claimPlaybackAudioContext() {
    if (primedAudioContext && performance.now() - primedAt < PRIMED_CONTEXT_MAX_AGE_MS) {
      const ctx = primedAudioContext;
      primedAudioContext = null;
      return ctx;
    }
    return new AudioContext();
  }

  // Cancellation: a monotonically increasing token identifies the "current"
  // turn. Starting a new listenOnce()/speak() bumps it, which makes any
  // still-in-flight callback from a previous turn a silent no-op instead of
  // firing (including internal onError->fallback wiring, which shouldn't
  // kick in for a deliberately cancelled turn). cancel() also hard-stops
  // whatever's actually in flight (release the mic / stop playback).
  let sessionToken = 0;
  let activeStop = null;

  function cancel() {
    sessionToken++;
    const stop = activeStop;
    activeStop = null;
    if (stop) {
      try {
        stop();
      } catch (_) {}
    }
  }

  function isSupported() {
    const hasRelayPath =
      !!navigator.mediaDevices?.getUserMedia &&
      !!window.WebSocket &&
      !!window.AudioContext;
    return hasRelayPath || (!!NativeSR && !!window.speechSynthesis);
  }

  function wsUrl(path) {
    return window.BACKEND_URL.replace(/^http/, "ws") + path;
  }

  // ---- Speech-to-text ---------------------------------------------------

  function listenOnce({ onResult, onError, onListening }) {
    const myToken = ++sessionToken;
    const guarded = (fn) => (...args) => {
      if (myToken === sessionToken) fn?.(...args);
    };
    const guardedResult = guarded(onResult);
    const guardedListening = guarded(onListening);

    listenViaSarvam({
      onResult: guardedResult,
      onListening: guardedListening,
      onError: (err) => {
        if (myToken !== sessionToken) return; // cancelled — don't fall back either
        console.warn("Sarvam STT unavailable, falling back to Web Speech API:", err);
        listenViaWebSpeech({ onResult: guardedResult, onError: guarded(onError), onListening: guardedListening });
      },
    });
  }

  function listenViaSarvam({ onResult, onError, onListening }) {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      onError("relay-unsupported");
      return;
    }

    let settled = false;
    let ws;
    let audioContext;
    let stream;
    let workletNode;
    let connectTimer;
    let flushTimer;
    let pendingChunks = [];
    let wsOpen = false;
    let audioReady = false;

    const cleanup = () => {
      clearTimeout(connectTimer);
      clearInterval(flushTimer);
      try {
        workletNode?.port.close();
      } catch (_) {}
      try {
        audioContext?.close();
      } catch (_) {}
      if (stream) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        markMicReleased();
      }
      try {
        ws?.close();
      } catch (_) {}
    };

    let myStop;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (activeStop === myStop) activeStop = null;
      cleanup();
      onError(err);
    };

    const succeed = (transcript, languageCode) => {
      if (settled) return;
      settled = true;
      if (activeStop === myStop) activeStop = null;
      cleanup();
      onResult(transcript, languageCode);
    };

    myStop = () => fail("cancelled");
    activeStop = myStop;

    // Only starts actually sending audio (and tells the caller we're truly
    // listening) once BOTH the relay connection and the mic/worklet pipeline
    // are ready — whichever finishes second triggers this.
    const maybeStartCapturing = () => {
      if (!wsOpen || !audioReady || settled) return;
      flushTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || pendingChunks.length === 0) return;
        const combined = concatFloat32(pendingChunks);
        pendingChunks = [];
        const pcm16k = downsampleFloat32To16kPcm16(combined, audioContext.sampleRate);
        ws.send(JSON.stringify({ audio: int16ToBase64(pcm16k) }));
      }, 200);
      onListening?.();
    };

    // Mic/AudioContext/worklet setup runs in parallel with the relay
    // connecting below (not after it opens) — this was adding real,
    // user-visible latency before the app was actually capturing audio,
    // even though the UI already invited the user to start speaking.
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        fail("not-allowed");
        return;
      }
      if (settled) return;

      audioContext = new AudioContext();
      await audioContext.audioWorklet.addModule("pcm-worklet.js");
      if (settled) return;

      const source = audioContext.createMediaStreamSource(stream);
      workletNode = new AudioWorkletNode(audioContext, "pcm-capture-processor");
      source.connect(workletNode);

      // The worklet posts a message every ~2.7ms (one per render quantum) —
      // buffer those and flush in ~200ms batches instead of sending a WS
      // message (and, on the backend, a WAV-wrapped chunk) that often.
      workletNode.port.onmessage = (event) => {
        pendingChunks.push(event.data);
      };

      audioReady = true;
      maybeStartCapturing();
    })();

    try {
      ws = new WebSocket(wsUrl("/relay/stt"));
    } catch (err) {
      fail("relay-connect-failed");
      return;
    }

    // Only guards the relay *connection* — no ceiling on mic setup itself,
    // since a mic-permission prompt can legitimately take the user a while
    // to respond to.
    connectTimer = setTimeout(() => fail("relay-timeout"), STT_OPEN_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      clearTimeout(connectTimer);
      wsOpen = true;
      maybeStartCapturing();
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }

      const transcript = msg.data?.transcript ?? null;
      const languageCode = msg.data?.language_code ?? null;
      if (transcript) {
        succeed(transcript, languageCode);
      }
    });

    ws.addEventListener("error", () => fail("relay-error"));
    ws.addEventListener("close", () => fail("no-speech"));
  }

  function listenViaWebSpeech({ onResult, onError, onListening }) {
    if (!NativeSR) {
      onError("unsupported");
      return;
    }

    const recognition = new NativeSR();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    let settled = false;
    let myStop;

    recognition.onresult = (event) => {
      settled = true;
      if (activeStop === myStop) activeStop = null;
      onResult(event.results[0][0].transcript, "en-US");
    };

    recognition.onerror = (event) => {
      settled = true;
      if (activeStop === myStop) activeStop = null;
      onError(event.error);
    };

    recognition.onend = () => {
      markMicReleased();
      if (!settled) {
        settled = true;
        if (activeStop === myStop) activeStop = null;
        onError("no-speech");
      }
    };

    recognition.onstart = () => onListening?.();

    myStop = () => {
      try {
        recognition.abort();
      } catch (_) {}
    };
    activeStop = myStop;

    recognition.start();
  }

  // ---- Text-to-speech -----------------------------------------------------

  function speak(text, opts = {}) {
    const myToken = ++sessionToken;
    const guardedOnEnd = (...args) => {
      if (myToken === sessionToken) opts.onEnd?.(...args);
    };
    const wrappedOpts = { ...opts, onEnd: guardedOnEnd };

    const elapsed = performance.now() - lastMicReleaseAt;
    const wait = Math.max(0, MIC_RELEASE_SETTLE_MS - elapsed);
    if (wait > 0) {
      console.log(`[TTS] delaying ${Math.round(wait)}ms before speaking (Bluetooth settle floor)`);
      setTimeout(() => {
        if (myToken === sessionToken) speakNow(text, wrappedOpts, myToken);
      }, wait);
    } else {
      speakNow(text, wrappedOpts, myToken);
    }
  }

  function speakNow(text, { onEnd, languageCode } = {}, myToken) {
    speakViaSarvam(text, {
      onEnd,
      languageCode,
      onError: (err) => {
        if (myToken !== sessionToken) return; // cancelled — don't fall back either
        console.warn("Sarvam TTS unavailable, falling back to Web Speech API:", err);
        speakViaWebSpeech(text, { onEnd });
      },
    });
  }

  function speakViaSarvam(text, { onEnd, onError, languageCode }) {
    let ws;
    try {
      ws = new WebSocket(wsUrl("/relay/tts"));
    } catch (err) {
      onError("relay-connect-failed");
      return;
    }

    // Reuse the AudioContext primed at mic-release time (if still fresh)
    // instead of opening a brand new one — keeps the Bluetooth headset in
    // one continuous playback session rather than risking it dropping back
    // out of A2DP between the priming tone and the real speech.
    const audioContext = claimPlaybackAudioContext();
    const playback = { nextStartTime: 0, lastSource: null, scheduledCount: 0 };
    let receivedAnyAudio = false;
    let settled = false;
    let openTimer;
    let audioWaitTimer;
    let myStop;

    const clearTimers = () => {
      clearTimeout(openTimer);
      clearTimeout(audioWaitTimer);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (activeStop === myStop) activeStop = null;
      clearTimers();
      try {
        ws.close();
      } catch (_) {}
      const remaining = playback.nextStartTime - audioContext.currentTime;
      console.log("[TTS] finish() called, remaining playback ~", remaining.toFixed(2), "s");
      const done = () => {
        console.log("[TTS] onEnd firing");
        try {
          audioContext.close();
        } catch (_) {}
        onEnd?.();
      };
      if (remaining > 0 && playback.lastSource) {
        playback.lastSource.onended = done;
      } else {
        done();
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (activeStop === myStop) activeStop = null;
      clearTimers();
      try {
        ws.close();
      } catch (_) {}
      try {
        audioContext.close();
      } catch (_) {}
      onError(err);
    };

    // A deliberate cancel (Stop Conversation) should cut audio immediately,
    // not wait for the currently-scheduled buffer to finish playing the way
    // a normal completion does.
    myStop = () => {
      try {
        playback.lastSource?.stop();
      } catch (_) {}
      fail("cancelled");
    };
    activeStop = myStop;

    // Reset (not just set-once) on every audio chunk received, so a
    // multi-chunk long response doesn't get cut off between chunks either —
    // only truly going quiet for this long counts as a failure.
    const resetAudioWaitTimer = () => {
      clearTimeout(audioWaitTimer);
      audioWaitTimer = setTimeout(() => fail("relay-timeout"), TTS_AUDIO_WAIT_TIMEOUT_MS);
    };

    openTimer = setTimeout(() => fail("relay-timeout"), TTS_OPEN_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      ws.send(JSON.stringify({ text, languageCode }));
      resetAudioWaitTimer();
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }

      const audioBase64 = msg.data?.audio ?? msg.audio ?? null;
      if (audioBase64) {
        receivedAnyAudio = true;
        resetAudioWaitTimer();
        console.log("[TTS] audio chunk received, base64 length =", audioBase64.length, "msg.type =", msg.type);
        const pcm16 = base64ToInt16(audioBase64);
        // Matches speech_sample_rate: 24000 explicitly requested in ttsRelay.js's
        // Sarvam config (Bulbul V3's own default — confirmed, not guessed).
        schedulePcmChunk(audioContext, pcm16, 24000, playback);
      }

      // "relay-complete" is a signal our own backend sends (not Sarvam) once
      // it's done relaying — authoritative and unambiguous, unlike guessing
      // at Sarvam's own message shapes or inferring completion from the
      // connection closing (which raced truncating the final chunk).
      const isDone =
        msg.type === "relay-complete" ||
        ["done", "end", "complete", "flush_done"].includes(msg.type);
      if (isDone) {
        console.log("[TTS] relay signaled complete, finishing playback chain");
        finish();
      }
    });

    ws.addEventListener("error", () => {
      console.log("[TTS] relay ws error, receivedAnyAudio =", receivedAnyAudio);
      if (!receivedAnyAudio) {
        fail("relay-error");
      } else {
        finish();
      }
    });

    ws.addEventListener("close", () => {
      console.log("[TTS] relay ws closed, receivedAnyAudio =", receivedAnyAudio, "settled =", settled);
      if (!receivedAnyAudio) {
        fail("relay-closed");
      } else {
        finish();
      }
    });
  }

  function speakViaWebSpeech(text, { onEnd } = {}) {
    const synth = window.speechSynthesis;
    if (!synth) {
      onEnd?.();
      return;
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    let myStop;
    const clearStop = () => {
      if (activeStop === myStop) activeStop = null;
    };
    if (onEnd) {
      utterance.onend = () => {
        clearStop();
        onEnd();
      };
    }
    myStop = () => {
      clearStop();
      try {
        synth.cancel();
      } catch (_) {}
    };
    activeStop = myStop;

    synth.speak(utterance);
  }

  // ---- Audio helpers ------------------------------------------------------

  function concatFloat32(chunks) {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function downsampleFloat32To16kPcm16(float32Samples, fromRate) {
    const ratio = 16000 / fromRate;
    const outLength = Math.round(float32Samples.length * ratio);
    const out = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const srcPos = i / ratio;
      const lowIndex = Math.floor(srcPos);
      const highIndex = Math.min(lowIndex + 1, float32Samples.length - 1);
      const frac = srcPos - lowIndex;
      const sample =
        float32Samples[lowIndex] +
        (float32Samples[highIndex] - float32Samples[lowIndex]) * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return out;
  }

  function schedulePcmChunk(audioContext, int16Samples, sampleRate, playback) {
    const float32 = new Float32Array(int16Samples.length);
    for (let i = 0; i < int16Samples.length; i++) {
      float32[i] = int16Samples[i] / 32768;
    }

    const buffer = audioContext.createBuffer(1, float32.length, sampleRate);
    buffer.copyToChannel(float32, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const startAt = Math.max(playback.nextStartTime, audioContext.currentTime);
    source.start(startAt);
    playback.nextStartTime = startAt + buffer.duration;
    playback.lastSource = source;
    playback.scheduledCount += 1;
  }

  function int16ToBase64(int16Array) {
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  return { isSupported, listenOnce, speak, cancel };
})();
