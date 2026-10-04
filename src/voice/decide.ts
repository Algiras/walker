import { Command, describeCommand } from "../game/commands";
import { Game } from "../game/sim";
import { actionOptions } from "./context";
import { hintFrom } from "./rules";
import { gateOptions, spokenNumbers } from "./verbs";

export interface Decision {
  command: Command | null;
  confidence: number;
  trace: string;
  ms: number;
}

export interface Decider {
  readonly name: string;
  decide(text: string, game: Game): Promise<Decision>;
}

export interface PickRequest {
  utterance: string;
  context: string;
  options: { key: string; text: string }[];
}
/** Probability of each option, in the order given. */
export type PickFn = (req: PickRequest) => Promise<number[]>;

const MIN_CONFIDENCE = 0.25;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Jev-style decider: one calibrated pick-one over every plausible action in the current game state. */
export class PickDecider implements Decider {
  readonly name: string;
  constructor(name: string, private pick: PickFn) { this.name = name; }

  async decide(heard: string, game: Game): Promise<Decision> {
    const text = spokenNumbers(heard);
    const t0 = performance.now();
    const opts = gateOptions(actionOptions(game), text);
    const req = { utterance: text, context: game.summary() };
    const probs = await this.pick({ ...req, options: opts });
    const index = probs.indexOf(Math.max(...probs));
    const chosen = opts[index];
    const conf = probs[index];
    const done = (command: Command | null, trace: string): Decision => ({ command, confidence: conf, trace, ms: performance.now() - t0 });

    if (chosen.value === null || conf < MIN_CONFIDENCE) return done(null, `${pct(conf)} ${chosen.text}`);
    if (chosen.value === "auto") {
      const best = game.bestCandidate(hintFrom(text.toLowerCase().replace(/[^a-z\s]/g, " ")));
      return done(best?.command ?? null, `${pct(conf)} game chose ${best ? describeCommand(best.command) : "nothing"}`);
    }
    return done(chosen.value, `${pct(conf)} ${describeCommand(chosen.value)}`);
  }
}
