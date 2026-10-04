import { Command, FocusMode, Place } from "../game/commands";
import { Game } from "../game/sim";
import { Decider, Decision } from "./decide";

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

const has =(s: string, re: RegExp) => re.test(s);

export function ruleParse(text: string, padNames: string[]): Command | null {
  const s = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  const words = s.split(/\s+/).filter(Boolean);
  const pad = padNames.find((n) => words.some((w) => w === n.toLowerCase() || (w.length > 3 && closeEnough(w, n.toLowerCase()))));
  const place: Place | null = pad
    ? { type: "pad", name: pad }
    : has(s, /\b(base|home|retreat|fall back)\b/) ? { type: "base" }
    : has(s, /\b(spawn|entrance|start)\b/) ? { type: "spawn" } : null;

  if (has(s, /\b(upgrade|improve|strengthen|level up)\b/) && pad) return { kind: "upgrade", pad };
  if (has(s, /\b(build|place|construct|put|create|make)\b/) && pad) return { kind: "build", pad };
  if (has(s, /\b(attack|kill|shoot|fight|target|focus|hit)\b/)) {
    const mode: FocusMode = has(s, /\b(strong|strongest|big|biggest|tank|tough)\b/) ? "strongest"
      : has(s, /\b(weak|weakest|small|smallest|low)\b/) ? "weakest"
      : has(s, /\b(first|leading|front|furthest)\b/) ? "first" : "nearest";
    return { kind: "attack", mode };
  }
  if (has(s, /\b(stop|hold|stay|wait|halt|freeze)\b/)) return { kind: "hold" };
  if (has(s, /\b(go|move|walk|run|head|retreat|return|back|fall)\b/) || place) return place ? { kind: "move", to: place } : null;
  return null;
}

/** Keyword fallback: runs with no model download, and doubles as a test oracle for the LLM decider. */
export class RuleDecider implements Decider {
  readonly name = "keyword rules";
  async decide(text: string, game: Game): Promise<Decision> {
    const t0 = performance.now();
    const command = ruleParse(text, game.map.pads.map((p) => p.name));
    return { command, confidence: command ? 1 : 0, trace: "keyword match", ms: performance.now() - t0 };
  }
}
