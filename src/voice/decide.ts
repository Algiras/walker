import { Command, describeCommand } from "../game/commands";
import { Game } from "../game/sim";
import { actionOptions } from "./context";
import { hintFrom } from "./rules";
import { mismatch } from "./guard";
import { cleanTranscript, gateOptions, normalize } from "./verbs";

/** act: go ahead. confirm: probably right but not sure enough, ask first. reject: not understood or not allowed. */
export type Status = "act" | "confirm" | "reject";

export interface Decision {
  command: Command | null;
  confidence: number;
  status: Status;
  /** Why it was held back, in words for the player. */
  note?: string;
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

/** At or above this the hero acts. Between MIN and this it asks first. Below MIN it asks the player to repeat. */
export const ACT_CONFIDENCE = 0.7;
export const MIN_CONFIDENCE = 0.25;

/** Applies the confidence thresholds and the build/upgrade guard to a chosen command. */
export function settle(text: string, command: Command | null, confidence: number, game: Game): Pick<Decision, "status" | "note" | "command"> {
  if (!command || confidence < MIN_CONFIDENCE) return { command: null, status: "reject", note: "I did not catch that. Say it again?" };
  const wrong = mismatch(text, command, game);
  if (wrong) return { command: null, status: "reject", note: wrong };
  if (confidence < ACT_CONFIDENCE) return { command, status: "confirm", note: `I am only ${Math.round(confidence * 100)}% sure.` };
  return { command, status: "act" };
}
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Jev-style decider: one calibrated pick-one over every plausible action in the current game state. */
export class PickDecider implements Decider {
  readonly name: string;
  constructor(name: string, private pick: PickFn) { this.name = name; }

  async decide(heard: string, game: Game): Promise<Decision> {
    const text = cleanTranscript(heard);
    const t0 = performance.now();
    const opts = gateOptions(actionOptions(game), text);
    const req = { utterance: text, context: game.summary() };
    const probs = await this.pick({ ...req, options: opts });
    const index = probs.indexOf(Math.max(...probs));
    const chosen = opts[index];
    // How decisively the winner beats the runner-up. Raw probability understates certainty when
    // several near-identical options (every build, every upgrade) share the remaining mass.
    const runnerUp = Math.max(0, ...probs.filter((_, i) => i !== index));
    const conf = probs[index] / (probs[index] + runnerUp);
    const done = (command: Command | null, trace: string): Decision => ({ ...settle(text, command, conf, game), confidence: conf, trace, ms: performance.now() - t0 });

    if (chosen.value === null) return done(null, `${pct(conf)} ${chosen.text}`);
    if (chosen.value === "auto") {
      const best = game.bestCandidate(hintFrom(normalize(text)));
      return done(best?.command ?? null, `${pct(conf)} game chose ${best ? describeCommand(best.command) : "nothing"}`);
    }
    return done(chosen.value, `${pct(conf)} ${describeCommand(chosen.value)}`);
  }
}
