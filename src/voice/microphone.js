import { microphonePermission, requestMicrophoneAccess } from "./input.js";

const button = document.getElementById("allowMic");
const status = document.getElementById("status");
const close = document.getElementById("closeTab");
let requested = false;

function ready() {
  status.textContent = "Microphone access is allowed. Return to Chrome Cat’s Chat panel and press Start conversation.";
  close.hidden = false;
}

button.addEventListener("click", async () => {
  requested = true;
  button.disabled = true;
  close.hidden = true;
  status.textContent = "Waiting for Chrome’s microphone permission…";
  try {
    await requestMicrophoneAccess();
    ready();
  } catch (error) {
    const errors = {
      NotAllowedError: "Chrome blocked or dismissed microphone access. Open Microphone settings, remove Chrome Cat from the blocked list if present, then try again. Also check that your system allows Chrome to use the microphone.",
      NotFoundError: "No microphone was found. Connect or enable a microphone, then try again.",
      NotReadableError: "Chrome cannot open the microphone. Check your input device and whether another app is using it, then try again."
    };
    status.textContent = errors[error.name] || `Microphone setup failed: ${error.message}`;
  } finally { button.disabled = false; }
});

document.getElementById("micSettings").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/content/microphone" });
});
close.addEventListener("click", () => window.close());

microphonePermission().then(permission => {
  if (requested) return;
  if (permission === "granted") ready();
  else if (permission === "denied") {
    status.textContent = "Microphone access is currently blocked. Open Microphone settings to allow Chrome Cat, then return here and try again.";
  }
});
