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
const MAX_SECONDS = 15;
const RELEASE_TAIL_MS = 120;
const ECHO_TAIL_MS = 400;

export interface Utterance { pcm: Float32Array; endedAt: number }

export class Mic {
  hangoverMs = 350;
  onUtterance: (u: Utterance) => void = () => {};
  onLevel: (rms: number, active: boolean) => void = () => {};
  /** Auto-detect hears nothing while this is true (and briefly after), so the hero's own voice is never taken for a command. */
  ignoreInput: () => boolean = () => false;

  private ctx!: AudioContext;
  private pre: Float32Array[] = [];
  private buf: Float32Array[] = [];
  private samples = 0;
  private active = false;
  private held = false;
  private lastVoiced = 0;
  private voicedRun = 0;
  private floor = 0.004;
  private deafUntil = 0;
  private releasedAt = 0;
  private releasing: ReturnType<typeof setTimeout> | undefined;
  private current: MicMode = "ptt";

  static async start(): Promise<Mic> {
    const m = new Mic();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    m.ctx = new AudioContext({ sampleRate: RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await m.ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(m.ctx, "tap");
    node.port.onmessage = (e) => m.feed(e.data as Float32Array);
    m.ctx.createMediaStreamSource(stream).connect(node);
    return m;
  }

  get mode(): MicMode { return this.current; }

  set mode(m: MicMode) {
    if (m === this.current) return;
    this.current = m;
    clearTimeout(this.releasing);
    this.releasing = undefined;
    this.held = false;
    this.active = false;
    this.voicedRun = 0;
    this.buf = [];
    this.samples = 0;
  }

  /** True while a phrase is being captured. */
  get listening() { return this.active; }

  press() {
    if (this.mode !== "ptt" || this.held) return;
    if (this.releasing !== undefined) this.flush();
    this.held = true;
    this.begin();
  }

  release() {
    if (this.mode !== "ptt" || !this.held) return;
    this.held = false;
    this.releasedAt = performance.now();
    this.releasing = setTimeout(() => this.flush(), RELEASE_TAIL_MS);
  }

  private flush() {
    clearTimeout(this.releasing);
    this.releasing = undefined;
    this.finish(this.releasedAt);
  }

  private begin() {
    this.active = true;
    this.buf = this.pre.slice();
    this.samples = this.buf.reduce((a, b) => a + b.length, 0);
  }

  private drop() {
    this.active = false;
    this.buf = [];
    this.samples = 0;
  }

  private finish(endedAt: number) {
    if (!this.active) return;
    const buf = this.buf, n = this.samples;
    this.drop();
    if (n / RATE < MIN_SECONDS) return;
    const pcm = new Float32Array(n);
    let o = 0;
    for (const b of buf) { pcm.set(b, o); o += b.length; }
    this.onUtterance({ pcm, endedAt });
  }

  private deaf(now: number) {
    if (this.ignoreInput()) this.deafUntil = now + ECHO_TAIL_MS;
    return now < this.deafUntil;
  }

  /** Takes one block of microphone audio. */
  feed(b: Float32Array) {
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    const rms = Math.sqrt(s / b.length);
    const now = performance.now();
    this.onLevel(rms, this.active);

    if (this.mode === "vad") {
      if (this.deaf(now)) {
        this.voicedRun = 0;
        this.drop();
        this.keepPreroll(b);
        return;
      }
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

    if (this.active) {
      this.buf.push(b);
      this.samples += b.length;
      if (this.samples >= MAX_SECONDS * RATE) this.finish(now);
    }
    this.keepPreroll(b);
  }

  private keepPreroll(b: Float32Array) {
    this.pre.push(b);
    if (this.pre.length > PREROLL_BLOCKS) this.pre.shift();
  }
}
