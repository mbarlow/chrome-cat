// One local worker and one sentence of audio at a time. Stop also cancels loading.
let worker, context, source, pending, idleTimer;
let sequence = 0;

export function speechText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " Code block omitted. ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/^[\s]*[>#*-]+\s*/gm, "")
    .replace(/[*_`|]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 8000);
}

// Call from the user's Start/Preview/Send gesture, before any asynchronous work.
export async function unlockAudio() {
  context ||= new AudioContext();
  await context.resume();
}

function finish(error) {
  const job = pending;
  pending = null;
  clearTimeout(job?.timer);
  if (error) job?.reject(error);
  else job?.resolve();
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopSpeech, 60_000);
}

export function stopSpeech() {
  sequence++;
  clearTimeout(idleTimer);
  if (source) {
    source.onended = null;
    try { source.stop(); } catch { /* playback may not have started */ }
    source.disconnect();
    source = null;
  }
  worker?.terminate();
  worker = null;
  if (pending) finish(new DOMException("Speech stopped", "AbortError"));
  clearTimeout(idleTimer);
}

export function interruptSpeech() {
  if (pending || source) stopSpeech();
  else { sequence++; clearTimeout(idleTimer); }
}

export async function speak(text, voice = "F2", onStatus = () => {}) {
  interruptSpeech();
  const id = sequence;
  const clean = speechText(text);
  if (!clean) return;
  await unlockAudio();
  if (id !== sequence) throw new DOMException("Speech stopped", "AbortError");
  worker ||= new Worker(chrome.runtime.getURL("src/voice/worker.js"));
  return new Promise((resolve, reject) => {
    const timeout = () => {
      const error = new Error("Voice timed out. Try a shorter message.");
      finish(error);
      stopSpeech();
    };
    pending = { resolve, reject, timer: setTimeout(timeout, 120_000) };
    worker.onerror = (event) => {
      finish(new Error(event.message || "Voice worker failed. Run make vendor-voice."));
      stopSpeech();
    };
    worker.onmessage = ({ data }) => {
      if (!pending || data.id !== id) return;
      clearTimeout(pending.timer);
      pending.timer = setTimeout(timeout, 120_000);
      if (data.type === "status") onStatus(data.text);
      if (data.type === "error") { finish(new Error(data.message)); stopSpeech(); }
      if (data.type === "done") finish();
      if (data.type === "audio") {
        try {
          onStatus("Speaking…");
          const buffer = context.createBuffer(1, data.audio.length, data.sampleRate);
          buffer.copyToChannel(data.audio, 0);
          source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          source.onended = () => {
            source.disconnect();
            source = null;
            if (id === sequence) worker?.postMessage({ type: "next" });
          };
          source.start();
        } catch (error) { finish(error); stopSpeech(); }
      }
    };
    worker.postMessage({ type: "speak", id, text: clean, voice });
  });
}

window.addEventListener("pagehide", () => {
  stopSpeech();
  context?.close();
  context = null;
});
