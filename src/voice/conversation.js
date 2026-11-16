import { getSettings } from "../shared/constants.js";
import { inputStatus, localRecognition } from "./input.js";
import { speak, stopSpeech, interruptSpeech, unlockAudio } from "./speech.js";

// Half-duplex: listen -> submit through the ordinary chat -> speak -> listen.
// A generation number prevents late model/recognition results restarting a stopped session.
export function createConversation({ onTurn, onState, onTranscript }) {
  let enabled = false, active = false, generation = 0, recognition, timer;
  let processing = null;
  const state = (text) => onState({ enabled, active, text });

  function quiet() {
    clearTimeout(timer);
    if (recognition) {
      recognition.onend = recognition.onresult = recognition.onerror = null;
      recognition.abort();
      recognition = null;
    }
  }

  function stop(message = "Conversation stopped.") {
    generation++;
    active = false;
    quiet();
    stopSpeech();
    chrome.tts?.stop();
    state(message);
  }

  async function configure() {
    const settings = await getSettings();
    enabled = settings.voiceEnabled;
    stop(enabled ? "Ready. Start a conversation or type a message." : "Voice mode is off.");
  }

  async function turn(action) {
    if (processing !== null) return;
    const token = ++generation;
    processing = token;
    quiet();
    interruptSpeech();
    state("Thinking…");
    try {
      if (enabled) await unlockAudio();
      const answer = await action();
      if (processing === token) processing = null;
      if (token !== generation) return;
      const settings = await getSettings();
      if (token !== generation) return;
      if (settings.voiceEnabled && answer) {
        await speak(answer, settings.voiceName, state);
      }
      if (token === generation) {
        if (active) listen();
        else state(enabled ? "Ready." : "Voice mode is off.");
      }
    } catch (error) {
      if (token === generation && error.name !== "AbortError") stop(error.message);
    } finally { if (processing === token) processing = null; }
  }

  function listen() {
    if (!active) return;
    const token = generation;
    let finalText = "";
    try {
      recognition = localRecognition();
      recognition.onresult = (event) => {
        if (token !== generation) return;
        const results = Array.from(event.results);
        finalText = results.filter(r => r.isFinal).map(r => r[0].transcript).join(" ").trim();
        onTranscript(results.map(r => r[0].transcript).join(" "));
        if (finalText) recognition.stop();
      };
      recognition.onerror = ({ error }) => {
        if (token !== generation) return;
        const messages = {
          "not-allowed": "Microphone permission was denied. Allow the microphone for Chrome Cat and try again.",
          "audio-capture": "No microphone is available. Check your input device.",
          "no-speech": "No speech heard. Press Start conversation to try again.",
          "language-not-supported": "Set up local English voice input in Settings first.",
        };
        stop(messages[error] || `Voice input stopped: ${error}`);
      };
      recognition.onend = () => {
        if (token !== generation || !active) return;
        clearTimeout(timer);
        recognition = null;
        if (!finalText) { stop("No speech heard. Press Start conversation to try again."); return; }
        void turn(() => onTurn(finalText.slice(0, 2000)));
      };
      state("Listening… speak your question.");
      recognition.start();
      timer = setTimeout(() => recognition?.stop(), 30_000);
    } catch (error) { stop(error.message); }
  }

  async function start() {
    if (processing !== null) { state("Wait for the current answer before starting."); return; }
    const audio = unlockAudio();
    const token = ++generation;
    state("Checking local voice input…");
    try {
      await audio;
      const settings = await getSettings();
      if (!settings.voiceEnabled) throw new Error("Turn on voice mode in Settings first.");
      const status = await inputStatus();
      if (token !== generation) return;
      if (status !== "available") throw new Error(status === "unavailable"
        ? "Local English recognition is unavailable in this Chrome installation. You can still type and hear replies."
        : "Set up local English voice input in Settings, then start again.");
      enabled = active = true;
      interruptSpeech();
      listen();
    } catch (error) { if (token === generation) stop(error.message); }
  }

  const changed = (changes, area) => {
    if (area === "local" && (changes["cc.voiceEnabled"] || changes["cc.voiceName"])) void configure();
  };
  chrome.storage.onChanged.addListener(changed);
  window.addEventListener("pagehide", () => {
    stop();
    chrome.storage.onChanged.removeListener(changed);
  });
  void configure();
  return { start, stop, turn, get active() { return active; } };
}
