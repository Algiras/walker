import { pipeline } from "@huggingface/transformers";
import { Progress } from "./cache";

export interface Stt {
  readonly name: string;
  readonly device: string;
  transcribe(pcm: Float32Array): Promise<{ text: string; ms: number }>;
}

export const STT_REPO = "onnx-community/whisper-small.en";

/** WebGPU first: fp16 encoder where the GPU supports it, fp32 otherwise, then plain wasm. */
const ATTEMPTS: { device: "webgpu" | "wasm"; dtype: string | Record<string, string> }[] = [
  { device: "webgpu", dtype: { encoder_model: "fp16", decoder_model_merged: "q4" } },
  { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } },
  { device: "wasm", dtype: "q8" },
];

type Recognizer = (audio: Float32Array) => Promise<{ text: string }>;

/** Whisper small.en: the most accurate recogniser that runs comfortably in a browser (see the README for the comparison). */
export async function loadStt(onProgress: Progress, log: (m: string) => void): Promise<Stt> {
  const usable = "gpu" in navigator ? ATTEMPTS : ATTEMPTS.slice(2);
  let lastError: unknown;
  for (const a of usable) {
    try {
      const asr = (await pipeline("automatic-speech-recognition", STT_REPO, {
        device: a.device,
        dtype: a.dtype as never,
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === "progress" && p.file) onProgress(p.file.split("/").pop()!, p.loaded ?? 0, p.total ?? 0);
        },
      } as never)) as unknown as Recognizer;
      await asr(new Float32Array(16000));
      return {
        name: "Whisper small.en",
        device: a.device,
        transcribe: async (pcm) => {
          const t = performance.now();
          const out = await asr(pcm);
          return { text: out.text.trim(), ms: performance.now() - t };
        },
      };
    } catch (e) {
      lastError = e;
      log(`Whisper on ${a.device} (${typeof a.dtype === "string" ? a.dtype : a.dtype.encoder_model}) failed: ${(e as Error).message}`);
    }
  }
  throw lastError;
}
