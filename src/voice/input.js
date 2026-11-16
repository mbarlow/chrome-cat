// Require on-device recognition explicitly. Never fall back to cloud recognition.
const OPTIONS = { langs: ["en-US"], processLocally: true };

export function recognitionClass() {
  const API = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!API || !("processLocally" in API.prototype) || !API.available || !API.install) {
    throw new Error("Local voice input needs a Chrome version with on-device speech recognition. You can still type and hear replies.");
  }
  return API;
}

export async function inputStatus() {
  return recognitionClass().available(OPTIONS);
}

export async function installInput() {
  return recognitionClass().install(OPTIONS);
}

export function localRecognition() {
  const recognition = new (recognitionClass())();
  recognition.lang = "en-US";
  recognition.processLocally = true;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  return recognition;
}
