import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type * as OrtTypes from "onnxruntime-web";
import { ParakeetCore } from "../../src/voice/parakeet-core";
import { AutoTokenizer } from "@huggingface/transformers";
import { createTev1Picker, Tokenizer } from "../../src/voice/tev1";
import { PickDecider } from "../../src/voice/decide";

const ROOT = new URL("../../.cache/models/", import.meta.url).pathname;
const REPO = "https://huggingface.co/eschmidbauer/parakeet-redux-onnx/resolve/main/";
// onnxruntime-node cannot read fp16 tensors when Node's native Float16Array exists; hide it so ORT uses Uint16Array.
delete (globalThis as { Float16Array?: unknown }).Float16Array;
const ort = createRequire(import.meta.url)("onnxruntime-node") as unknown as typeof OrtTypes;

async function ensure(file: string): Promise<string> {
  const dest = path.join(ROOT, "parakeet-redux-onnx", file);
  if (existsSync(dest)) return dest;
  mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`downloading ${file}`);
  const res = await fetch(REPO + file);
  if (!res.ok) throw new Error(`${res.status} ${file}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

export async function loadParakeetNode(): Promise<ParakeetCore> {
  const [vocab, pre, enc, dec] = await Promise.all(["vocab.txt", "preprocessor.onnx", "encoder-model.onnx", "decoder_joint-model.onnx"].map(ensure));
  const make = (p: string) => ort.InferenceSession.create(p, { executionProviders: ["cpu"] } as never);
  return new ParakeetCore(ort, { pre: await make(pre), enc: await make(enc), dec: await make(dec) }, readFileSync(vocab, "utf8"));
}

const TEV1 = "goldenfox/tev1-0.8b-decision-onnx";

export async function loadDecider() {
  const dir = path.join(ROOT, "tev1");
  mkdirSync(dir, { recursive: true });
  for (const f of ["model.onnx", "model.onnx.data", "chat_template.jinja"]) {
    const dest = path.join(dir, f);
    if (existsSync(dest)) continue;
    console.log(`downloading ${f}`);
    const res = await fetch(`https://huggingface.co/${TEV1}/resolve/main/${f}`);
    if (!res.ok) throw new Error(`${res.status} ${f}`);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  const session = await ort.InferenceSession.create(path.join(dir, "model.onnx"), { executionProviders: ["cpu"] } as never);
  const tokenizer = (await AutoTokenizer.from_pretrained(TEV1)) as unknown as Tokenizer;
  const pick = createTev1Picker(ort, session, tokenizer, readFileSync(path.join(dir, "chat_template.jinja"), "utf8"));
  return new PickDecider("Tev1 0.8B", pick);
}

export function readWav(file: string): Float32Array {
  const b = readFileSync(file);
  const n = (b.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 2) / 32768;
  return out;
}

export interface NodeStt { name: string; transcribe(pcm: Float32Array): Promise<string> }

/** STT=parakeet (default), whisper-base or whisper-small. */
export async function loadAsr(id = process.env.STT ?? "parakeet"): Promise<NodeStt> {
  if (id === "parakeet") {
    const core = await loadParakeetNode();
    return { name: "Parakeet Redux", transcribe: async (p) => (await core.transcribe(p)).text };
  }
  const repo = id === "whisper-small" ? "Xenova/whisper-small.en" : "Xenova/whisper-base.en";
  const { pipeline } = await import("@huggingface/transformers");
  const p: any = await pipeline("automatic-speech-recognition", repo, { device: "cpu", dtype: "q8" } as never);
  return { name: id, transcribe: async (pcm) => ((await p(pcm)).text ?? "").trim() };
}
