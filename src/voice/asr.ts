import * as ort from "onnxruntime-web/webgpu";
import { fetchCached, Progress } from "./cache";
import { AsrResult, ParakeetCore } from "./parakeet-core";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

export const REPO = "https://huggingface.co/eschmidbauer/parakeet-redux-onnx/resolve/main/";
export type { AsrResult };

export class Parakeet {
  encoderDevice: "webgpu" | "wasm" = "webgpu";
  private core!: ParakeetCore;

  static async load(onProgress: Progress, log: (m: string) => void): Promise<Parakeet> {
    const p = new Parakeet();
    const [vocab, pre, enc, dec] = await Promise.all(
      ["vocab.txt", "preprocessor.onnx", "encoder-model.onnx", "decoder_joint-model.onnx"].map((f) => fetchCached(REPO + f, onProgress)),
    );
    const vocabText = new TextDecoder().decode(vocab);
    const preS = await ort.InferenceSession.create(pre, { executionProviders: ["wasm"] });
    const decS = await ort.InferenceSession.create(dec, { executionProviders: ["wasm"] });
    try {
      const encS = await ort.InferenceSession.create(enc, { executionProviders: ["webgpu"] });
      p.core = new ParakeetCore(ort, { pre: preS, enc: encS, dec: decS }, vocabText);
      await p.core.transcribe(new Float32Array(16000));
    } catch (e) {
      log(`Parakeet encoder on WebGPU failed (${(e as Error).message}); using wasm`);
      p.encoderDevice = "wasm";
      const encS = await ort.InferenceSession.create(enc, { executionProviders: ["wasm"] });
      p.core = new ParakeetCore(ort, { pre: preS, enc: encS, dec: decS }, vocabText);
      await p.core.transcribe(new Float32Array(16000));
    }
    return p;
  }

  transcribe(pcm: Float32Array): Promise<AsrResult> {
    return this.core.transcribe(pcm);
  }
}
