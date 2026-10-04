import type * as OrtTypes from "onnxruntime-web";

type Ort = typeof OrtTypes;

const HIDDEN = 640;
const ENC_DIM = 1024;
const MAX_SYMBOLS_PER_STEP = 10;
const SKIP = new Set(["<unk>", "<pad>", "<blk>"]);

export interface AsrResult {
  text: string;
  ms: { pre: number; enc: number; dec: number; total: number };
}

export interface Sessions {
  pre: OrtTypes.InferenceSession;
  enc: OrtTypes.InferenceSession;
  dec: OrtTypes.InferenceSession;
}

/** Runtime-agnostic Parakeet TDT pipeline: works with onnxruntime-web in the page and onnxruntime-node in tests. */
export class ParakeetCore {
  private vocab = new Map<number, string>();
  private blank: number;

  constructor(private ort: Ort, public sessions: Sessions, vocabText: string) {
    for (const line of vocabText.split("\n")) {
      if (!line) continue;
      const i = line.lastIndexOf(" ");
      this.vocab.set(Number(line.slice(i + 1)), line.slice(0, i));
    }
    this.blank = [...this.vocab].find(([, piece]) => piece === "<blk>")![0];
  }

  async transcribe(pcm: Float32Array): Promise<AsrResult> {
    const { Tensor } = this.ort;
    const { pre: preS, enc: encS, dec: decS } = this.sessions;
    const t0 = performance.now();
    const pre = await preS.run({
      waveforms: new Tensor("float32", pcm, [1, pcm.length]),
      waveforms_lens: new Tensor("int64", BigInt64Array.from([BigInt(pcm.length)]), [1]),
    });
    const t1 = performance.now();
    const enc = await encS.run({ audio_signal: pre.features, length: pre.features_lens });
    const frames = Number((await enc.encoded_lengths.getData())[0]);
    const stride = enc.outputs.dims[2];
    const data = (await enc.outputs.getData()) as Float32Array;
    const t2 = performance.now();

    const frame = new Float32Array(ENC_DIM);
    const frameT = new Tensor("float32", frame, [1, ENC_DIM, 1]);
    const target = new Int32Array(1);
    const targetT = new Tensor("int32", target, [1, 1]);
    const targetLen = new Tensor("int32", Int32Array.of(1), [1]);
    let s1: OrtTypes.Tensor = new Tensor("float32", new Float32Array(2 * HIDDEN), [2, 1, HIDDEN]);
    let s2: OrtTypes.Tensor = new Tensor("float32", new Float32Array(2 * HIDDEN), [2, 1, HIDDEN]);
    const vocabSize = this.vocab.size;
    let last = this.blank;
    let f = 0;
    let steps = MAX_SYMBOLS_PER_STEP * frames;
    const tokens: number[] = [];
    while (f < frames && steps-- > 0) {
      for (let c = 0; c < ENC_DIM; c++) frame[c] = data[c * stride + f];
      target[0] = last;
      const out = await decS.run({
        encoder_outputs: frameT, targets: targetT, target_length: targetLen,
        input_states_1: s1, input_states_2: s2,
      });
      const logits = out.outputs.data as Float32Array;
      let tok = 0, best = -Infinity;
      for (let i = 0; i < vocabSize; i++) if (logits[i] > best) { best = logits[i]; tok = i; }
      let di = 0;
      best = -Infinity;
      for (let i = vocabSize; i < logits.length; i++) if (logits[i] > best) { best = logits[i]; di = i - vocabSize; }
      let dur = di;
      if (tok === this.blank && dur === 0) dur = 1;
      if (tok !== this.blank) {
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
