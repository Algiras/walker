import { SpeechQueue } from "./speech-queue";

/** Plays the pre-recorded lines in public/voice/ (see scripts/gen-voice.ts). There is no speech model in the page. */

const STORE = "walker.heroVoice";
const GAIN = 2.2;
const GAP_MS = 90;
const HOLD_POLL_MS = 60;
const MAX_HOLD_MS = 6000;
const RESUME_WAIT_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HeroVoice {
  enabled = true;
  /** Lines wait while this is true (the player is talking), so the hero never speaks over a command being given. */
  holdWhile: () => boolean = () => false;
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private files: Promise<{ lines: Record<string, string>; version: string }> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private current: AudioBufferSourceNode | null = null;
  private queue = new SpeechQueue(3);
  private pumping = false;
  private holding = false;

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORE) !== "off";
    } catch { /* storage can be blocked */ }
  }

  /** True while a line plays or is about to, which is when the microphone must not listen. */
  get speaking() { return this.enabled && this.pumping && !this.holding; }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem(STORE, on ? "on" : "off");
    } catch { /* ignore */ }
    if (!on) this.stop();
  }

  /** Browsers only allow audio after a gesture, so call this from a click or key press. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const gain = this.ctx.createGain();
      gain.gain.value = GAIN;
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      gain.connect(limiter).connect(this.ctx.destination);
      this.out = gain;
    }
    void this.ctx.resume();
    this.files ??= fetch(new URL("voice/manifest.json", document.baseURI), { cache: "no-cache" })
      .then((r) => r.json())
      .then((m) => ({ lines: m.lines as Record<string, string>, version: String(m.version ?? "") }))
      .catch(() => ({ lines: {}, version: "" }));
  }

  private load(line: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(line);
    if (!p) {
      p = (async () => {
        const { lines, version } = await this.files!;
        const file = lines[line];
        if (!file || !this.ctx) return null;
        const res = await fetch(new URL(`voice/${file}?v=${version}`, document.baseURI));
        return res.ok ? this.ctx.decodeAudioData(await res.arrayBuffer()) : null;
      })().catch(() => null);
      this.buffers.set(line, p);
    }
    return p;
  }

  /** Fetches and decodes lines in the background so they play the moment they are needed. */
  prefetch(lines: string[]) {
    if (!this.ctx) return;
    void (async () => {
      for (const l of lines) await this.load(l);
    })();
  }

  stop() {
    this.queue.clear();
    try { this.current?.stop(); } catch { /* already stopped */ }
    this.current = null;
  }

  /** Lines play one after another and never overlap. priority 2 is a reply to an order; priority 1 is a game event. */
  say(line: string, priority: 1 | 2 = 2) {
    if (!this.enabled || (priority === 1 && this.holdWhile())) return;
    if (!this.ctx) this.unlock();
    if (this.queue.push(line, priority, this.pumping)) void this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (let item = this.queue.next(); item; item = this.queue.next()) {
        const buffer = await this.load(item.line);
        if (!buffer || !this.enabled) continue;
        await this.waitForPlayer();
        if (!this.enabled || !(await this.running())) continue;
        await this.play(buffer);
        await sleep(GAP_MS);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async waitForPlayer() {
    this.holding = true;
    try {
      for (let waited = 0; this.enabled && this.holdWhile() && waited < MAX_HOLD_MS; waited += HOLD_POLL_MS) await sleep(HOLD_POLL_MS);
    } finally {
      this.holding = false;
    }
  }

  /** A suspended context never finishes a line, so a line is only started once it runs; otherwise it would come out late. */
  private async running() {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state !== "running") await Promise.race([ctx.resume().catch(() => {}), sleep(RESUME_WAIT_MS)]);
    return ctx.state === "running";
  }

  private play(buffer: AudioBuffer) {
    return new Promise<void>((done) => {
      const src = this.ctx!.createBufferSource();
      src.buffer = buffer;
      src.connect(this.out!);
      const end = () => {
        clearTimeout(guard);
        if (this.current === src) this.current = null;
        done();
      };
      const guard = setTimeout(() => {
        try { src.stop(); } catch { /* already stopped */ }
        end();
      }, buffer.duration * 1000 + 1000);
      src.onended = end;
      this.current = src;
      src.start();
    });
  }
}
