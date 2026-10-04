import { Command } from "../game/commands";
import { Game } from "../game/sim";
import { AUTO, buildCommand, defendOptions, GUIDE, MODES, moveOptions, Option, VERBS } from "./context";

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
  question: string;
  guide: string[];
  context: string;
  options: string[];
}
export type PickFn = (req: PickRequest) => Promise<{ index: number; probs: number[] }>;

const MIN_CONFIDENCE = 0.4;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Jev-style decider: every step is a calibrated pick-one over a fixed list of options. */
export class PickDecider implements Decider {
  readonly name: string;
  constructor(name: string, private pick: PickFn) { this.name = name; }

  private async choose<T>(utterance: string, question: string, guide: string[], context: string, opts: Option<T>[]) {
    const r = await this.pick({ utterance, question, guide, context, options: opts.map((o) => o.label) });
    return { value: opts[r.index].value, conf: r.probs[r.index], label: opts[r.index].label };
  }

  async decide(text: string, game: Game): Promise<Decision> {
    const t0 = performance.now();
    const done = (command: Command | null, confidence: number, trace: string): Decision =>
      ({ command, confidence, trace, ms: performance.now() - t0 });
    const ctx = game.summary();

    const verb = await this.choose(text, "What does the player want?", GUIDE.action, ctx, VERBS);
    if (!verb.value || verb.conf < MIN_CONFIDENCE) return done(null, verb.conf, `intent: ${verb.label} ${pct(verb.conf)}`);
    if (verb.value === "hold") return done({ kind: "hold" }, verb.conf, `intent: hold ${pct(verb.conf)}`);

    if (verb.value === "attack") {
      const m = await this.choose(text, "Which enemy should the hero attack?", GUIDE.attack, ctx, MODES);
      const trace = `intent: attack ${pct(verb.conf)} → ${m.value ?? "?"} ${pct(m.conf)}`;
      if (!m.value || m.conf < MIN_CONFIDENCE) return done(null, m.conf, trace);
      return done(buildCommand("attack", undefined, m.value), Math.min(verb.conf, m.conf), trace);
    }

    if (verb.value === "move") {
      const p = await this.choose(text, "Where should the hero go?", GUIDE.move, ctx, moveOptions(game));
      const name = p.value ? (p.value.type === "pad" ? p.value.name : p.value.type) : "?";
      const trace = `intent: move ${pct(verb.conf)} → ${name} ${pct(p.conf)}`;
      if (!p.value || p.conf < MIN_CONFIDENCE) return done(null, p.conf, trace);
      return done(buildCommand("move", p.value), Math.min(verb.conf, p.conf), trace);
    }

    const d = await this.choose(text, "What should be built or upgraded, and where?", GUIDE.defend, ctx, defendOptions(game));
    const conf = Math.min(verb.conf, d.conf);
    if (!d.value || d.conf < MIN_CONFIDENCE) return done(null, d.conf, `intent: defend ${pct(verb.conf)} → ${d.label} ${pct(d.conf)}`);
    if (d.value === "auto") {
      const best = game.bestCandidate();
      return done(best?.command ?? null, conf, `intent: defend ${pct(verb.conf)} → ${AUTO.split(" (")[0]} ${pct(d.conf)} → game picked ${best?.label ?? "nothing"}`);
    }
    return done(d.value, conf, `intent: defend ${pct(verb.conf)} → ${d.label.split(" (")[0]} ${pct(d.conf)}`);
  }
}
