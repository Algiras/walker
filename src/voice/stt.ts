import { pipeline } from "@huggingface/transformers";
import { Parakeet } from "./asr";
import { Progress } from "./cache";

export type SttId = "parakeet" | "whisper-base" | "whisper-small";

export const STT_OPTIONS: { id: SttId; label: string; size: string }[] = [
  { id: "parakeet", label: "Parakeet Redux", size: "440 MB" },
  { id: "whisper-base", label: "Whisper base.en", size: "~205 MB" },
  { id: "whisper-small", label: "Whisper small.en", size: "~520 MB" },
];

export interface Stt {
  readonly name: string;
  readonly device: string;
  transcribe(pcm: Float32Array): Promise<{ text: string; ms: number }>;
}

const WHISPER = {
  "whisper-base": { repo: "onnx-community/whisper-base.en", name: "Whisper base.en", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } },
  "whisper-small": { repo: "onnx-community/whisper-small.en", name: "Whisper small.en", dtype: { encoder_model: "fp16", decoder_model_merged: "q4" } },
} as const;

export async function loadStt(id: SttId, onProgress: Progress, log: (m: string) => void): Promise<Stt> {
  if (id === "parakeet") {
    const p = await Parakeet.load(onProgress, log);
    return {
      name: "Parakeet Redux",
      device: p.encoderDevice,
      transcribe: async (pcm) => {
        const r = await p.transcribe(pcm);
        return { text: r.text, ms: r.ms.total };
      },
    };
  }
  const w = WHISPER[id];
  const device = "gpu" in navigator ? "webgpu" : "wasm";
  const asr = (await pipeline("automatic-speech-recognition", w.repo, {
    device,
    dtype: device === "webgpu" ? (w.dtype as never) : "q8",
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) onProgress(p.file.split("/").pop()!, p.loaded ?? 0, p.total ?? 0);
    },
  } as never)) as unknown as (a: Float32Array) => Promise<{ text: string }>;
  await asr(new Float32Array(16000));
  return {
    name: w.name,
    device,
    transcribe: async (pcm) => {
      const t = performance.now();
      const out = await asr(pcm);
      return { text: out.text.trim(), ms: performance.now() - t };
    },
  };
}
