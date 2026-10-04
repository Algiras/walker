import { Command, FocusMode, Place } from "../game/commands";
import { Game, Hint } from "../game/sim";
import { Decider } from "./decide";
import { Decision, settle } from "./settle";
import { mentions } from "./fuzzy";
import { BASE_WORDS, BUILD, cleanTranscript, enemyNumber, GAME_WORDS, goalOf, intents, NEAREST, ordinalOf, padsNamed, slotNumber, SPAWN_WORDS, STRONGEST, UPGRADE, VERBS, WEAKEST } from "./verbs";

const has = (s: string, re: RegExp) => re.test(s);

export interface RuleWorld {
  padNames: string[];
  hasTower: (pad: string) => boolean;
  best: (hint: Hint) => Command | null;
  padOfSlot: (n: number) => string | undefined;
}

export function hintFrom(s: string): Hint {
  const wantsBuild = BUILD.test(s), wantsUpgrade = UPGRADE.test(s);
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
    : has(s, BASE_WORDS) ? { type: "base" }
    : has(s, SPAWN_WORDS) ? { type: "spawn" } : null;

  const found = intents(text);
  if (found.includes("undo")) return { kind: "undo" };
  if (found.includes("repeat") && found.length === 1) return { kind: "repeat" };
  if (found.includes("game")) {
    if (has(s, GAME_WORDS.nextwave)) return { kind: "nextwave" };
    if (has(s, GAME_WORDS.pause)) return { kind: "pause" };
    if (has(s, GAME_WORDS.resume)) return { kind: "resume" };
    return { kind: "speed", fast: !has(s, GAME_WORDS.slow) };
  }
  if (/\bpatrol\b/.test(s)) return found.includes("hold") ? { kind: "hold" } : { kind: "patrol" };
  const dir = s.match(/\b(left|right|up|down|north|south|east|west)\b/)?.[1];
  if (dir && found.includes("move") && !pad && !/\b(to|base|spawn)\b/.test(s)) {
    return { kind: "nudge", dir: ({ north: "up", south: "down", east: "right", west: "left" } as Record<string, "up" | "down" | "left" | "right">)[dir] ?? (dir as "left") };
  }
  if (intents(text).includes("sell") && pad) return w.hasTower(pad) ? { kind: "sell", pad } : null;
  const defend = has(s, VERBS.defend) || (has(s, /\btowers?\b/) && !intents(text).length);
  if (defend) {
    if (pad) return w.hasTower(pad) ? { kind: "upgrade", pad } : { kind: "build", pad };
    // A pad the map does not have ("tower 8", "Hotel") is not the same as no place named.
    return padsNamed(text).length ? null : w.best(hintFrom(s));
  }
  if (intents(text).includes("attack")) {
    const en = enemyNumber(text);
    if (en !== null) return { kind: "attack", mode: "number", n: en };
    const rank = ordinalOf(text);
    if (rank !== null) return { kind: "attack", mode: "rank", n: rank };
    const mode: FocusMode = has(s, STRONGEST) ? "strongest"
      : has(s, WEAKEST) ? "weakest"
      : has(s, NEAREST) ? "nearest"
      : has(s, /\b(last|back|rear|slowest|trailing)\b/) ? "last"
      : has(s, /\b(first|lead|leading|front|furthest)\b/) ? "first" : "nearest";
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
