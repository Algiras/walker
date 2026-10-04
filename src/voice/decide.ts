import { Command, describeCommand } from "../game/commands";
import { Game } from "../game/sim";
import { actionOptions } from "./context";
import { hintFrom, ruleParse, worldOf } from "./rules";
import { ACT_CONFIDENCE, AGREEMENT_CONFIDENCE, Decision, settle } from "./settle";
import { cleanTranscript, gateOptions, hasEvidence, intents, normalize } from "./verbs";

export type { Decision, Status } from "./settle";

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

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** What to tell the player when the words point at an action that cannot exist right now. */
function nothingTo(text: string): string {
  const found = intents(text);
  if (found.includes("sell")) return "There is no tower there to sell.";
  return "That is not possible right now.";
}

/** Jev-style decider: one calibrated pick-one over every plausible action in the current game state. */
export class PickDecider implements Decider {
  readonly name: string;
  constructor(name: string, private pick: PickFn) { this.name = name; }

  async decide(heard: string, game: Game): Promise<Decision> {
    const text = cleanTranscript(heard);
    const t0 = performance.now();
    const evidence = hasEvidence(text);
    if (!evidence && text.split(/\s+/).filter(Boolean).length <= 2) {
      return { command: null, confidence: 0, status: "reject", note: "I did not catch that. Say it again?", trace: "nothing to act on in that", ms: performance.now() - t0 };
    }
    const opts = gateOptions(actionOptions(game), text);
    if (!opts.length) return { command: null, confidence: 0, status: "reject", note: nothingTo(text), trace: "no legal action matches", ms: performance.now() - t0 };

    const probs = await this.pick({ utterance: text, context: game.summary(), options: opts });
    const index = probs.indexOf(Math.max(...probs));
    const chosen = opts[index];
    // How decisively the winner beats the runner-up. Raw probability understates certainty when
    // several near-identical options (every build, every upgrade) share the remaining mass.
    const runnerUp = Math.max(0, ...probs.filter((_, i) => i !== index));
    const margin = probs[index] / (probs[index] + runnerUp);

    let command: Command | null = null;
    let what = `${pct(margin)} ${chosen.text}`;
    if (chosen.value === "auto") {
      command = game.bestCandidate(hintFrom(normalize(text)))?.command ?? null;
      what = `${pct(margin)} game chose ${command ? describeCommand(command) : "nothing"}`;
    } else if (chosen.value) {
      command = chosen.value;
      what = `${pct(margin)} ${describeCommand(command)}`;
    }

    const byRules = ruleParse(text, worldOf(game));
    const agree = !!command && !!byRules && JSON.stringify(byRules) === JSON.stringify(command);
    // Without a single keyword to anchor it, a guess may be offered for confirmation but never acted on.
    const confidence = agree ? Math.max(margin, AGREEMENT_CONFIDENCE) : evidence ? margin : Math.min(margin, ACT_CONFIDENCE - 0.01);
    return { ...settle(text, command, confidence, game), confidence, trace: agree ? `${what} · keywords agree` : what, ms: performance.now() - t0 };
  }
}
