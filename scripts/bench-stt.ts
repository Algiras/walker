// Compares speech recognizers on the spoken e2e fixtures, clean and with added noise.
//   npm run bench:stt
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline, env } from "@huggingface/transformers";
import type * as OrtTypes from "onnxruntime-web";
import { ParakeetCore } from "../src/voice/parakeet-core";
import { loadParakeetNode, readWav } from "../tests/e2e/node-models";
import { PAD_NAMES } from "../src/game/map";

env.cacheDir = new URL("../.cache/transformers/", import.meta.url).pathname;
const AUDIO = new URL("../tests/fixtures/audio/", import.meta.url).pathname;
const ROOT = new URL("../.cache/models/", import.meta.url).pathname;
const manifest: { file: string; text: string }[] = JSON.parse(readFileSync(AUDIO + "manifest.json", "utf8"));
const ort = createRequire(import.meta.url)("onnxruntime-node") as unknown as typeof OrtTypes;

// --- noise -------------------------------------------------------------------------------------
function rng(seed: number) { let a = seed; return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296); }
function addNoise(pcm: Float32Array, snrDb: number, seed: number): Float32Array {
  const r = rng(seed);
  let sp = 0;
  for (const v of pcm) sp += v * v;
  sp /= pcm.length;
  const out = new Float32Array(pcm.length);
  let lp = 0;
  const raw = new Float32Array(pcm.length);
  let np = 0;
  for (let i = 0; i < pcm.length; i++) {
    const white = (r() + r() + r() + r() - 2) * 1.7;
    lp = 0.95 * lp + 0.05 * white; // low-passed: closer to room and fan noise than pure white
    raw[i] = white * 0.4 + lp * 3 + 0.3 * Math.sin((2 * Math.PI * 60 * i) / 16000);
    np += raw[i] * raw[i];
  }
  np /= pcm.length;
  const gain = Math.sqrt(sp / (np * 10 ** (snrDb / 10)));
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] + raw[i] * gain));
  return out;
}

// --- scoring -----------------------------------------------------------------------------------
const norm = (t: string) => t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
function edit(a: string[], b: string[]) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const PADS = new Set(PAD_NAMES.map((n) => n.toLowerCase()));

// --- recognizers -------------------------------------------------------------------------------
type Asr = { name: string; size: string; run: (pcm: Float32Array) => Promise<string> };

async function get(url: string, dest: string) {
  if (existsSync(dest)) return dest;
  mkdirSync(path.dirname(dest), { recursive: true });
  console.log("downloading", url.split("/").pop());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function parakeetV2(): Promise<Asr> {
  const base = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/";
  const dir = ROOT + "parakeet-v2/";
  const [vocab, pre, enc, dec] = await Promise.all([
    get(base + "vocab.txt", dir + "vocab.txt"), get(base + "nemo128.onnx", dir + "nemo128.onnx"),
    get(base + "encoder-model.int8.onnx", dir + "enc.onnx"), get(base + "decoder_joint-model.int8.onnx", dir + "dec.onnx"),
  ]);
  const make = (p: string) => ort.InferenceSession.create(p, { executionProviders: ["cpu"] } as never);
  const core = new ParakeetCore(ort, { pre: await make(pre), enc: await make(enc), dec: await make(dec) }, readFileSync(vocab, "utf8"));
  return { name: "Parakeet TDT 0.6B v2 (int8)", size: "661 MB", run: async (p) => (await core.transcribe(p)).text };
}

async function viaPipeline(name: string, size: string, model: string, opts: Record<string, unknown>): Promise<Asr> {
  const p: any = await pipeline("automatic-speech-recognition", model, { device: "cpu", ...opts } as never);
  return { name, size, run: async (pcm) => (await p(pcm)).text ?? "" };
}

const candidates: (() => Promise<Asr>)[] = [
  async () => { const c = await loadParakeetNode(); return { name: "Parakeet Redux (current)", size: "440 MB", run: async (p) => (await c.transcribe(p)).text }; },
  parakeetV2,
  () => viaPipeline("Moonshine base", "63 MB", "onnx-community/moonshine-base-ONNX", { dtype: "q8" }),
  () => viaPipeline("Whisper base.en", "~150 MB", "Xenova/whisper-base.en", { dtype: "q8" }),
  () => viaPipeline("Whisper small.en", "~250 MB", "Xenova/whisper-small.en", { dtype: "q8" }),
];

const only = process.env.STT?.split(",");
const CONDITIONS: [string, number | null][] = [["clean", null], ["15 dB", 15], ["5 dB", 5]];
const rows: string[] = [];
for (const make of candidates) {
  let asr: Asr;
  try { asr = await make(); } catch (e) { console.log("skip:", String(e).slice(0, 140)); continue; }
  if (only && !only.some((o) => asr.name.toLowerCase().includes(o.toLowerCase()))) continue;
  const cells: string[] = [];
  for (const [label, snr] of CONDITIONS) {
    let err = 0, words = 0, padMiss = 0, padTotal = 0, ms = 0;
    for (const [i, m] of manifest.entries()) {
      let pcm = readWav(AUDIO + m.file);
      if (snr !== null) pcm = addNoise(pcm, snr, i + 1);
      const t = performance.now();
      const heard = norm(await asr.run(pcm));
      ms += performance.now() - t;
      const ref = norm(m.text);
      err += edit(ref, heard);
      words += ref.length;
      for (const w of ref.filter((w) => PADS.has(w))) { padTotal++; if (!heard.includes(w)) padMiss++; }
    }
    cells.push(`${((100 * err) / words).toFixed(1)}% WER, pads ${padTotal - padMiss}/${padTotal}, ${(ms / manifest.length).toFixed(0)} ms`);
    void label;
  }
  rows.push(`| ${asr.name} | ${asr.size} | ${cells.join(" | ")} |`);
  console.log(rows[rows.length - 1]);
}
console.log("\n| Model | Download | clean | 15 dB SNR | 5 dB SNR |\n|---|---|---|---|---|\n" + rows.join("\n"));
