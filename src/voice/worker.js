// Adapted from tiny-voca (Apache-2.0), commit 62e2adef. See vendor/voice/NOTICE.
// All executable code and model assets are packaged with the extension.
const BASE = new URL("../../vendor/voice/", self.location.href).href;
importScripts(BASE + "pyodide/pyodide.js", BASE + "ort/ort.wasm.min.js");
let pyodide, phonemize, session, config;
let ready, busy = false, acknowledge;
async function bytes(path) {
  const response = await fetch(BASE + path);
  if (!response.ok) throw new Error(`Voice asset missing: ${path}. Run make vendor-voice.`);
  return new Uint8Array(await response.arrayBuffer());
}
async function load() {
  config = JSON.parse(new TextDecoder().decode(await bytes("config.json")));
  pyodide = await loadPyodide({ indexURL: BASE + "pyodide/" });
  await pyodide.loadPackage("numpy");
  pyodide.FS.mkdirTree("/dizione-data");
  for (const name of ["lexicon.tsv", "align.json", "g2p.json", "g2p.npz", "homographs.json"]) {
    pyodide.FS.writeFile("/dizione-data/" + name, await bytes("phonemizer/" + name));
  }
  pyodide.unpackArchive((await bytes("dizione.zip")).buffer, "zip", { extractDir: "/dizione-src" });
  pyodide.runPython(`
import json, os, sys
os.environ["DIZIONE_DATA"] = "/dizione-data"
sys.path.insert(0, "/dizione-src/dizione-8cd889e4de7be6bd1dd2e6891344a0729fa14dd4/src")
import dizione

def phonemize_json(text):
    try:
        result = dizione.phonemize(text)
    except ValueError:
        if any(word for mark, words in dizione.pieces(text) if not mark for word in words):
            raise
        return "null"
    return json.dumps({"ids": list(result.ids), "stress": list(result.stress)})
`);
  phonemize = pyodide.globals.get("phonemize_json");
  ort.env.wasm.wasmPaths = BASE + "ort/";
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  session = await ort.InferenceSession.create(await bytes("onnx/model.onnx"), { executionProviders: ["wasm"] });
}

const ABBREVIATIONS = /(?:\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|no|inc|ltd|co|e\.g|i\.e|a\.m|p\.m)|\b[A-Z])\.$/i;

// Sentences, without breaking after titles, initials or inside numbers.
// tiny_voca.infer.sentences in the Python package splits the same way; keep the two alike.
function sentences(text) {
  const parts = [];
  let current = "";
  for (const piece of text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/)) {
    current = current ? current + " " + piece : piece;
    if (!ABBREVIATIONS.test(current)) { parts.push(current); current = ""; }
  }
  if (current) parts.push(current);
  return parts.filter((part) => /[\p{L}\p{N}]/u.test(part));
}

// A full stop is added when the text ends without a mark: before a final mark the voice lengthens the last
// syllable and lets the sound fall, without one the audio breaks off. A face or another sign after the last word
// is no mark ("see you :)"), a comma or a colon is one. tiny_voca.infer.finished does the same; keep the two alike.
function finished(text) {
  const body = text.replace(/\s+$/, "");
  if (!body) return text;
  const last = body.split(/\s+/).pop();
  const marked = /[\p{L}\p{N}]/u.test(last) ? /[.!?…,;:]["'”’)\]»]*$/.test(last) : /[.!?…]/.test(last) || /^[,;:]$/.test(last);
  return marked ? text : body + ".";
}

// One utterance holds at most max_tokens phonemes; longer sentences are cut at commas, then by words.
// A sentence with nothing to pronounce gives no utterance.
function fit(sentence) {
  const result = JSON.parse(phonemize(sentence));
  if (!result) return [];
  if (result.ids.length <= config.model.max_tokens - 12) return [result];
  const pieces = sentence.split(/(?<=[,;:—])\s+/);
  if (pieces.length > 1) return pieces.flatMap(fit);
  const words = sentence.split(" ");
  if (words.length < 2) throw new Error("A word is too long to pronounce.");
  const half = Math.ceil(words.length / 2);
  return [...fit(words.slice(0, half).join(" ")), ...fit(words.slice(half).join(" "))];
}

async function synthesize(phones, voice, speed) {
  const count = phones.ids.length;
  const integers = (values) => new ort.Tensor("int64", BigInt64Array.from(values.map(BigInt)), [1, count]);
  const scalar = (value) => new ort.Tensor("float32", Float32Array.from([value]), [1]);
  const output = await session.run({
    tokens: integers(phones.ids), stress: integers(phones.stress),
    voice: new ort.Tensor("int64", BigInt64Array.from([BigInt(voice)]), [1]),
    speed: scalar(speed), pitch_shift: scalar(0), pitch_range: scalar(1),
  });
  return output.audio.data;
}


onmessage = async ({ data }) => {
  if (data.type === "next") { acknowledge?.(); return; }
  if (busy) return;
  busy = true;
  const { id } = data;
  try {
    if (data.type !== "speak" || typeof data.text !== "string" || data.text.length > 8000 || !["F2", "M2"].includes(data.voice)) {
      throw new Error("Invalid speech request.");
    }
    postMessage({ type: "status", id, text: "Loading voice…" });
    await (ready ||= load());
    let count = 0;
    for (const sentence of sentences(finished(data.text))) {
      // Bound utterance length even when punctuation is absent.
      const pieces = sentence.match(/.{1,240}(?:\s|$)|\S+/gu) || [];
      for (const piece of pieces) for (const phones of fit(finished(piece))) {
        const audio = await synthesize(phones, data.voice === "M2" ? 1 : 0, 1);
        let peak = 0;
        if (!audio.length || audio.length > 24000 * 33) throw new Error("Invalid voice audio length.");
        for (const x of audio) {
          if (!Number.isFinite(x)) throw new Error("Voice generated invalid audio.");
          peak = Math.max(peak, Math.abs(x));
        }
        if (peak > 0.99) for (let i = 0; i < audio.length; i++) audio[i] *= 0.99 / peak;
        const played = new Promise(resolve => { acknowledge = resolve; });
        postMessage({ type: "audio", id, audio, sampleRate: config.sample_rate }, [audio.buffer]);
        await played; // Backpressure: hold at most one sentence of audio.
        acknowledge = null;
        count++;
      }
    }
    if (!count) throw new Error("The voice can only read English text.");
    postMessage({ type: "done", id });
  } catch (error) {
    postMessage({ type: "error", id, message: error.message || String(error) });
  } finally {
    busy = false;
  }
};
