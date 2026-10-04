import { Command } from "../../src/game/commands";
import { generateMap } from "../../src/game/map";
import { Game } from "../../src/game/sim";
import { examplesFor, Expect, plain } from "../../src/voice/examples";

/** A named, reproducible game state the spoken commands are judged against. */
export interface Scenario {
  seed: number;
  /** Towers placed before the clock starts, by pad index. */
  towers: { pad: number; level: number }[];
  gold: number;
  /** Seconds simulated first, so enemies are on the field. */
  warmup: number;
}

/** Where the hero stands: away from every pad, the base and the spawn, so no transition is pruned by position. */
const CENTER = { x: 9, y: 5.5 };

export const SCENARIOS = {
  /** Seed 7, one tower on the second pad, a wave walking in. The state the Try-saying examples are written for. */
  midgame: { seed: 7, towers: [{ pad: 1, level: 1 }], gold: 100, warmup: 9 },
  /** Seed 21, nothing built yet, nothing on the field. */
  opening: { seed: 21, towers: [], gold: 100, warmup: 0 },
  /** Seed 21, three towers up and gold to spare. */
  fortified: { seed: 21, towers: [{ pad: 0, level: 1 }, { pad: 2, level: 2 }, { pad: 4, level: 1 }], gold: 200, warmup: 8 },
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;

export function buildState(s: Scenario): Game {
  const g = new Game(generateMap(s.seed));
  for (const t of s.towers) {
    g.addTower(g.map.pads[t.pad].name, t.level);
  }
  g.gold = s.gold;
  for (let i = 0; i < Math.round(s.warmup * 30); i++) g.step(1 / 30);
  g.gold = s.gold;
  g.hero.order = { type: "idle" };
  g.hero.pos = { ...CENTER };
  return g;
}

export interface Case { scenario: ScenarioName; text: string; expect: Expect }

const exact = (command: Command): Expect => ({ kind: "exact", command });
const padOf = (name: ScenarioName, i: number) => buildState(SCENARIOS[name]).map.pads[i].name;

export const CASES: Case[] = [
  ...examplesFor(buildState(SCENARIOS.midgame)).map((e): Case => ({ scenario: "midgame", text: plain(e.text), expect: e.expect })),
  { scenario: "opening", text: `build a tower at ${padOf("opening", 3)}`, expect: exact({ kind: "build", pad: padOf("opening", 3) }) },
  { scenario: "opening", text: "we need more defense", expect: { kind: "defend" } },
  { scenario: "opening", text: "go to the spawn", expect: exact({ kind: "move", to: { type: "spawn" } }) },
  { scenario: "fortified", text: `upgrade ${padOf("fortified", 2)}`, expect: exact({ kind: "upgrade", pad: padOf("fortified", 2) }) },
  { scenario: "fortified", text: "make the towers stronger", expect: { kind: "defend" } },
  { scenario: "fortified", text: "defend the base", expect: { kind: "defend", pick: "base" } },
  { scenario: "fortified", text: "attack the weakest enemy", expect: exact({ kind: "attack", mode: "weakest" }) },
];

export const VOICES = ["af_heart", "am_michael"] as const;
export const fixtureName = (text: string, voice: string) => `${text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.${voice}.wav`;

export function satisfies(g: Game, c: Command | null, e: Expect): string | null {
  if (!c) return "no command";
  if (e.kind === "exact") return JSON.stringify(c) === JSON.stringify(e.command) ? null : `expected ${JSON.stringify(e.command)}, got ${JSON.stringify(c)}`;
  if (c.kind !== "build" && c.kind !== "upgrade") return `expected build/upgrade, got ${c.kind}`;
  if (!e.pick) return null;
  const stats = g.padStats();
  const chosen = stats.find((s) => s.name === c.pad)!;
  const top = (f: (s: (typeof stats)[number]) => number, n = 3) => [...stats].sort((a, b) => f(b) - f(a)).slice(0, n).map((s) => s.name);
  const ok = {
    base: () => top((s) => s.progress).includes(chosen.name),
    spawn: () => top((s) => -s.progress).includes(chosen.name),
    left: () => chosen.where.includes("left"),
    pressure: () => (stats.some((s) => s.threat > 0) ? chosen.threat > 0 || top((s) => s.threat, 2).includes(chosen.name) : true),
  }[e.pick]();
  return ok ? null : `${c.pad} (${chosen.where}, progress ${chosen.progress.toFixed(2)}, threat ${chosen.threat}) does not fit "${e.pick}"`;
}
