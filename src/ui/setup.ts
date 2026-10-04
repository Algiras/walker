import { isCached, Progress } from "../voice/cache";
import { PickDecider } from "../voice/decide";
import { loadPicker, TEV1_DATA_URL } from "../voice/llm";
import { loadStt, Stt, sttCached } from "../voice/stt";
import { $ } from "./dom";
import { trapFocus } from "./modal";

type Step = "stt" | "llm";

export interface SetupHooks {
  log: (message: string) => void;
  /** Both models are loaded. */
  onModels: (stt: Stt, decider: PickDecider) => void;
  /** Opens the microphone and wires it into the game. Rejects when there is none. */
  startMic: () => Promise<void>;
}

function stepProgress(step: Step): Progress {
  const li = $(`step-${step}`);
  const state = li.querySelector<HTMLElement>(".step-state")!;
  const track = li.querySelector<HTMLElement>(".sk-track")!;
  const fill = track.querySelector<HTMLElement>("i")!;
  const files = new Map<string, { got: number; total: number }>();
  let best = 0;
  li.classList.remove("cached", "done", "failed");
  fill.style.width = "0";
  track.classList.add("skeleton");
  state.textContent = "Starting";
  return (file, got, total) => {
    files.set(file, { got, total: total || got });
    let g = 0, t = 0;
    for (const v of files.values()) { g += v.got; t += v.total; }
    best = Math.max(best, t ? g / t : 0);
    fill.style.width = `${best * 100}%`;
    track.setAttribute("aria-valuenow", String(Math.round(best * 100)));
    state.textContent = `${Math.round(best * 100)}%`;
  };
}

function stepEnd(step: Step, outcome: "done" | "failed", text: string) {
  const li = $(`step-${step}`);
  li.classList.remove("cached");
  li.classList.add(outcome);
  li.querySelector(".sk-track")!.classList.remove("skeleton");
  li.querySelector<HTMLElement>(".step-state")!.textContent = text;
  if (outcome === "done") li.querySelector<HTMLElement>("i")!.style.width = "100%";
}

/** The dialog that gets the voice models ready before the game runs. While it is open the game stands still. */
export class Setup {
  open: boolean;
  private started: boolean;
  private voiceReady = false;
  private untrap: (() => void) | null = null;
  private el = $("setup");
  private startBtn = $<HTMLButtonElement>("start");
  private loadBtn = $<HTMLButtonElement>("load");

  constructor(private hooks: SetupHooks, showNow: boolean) {
    this.open = showNow;
    this.started = !showNow;
    this.el.hidden = !showNow;
    this.startBtn.addEventListener("click", () => this.close());
    this.loadBtn.addEventListener("click", () => void this.load());
    $("setupOpen").addEventListener("click", () => void this.show());
    if (showNow) void this.show();
  }

  /** Escape leaves the dialog, but only once the player has seen the game. */
  dismiss() {
    if (this.open && this.started) this.close();
  }

  private note(message: string) { $("setup-note").textContent = message; }
  private status(message: string) { $("status").textContent = message; }

  private renderButtons() {
    const { startBtn, loadBtn } = this;
    loadBtn.hidden = this.voiceReady;
    startBtn.textContent = this.started ? "Back to the game" : this.voiceReady ? "Start game" : "Start without voice";
    startBtn.classList.toggle("primary", this.voiceReady);
  }

  private async show() {
    const { startBtn, loadBtn } = this;
    this.open = true;
    this.el.hidden = false;
    this.untrap ??= trapFocus(this.el, [...document.querySelectorAll<HTMLElement>("body > header, body > main")]);
    this.renderButtons();
    const gpu = "gpu" in navigator;
    if (!gpu) loadBtn.disabled = true;
    const first = [this.voiceReady ? startBtn : loadBtn, startBtn].find((b) => !b.disabled);
    (first ?? $("want-voice")).focus();
    if (this.voiceReady) return;

    const [llmHit, sttHit] = await Promise.all([isCached(TEV1_DATA_URL), sttCached()]);
    for (const [step, hit] of [["stt", sttHit], ["llm", llmHit]] as const) {
      const li = $(`step-${step}`);
      if (li.classList.contains("done")) continue;
      li.classList.toggle("cached", hit);
      li.querySelector<HTMLElement>(".step-state")!.textContent = hit ? "Downloaded" : "Not downloaded";
    }
    if (!gpu) {
      this.note("WebGPU is not available in this browser, so voice is off. You can still play with the buttons, the map and typed commands.");
    } else if (sttHit && llmHit) {
      loadBtn.textContent = "Load models";
      this.note("Both models are already downloaded. Loading takes a few seconds.");
    } else {
      loadBtn.textContent = "Download and load models";
      this.note(sttHit || llmHit ? "Part of the download is already cached." : "Downloads about 1.3 GB once, then it is cached in this browser.");
    }
  }

  private close() {
    this.open = false;
    this.started = true;
    this.el.hidden = true;
    this.untrap?.();
    this.untrap = null;
  }

  private async load() {
    const { startBtn, loadBtn } = this;
    loadBtn.disabled = true;
    loadBtn.textContent = "Loading…";
    startBtn.disabled = true;
    let step: Step = "stt";
    try {
      this.note("Downloading and loading. The game is waiting for you.");
      const stt = await loadStt(stepProgress("stt"), this.hooks.log);
      stepEnd("stt", "done", stt.device);

      step = "llm";
      const decider = new PickDecider("Tev1 0.8B", await loadPicker(stepProgress("llm")));
      stepEnd("llm", "done", "webgpu");
      this.hooks.onModels(stt, decider);
      this.voiceReady = true;

      try {
        await this.hooks.startMic();
        this.status("Ready. Hold Space and speak.");
        this.note("Ready. Hold Space and speak once the game starts.");
      } catch {
        this.status("Models ready, but the microphone is unavailable. You can still type commands.");
        this.note("Models are ready, but the microphone is unavailable. You can still type commands.");
      }
    } catch (e) {
      stepEnd(step, "failed", "Failed");
      this.note(`Failed: ${(e as Error).message}`);
      loadBtn.disabled = false;
      loadBtn.textContent = "Try again";
    } finally {
      startBtn.disabled = false;
      this.renderButtons();
      (this.voiceReady ? startBtn : loadBtn).focus();
    }
  }
}
