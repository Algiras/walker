/** Plays the pre-recorded lines in public/voice/ (see scripts/gen-voice.ts). There is no speech model in the page. */

const STORE = "walker.heroVoice";
const GAIN = 2.2;

export class HeroVoice {
  enabled = true;
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private files: Promise<Record<string, string>> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private current: AudioBufferSourceNode | null = null;
  private seq = 0;
  private commandPending = false;

  constructor() {
    try {
      this.enabled = localStorage.getItem(STORE) !== "off";
    } catch { /* storage can be blocked */ }
  }

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
    this.files ??= fetch(new URL("voice/manifest.json", document.baseURI)).then((r) => r.json()).then((m) => m.lines).catch(() => ({}));
  }

  private load(line: string): Promise<AudioBuffer | null> {
    let p = this.buffers.get(line);
    if (!p) {
      p = (async () => {
        const file = (await this.files!)[line];
        if (!file || !this.ctx) return null;
        const res = await fetch(new URL(`voice/${file}`, document.baseURI));
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
    try { this.current?.stop(); } catch { /* already stopped */ }
    this.current = null;
  }

  /** priority 2 is a reply to a command and cuts off whatever is playing. priority 1 (game events) never interrupts. */
  async say(line: string, priority: 1 | 2 = 2) {
    if (!this.enabled) return;
    if (!this.ctx) this.unlock();
    if (priority === 1 && (this.current || this.commandPending)) return;
    let mine = this.seq;
    if (priority === 2) {
      mine = ++this.seq;
      this.commandPending = true;
      this.stop();
    }
    const buffer = await this.load(line);
    if (priority === 2) {
      if (mine !== this.seq) return;
      this.commandPending = false;
    } else if (this.current || this.commandPending) return;
    if (!buffer || !this.ctx || !this.out || !this.enabled) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    src.onended = () => { if (this.current === src) this.current = null; };
    this.current = src;
    src.start();
  }
}
