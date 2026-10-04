import * as ort from "onnxruntime-web/webgpu";
import { fetchCached, Progress } from "./cache";

ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

const REPO = "https://huggingface.co/eschmidbauer/parakeet-redux-onnx/resolve/main/";
const DURATIONS = [0, 1, 2, 3, 4];
const VOCAB_SIZE = 8193;
const BLANK = 8192;
const HIDDEN = 640;
const ENC_DIM = 1024;
const MAX_SYMBOLS_PER_STEP = 10;
const SKIP = new Set(["<unk>", "<pad>", "<blk>"]);

export interface AsrResult {
  text: string;
  ms: { pre: number; enc: number; dec: number; total: number };
}

export class Parakeet {
  encoderDevice: "webgpu" | "wasm" = "webgpu";
  private vocab = new Map<number, string>();
  private pre!: ort.InferenceSession;
  private enc!: ort.InferenceSession;
  private dec!: ort.InferenceSession;

  static async load(onProgress: Progress, log: (m: string) => void): Promise<Parakeet> {
    const p = new Parakeet();
    const [vocab, pre, enc, dec] = await Promise.all(
      ["vocab.txt", "preprocessor.onnx", "encoder-model.onnx", "decoder_joint-model.onnx"].map((f) => fetchCached(REPO + f, onProgress)),
    );
    for (const line of new TextDecoder().decode(vocab).split("\n")) {
      if (!line) continue;
      const i = line.lastIndexOf(" ");
      p.vocab.set(Number(line.slice(i + 1)), line.slice(0, i));
    }
    p.pre = await ort.InferenceSession.create(pre, { executionProviders: ["wasm"] });
    p.dec = await ort.InferenceSession.create(dec, { executionProviders: ["wasm"] });
    try {
      p.enc = await ort.InferenceSession.create(enc, { executionProviders: ["webgpu"] });
      await p.transcribe(new Float32Array(16000));
    } catch (e) {
      log(`Parakeet encoder on WebGPU failed (${(e as Error).message}); using wasm`);
      p.encoderDevice = "wasm";
      p.enc = await ort.InferenceSession.create(enc, { executionProviders: ["wasm"] });
      await p.transcribe(new Float32Array(16000));
    }
    return p;
  }

  async transcribe(pcm: Float32Array): Promise<AsrResult> {
    const t0 = performance.now();
    const pre = await this.pre.run({
      waveforms: new ort.Tensor("float32", pcm, [1, pcm.length]),
      waveforms_lens: new ort.Tensor("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]),
    });
    const t1 = performance.now();
    const enc = await this.enc.run({ audio_signal: pre.features, length: pre.features_lens });
    const frames = Number((await enc.encoded_lengths.getData())[0]);
    const stride = enc.outputs.dims[2];
    const data = (await enc.outputs.getData()) as Float32Array;
    const t2 = performance.now();

    const frame = new Float32Array(ENC_DIM);
    const frameT = new ort.Tensor("float32", frame, [1, ENC_DIM, 1]);
    const target = new Int32Array(1);
    const targetT = new ort.Tensor("int32", target, [1, 1]);
    const targetLen = new ort.Tensor("int32", Int32Array.of(1), [1]);
    let s1: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * HIDDEN), [2, 1, HIDDEN]);
    let s2: ort.Tensor = new ort.Tensor("float32", new Float32Array(2 * HIDDEN), [2, 1, HIDDEN]);
    let last = BLANK;
    let f = 0;
    let steps = MAX_SYMBOLS_PER_STEP * frames;
    const tokens: number[] = [];
    while (f < frames && steps-- > 0) {
      for (let c = 0; c < ENC_DIM; c++) frame[c] = data[c * stride + f];
      target[0] = last;
      const out = await this.dec.run({
        encoder_outputs: frameT, targets: targetT, target_length: targetLen,
        input_states_1: s1, input_states_2: s2,
      });
      const logits = out.outputs.data as Float32Array;
      let tok = 0, best = -Infinity;
      for (let i = 0; i < VOCAB_SIZE; i++) if (logits[i] > best) { best = logits[i]; tok = i; }
      let di = 0;
      best = -Infinity;
      for (let i = 0; i < DURATIONS.length; i++) if (logits[VOCAB_SIZE + i] > best) { best = logits[VOCAB_SIZE + i]; di = i; }
      let dur = DURATIONS[di];
      if (tok === BLANK && dur === 0) dur = 1;
      if (tok !== BLANK) {
        tokens.push(tok);
        last = tok;
        s1 = out.output_states_1;
        s2 = out.output_states_2;
      }
      f += dur;
    }
    const t3 = performance.now();
    let text = tokens.map((t) => this.vocab.get(t)!).filter((p) => !SKIP.has(p)).join("").replaceAll("▁", " ");
    if (text.startsWith(" ")) text = text.slice(1);
    return { text, ms: { pre: t1 - t0, enc: t2 - t1, dec: t3 - t2, total: t3 - t0 } };
  }
}
