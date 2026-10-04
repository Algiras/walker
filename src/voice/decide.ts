import { Command } from "../game/commands";
import { Game } from "../game/sim";
import { buildCommand, MODES, Option, placeOptions, VERBS } from "./context";

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

export type PickFn = (utterance: string, question: string, options: string[]) => Promise<{ index: number; probs: number[] }>;

const MIN_CONFIDENCE = 0.45;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Jev-style decider: every step is a calibrated pick-one over a fixed list of options. */
export class PickDecider implements Decider {
  readonly name: string;
  constructor(name: string, private pick: PickFn) { this.name = name; }

  private async choose<T>(utterance: string, question: string, opts: Option<T>[]) {
    const r = await this.pick(utterance, question, opts.map((o) => o.label));
    return { value: opts[r.index].value, conf: r.probs[r.index], label: opts[r.index].label };
  }

  async decide(text: string, game: Game): Promise<Decision> {
    const t0 = performance.now();
    const done = (command: Command | null, confidence: number, trace: string): Decision =>
      ({ command, confidence, trace, ms: performance.now() - t0 });

    const verb = await this.choose(text, "Which action does the player want?", VERBS);
    if (!verb.value || verb.conf < MIN_CONFIDENCE) return done(null, verb.conf, `action: ${verb.label} ${pct(verb.conf)}`);
    if (verb.value === "hold") return done({ kind: "hold" }, verb.conf, `action: hold ${pct(verb.conf)}`);

    if (verb.value === "attack") {
      const m = await this.choose(text, "Which enemy should the hero attack?", MODES);
      const trace = `action: attack ${pct(verb.conf)} → ${m.value ?? "?"} ${pct(m.conf)}`;
      if (!m.value || m.conf < MIN_CONFIDENCE) return done(null, m.conf, trace);
      return done(buildCommand("attack", undefined, m.value), Math.min(verb.conf, m.conf), trace);
    }

    const place = await this.choose(text, "Which place does the player mean?", placeOptions(game, verb.value));
    const name = place.value ? (place.value.type === "pad" ? place.value.name : place.value.type) : "?";
    const trace = `action: ${verb.value} ${pct(verb.conf)} → ${name} ${pct(place.conf)}`;
    if (!place.value || place.conf < MIN_CONFIDENCE) return done(null, place.conf, trace);
    return done(buildCommand(verb.value, place.value), Math.min(verb.conf, place.conf), trace);
  }
}
