const WORKLET = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice());
    return true;
  }
}
registerProcessor("tap", Tap);
`;

export type MicMode = "ptt" | "vad";
const RATE = 16000;
const PREROLL_BLOCKS = 12;
const MIN_SECONDS = 0.25;

export interface Utterance { pcm: Float32Array; endedAt: number }

export class Mic {
  mode: MicMode = "ptt";
  hangoverMs = 350;
  onUtterance: (u: Utterance) => void = () => {};
  onLevel: (rms: number, active: boolean) => void = () => {};

  private ctx!: AudioContext;
  private pre: Float32Array[] = [];
  private buf: Float32Array[] = [];
  private active = false;
  private held = false;
  private lastVoiced = 0;
  private voicedRun = 0;
  private floor = 0.004;

  static async start(): Promise<Mic> {
    const m = new Mic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    m.ctx = new AudioContext({ sampleRate: RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await m.ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(m.ctx, "tap");
    node.port.onmessage = (e) => m.block(e.data as Float32Array);
    m.ctx.createMediaStreamSource(stream).connect(node);
    return m;
  }

  press() {
    if (this.mode !== "ptt" || this.held) return;
    this.held = true;
    this.begin();
  }

  release() {
    if (this.mode !== "ptt" || !this.held) return;
    this.held = false;
    setTimeout(() => this.finish(performance.now() - 120), 120);
  }

  private begin() {
    this.active = true;
    this.buf = this.pre.slice();
  }

  private finish(endedAt: number) {
    if (!this.active) return;
    this.active = false;
    const n = this.buf.reduce((a, b) => a + b.length, 0);
    if (n / RATE < MIN_SECONDS) return;
    const pcm = new Float32Array(n);
    let o = 0;
    for (const b of this.buf) { pcm.set(b, o); o += b.length; }
    this.buf = [];
    this.onUtterance({ pcm, endedAt });
  }

  private block(b: Float32Array) {
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    const rms = Math.sqrt(s / b.length);
    const now = performance.now();
    this.onLevel(rms, this.active);

    if (this.mode === "vad") {
      if (!this.active) this.floor = this.floor * 0.98 + rms * 0.02;
      const voiced = rms > Math.max(0.012, this.floor * 3.5);
      if (voiced) {
        this.lastVoiced = now;
        this.voicedRun++;
        if (!this.active && this.voicedRun >= 4) this.begin();
      } else this.voicedRun = 0;
      if (this.active && now - this.lastVoiced > this.hangoverMs) {
        this.finish(this.lastVoiced);
        return;
      }
    }

    if (this.active) this.buf.push(b);
    this.pre.push(b);
    if (this.pre.length > PREROLL_BLOCKS) this.pre.shift();
  }
}
