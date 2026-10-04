import { Command, FocusMode, Place } from "../game/commands";
import { Game, Hint } from "../game/sim";
import { Decider, Decision } from "./decide";
import { spokenNumbers, towerNumber, VERBS } from "./verbs";

const lev = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};

const closeEnough = (a: string, b: string) => {
  const d = lev(a, b);
  return d <= 2 && d / Math.max(a.length, b.length) <= 0.4;
};

const has = (s: string, re: RegExp) => re.test(s);

export interface RuleWorld {
  padNames: string[];
  hasTower: (pad: string) => boolean;
  best: (hint: Hint) => Command | null;
  padOfTower: (id: number) => string | undefined;
}

export function hintFrom(s: string): Hint {
  const area = s.match(/\b(left|right|top|bottom|middle|center|centre)\b/)?.[1];
  return {
    area: area === "centre" ? "center" : area,
    near: has(s, /\b(spawn|entrance|early|start)\b/) ? "spawn" : has(s, /\b(base|home|last line)\b/) ? "base" : undefined,
    pressure: has(s, /\b(pressure|under attack|where (they|the enemies|enemies) (are|come))\b/),
  };
}

export function ruleParse(text: string, w: RuleWorld): Command | null {
  const num = towerNumber(text);
  const s = spokenNumbers(text).toLowerCase().replace(/[^a-z\s]/g, " ");
  const words = s.split(/\s+/).filter(Boolean);
  const numbered = num === null ? undefined : w.padOfTower(num);
  const pad = numbered ?? w.padNames.find((n) => words.some((x) => x === n.toLowerCase() || (x.length > 3 && closeEnough(x, n.toLowerCase()))));
  const place: Place | null = pad
    ? { type: "pad", name: pad }
    : has(s, /\b(base|home|retreat|fall back)\b/) ? { type: "base" }
    : has(s, /\b(spawn|entrance|start)\b/) ? { type: "spawn" } : null;

  const defend = has(s, VERBS.defend);
  if (defend) {
    if (pad) return w.hasTower(pad) ? { kind: "upgrade", pad } : { kind: "build", pad };
    return w.best(hintFrom(s));
  }
  if (has(s, VERBS.attack)) {
    const mode: FocusMode = has(s, /\b(strong|strongest|big|biggest|tank|tough)\b/) ? "strongest"
      : has(s, /\b(weak|weakest|small|smallest|low)\b/) ? "weakest"
      : has(s, /\b(first|leading|front|furthest)\b/) ? "first" : "nearest";
    return { kind: "attack", mode };
  }
  if (has(s, VERBS.hold)) return { kind: "hold" };
  if (has(s, VERBS.move) || place) return place ? { kind: "move", to: place } : null;
  return null;
}

/** Keyword fallback: runs with no model download, and doubles as a test oracle for the LLM decider. */
export class RuleDecider implements Decider {
  readonly name = "keyword rules";
  async decide(text: string, game: Game): Promise<Decision> {
    const t0 = performance.now();
    const command = ruleParse(text, {
      padNames: game.map.pads.map((p) => p.name),
      hasTower: (n) => !!game.towerAt(n),
      best: (hint) => game.bestCandidate(hint)?.command ?? null,
      padOfTower: (id) => game.towerById(id)?.pad,
    });
    return { command, confidence: command ? 1 : 0, trace: "keyword match", ms: performance.now() - t0 };
  }
}
