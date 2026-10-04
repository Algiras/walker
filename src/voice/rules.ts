import { Command, FocusMode, Place } from "../game/commands";
import { Game, Hint } from "../game/sim";
import { Decider } from "./decide";
import { Decision, settle } from "./settle";
import { mentions } from "./fuzzy";
import { cleanTranscript, goalOf, intents, slotNumber, VERBS } from "./verbs";

const has = (s: string, re: RegExp) => re.test(s);

export interface RuleWorld {
  padNames: string[];
  hasTower: (pad: string) => boolean;
  best: (hint: Hint) => Command | null;
  padOfSlot: (n: number) => string | undefined;
}

export function hintFrom(s: string): Hint {
  const wantsBuild = /\b(build|place|construct|put|create)\b/.test(s), wantsUpgrade = /\b(upgrade|improve|strengthen|reinforce|stronger)\b/.test(s);
  return { ...goalOf(s), prefer: wantsBuild && !wantsUpgrade ? "build" : wantsUpgrade && !wantsBuild ? "upgrade" : undefined };
}

export function ruleParse(text: string, w: RuleWorld): Command | null {
  const num = slotNumber(text);
  const s = cleanTranscript(text).toLowerCase().replace(/[^a-z\s]/g, " ");
  const words = s.split(/\s+/).filter(Boolean);
  const numbered = num === null ? undefined : w.padOfSlot(num);
  const pad = numbered ?? w.padNames.find((n) => mentions(words, n));
  const place: Place | null = pad
    ? { type: "pad", name: pad }
    : has(s, /\b(base|home|retreat|fall back)\b/) ? { type: "base" }
    : has(s, /\b(spawn|entrance|start)\b/) ? { type: "spawn" } : null;

  const found = intents(text);
  if (found.includes("undo")) return { kind: "undo" };
  if (found.includes("repeat") && found.length === 1) return { kind: "repeat" };
  if (found.includes("game")) {
    if (/\b(next wave|call|send)\b/.test(s)) return { kind: "nextwave" };
    if (/\b(pause)\b/.test(s)) return { kind: "pause" };
    if (/\b(resume|unpause|continue)\b/.test(s)) return { kind: "resume" };
    if (/\b(slower|slow|normal)\b/.test(s)) return { kind: "speed", fast: false };
    return { kind: "speed", fast: true };
  }
  if (/\bpatrol\b/.test(s)) return { kind: "patrol" };
  const dir = s.match(/\b(left|right|up|down|north|south|east|west)\b/)?.[1];
  if (dir && found.includes("move") && !pad && !/\b(to|base|spawn)\b/.test(s)) {
    return { kind: "nudge", dir: ({ north: "up", south: "down", east: "right", west: "left" } as Record<string, "up" | "down" | "left" | "right">)[dir] ?? (dir as "left") };
  }
  if (intents(text).includes("sell") && pad) return w.hasTower(pad) ? { kind: "sell", pad } : null;
  const defend = has(s, VERBS.defend) || (has(s, /\btowers?\b/) && !intents(text).length);
  if (defend) {
    if (pad) return w.hasTower(pad) ? { kind: "upgrade", pad } : { kind: "build", pad };
    return w.best(hintFrom(s));
  }
  if (intents(text).includes("attack")) {
    const mode: FocusMode = has(s, /\b(strong|strongest|big|biggest|tank|tough)\b/) ? "strongest"
      : has(s, /\b(weak|weakest|small|smallest|low)\b/) ? "weakest"
      : has(s, /\b(first|leading|front|furthest)\b/) ? "first" : "nearest";
    return { kind: "attack", mode };
  }
  if (has(s, VERBS.hold)) return { kind: "hold" };
  if (has(s, VERBS.move) || place) return place ? { kind: "move", to: place } : null;
  return null;
}

export const worldOf = (game: Game): RuleWorld => ({
  padNames: game.map.pads.map((p) => p.name),
  hasTower: (n) => !!game.towerAt(n),
  best: (hint) => game.bestCandidate(hint)?.command ?? null,
  padOfSlot: (n) => game.map.pads[n - 1]?.name,
});

/** Keyword fallback: runs with no model download, and also gives the model a second opinion. */
export class RuleDecider implements Decider {
  readonly name = "keyword rules";
  async decide(text: string, game: Game): Promise<Decision> {
    const t0 = performance.now();
    const parsed = ruleParse(text, worldOf(game));
    return { ...settle(text, parsed, parsed ? 1 : 0, game), confidence: parsed ? 1 : 0, trace: "keyword match", ms: performance.now() - t0 };
  }
}
