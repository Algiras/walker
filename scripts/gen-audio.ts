// Synthesises each e2e case phrase with Kokoro into tests/fixtures/audio (16 kHz mono WAV).
// Cached: a phrase+voice that already has a file is skipped. Pass --force to re-record everything.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { KokoroTTS } from "kokoro-js";
import { buildState, CASES, fixtureName, SCENARIOS, VOICES } from "../tests/e2e/scenarios";

const OUT = new URL("../tests/fixtures/audio/", import.meta.url).pathname;
const force = process.argv.includes("--force");

function resample(x: Float32Array, from: number, to: number): Float32Array {
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = (i * from) / to, i0 = Math.floor(p), f = p - i0;
    y[i] = x[i0] * (1 - f) + (x[Math.min(i0 + 1, x.length - 1)] ?? 0) * f;
  }
  return y;
}

function wav(pcm: Float32Array, rate: number): Buffer {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(pcm.length * 2, 40);
  pcm.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
  return b;
}

mkdirSync(OUT, { recursive: true });
const todo = CASES.flatMap((c) => VOICES.map((voice) => ({ c, voice, file: fixtureName(c.text, voice) }))).filter((t) => force || !existsSync(OUT + t.file));
if (todo.length) {
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
  for (const { c, voice, file } of todo) {
    const audio = await tts.generate(c.text, { voice: voice as never });
    const pcm = resample(audio.audio, audio.sampling_rate, 16000);
    writeFileSync(OUT + file, wav(pcm, 16000));
    console.log("recorded", file, `${(pcm.length / 16000).toFixed(1)}s`);
  }
}

const manifest = CASES.flatMap((c) =>
  VOICES.map((voice) => ({ file: fixtureName(c.text, voice), voice, text: c.text, scenario: c.scenario, state: SCENARIOS[c.scenario], expect: c.expect, summary: buildState(SCENARIOS[c.scenario]).summary() })),
);
writeFileSync(OUT + "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`${manifest.length} fixtures (${todo.length} newly recorded)`);
