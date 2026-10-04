import { Game } from "../game/sim";
import { Command, FocusMode, Place } from "../game/commands";

export interface Option<T> { label: string; value: T | null }
export type Verb = "move" | "attack" | "defend" | "hold";

export const NONE = "none of these, or unclear";
export const AUTO = "choose the best spot for me (the player named no place or goal)";

export const VERBS: Option<Verb>[] = [
  { label: "move the hero to a place", value: "move" },
  { label: "attack enemies", value: "attack" },
  { label: "strengthen the defense: build a new tower or upgrade a tower", value: "defend" },
  { label: "stop and hold position", value: "hold" },
  { label: NONE, value: null },
];

export const MODES: Option<FocusMode>[] = [
  { label: "the nearest enemy to the hero (closest, nearby)", value: "nearest" },
  { label: "the strongest enemy (most health, biggest, tank)", value: "strongest" },
  { label: "the weakest enemy (least health, smallest)", value: "weakest" },
  { label: "the first enemy (furthest along the path, leading, closest to the base)", value: "first" },
  { label: NONE, value: null },
];

export function moveOptions(g: Game): Option<Place>[] {
  const pads: Option<Place>[] = g.map.pads.map((p) => ({ label: `pad ${p.name} (${p.where})`, value: { type: "pad", name: p.name } }));
  return [
    ...pads,
    { label: "the base (home, retreat)", value: { type: "base" } },
    { label: "the spawn (where enemies come from, entrance)", value: { type: "spawn" } },
    { label: NONE, value: null },
  ];
}

/** Every legal build or upgrade, plus an explicit "you choose" option that the game resolves itself. */
export function defendOptions(g: Game): Option<Command | "auto">[] {
  return [
    ...g.candidates().map((c): Option<Command> => ({ label: c.affordable ? c.label : `${c.label} [cannot afford yet]`, value: c.command })),
    { label: AUTO, value: "auto" },
    { label: NONE, value: null },
  ];
}

export const GUIDE = {
  action: [
    "Decide what the player wants the hero to do.",
    "Words like build, put, place, add, more towers, upgrade, stronger, reinforce, defend, cover, protect mean strengthen the defense.",
    "Words like go, move, walk, head to, retreat mean move.",
    "Words like attack, kill, shoot, fight mean attack.",
  ],
  defend: [
    "Pick the single best build or upgrade for what the player said.",
    "If they name a pad, pick that pad (misheard names count: Alfa is Alpha, Charley is Charlie).",
    "If they name an area (left, right, top, bottom, middle, corner), pick a pad in that area.",
    "'near the base', 'protect the base', 'last line' mean a pad that is near the base.",
    "'near the spawn', 'stop them early', 'entrance' mean a pad that is near the spawn.",
    "'where they are', 'where the enemies are', 'under pressure' mean the pad with the most enemies in range.",
    "'more damage', 'stronger', 'upgrade' prefer an upgrade; 'new tower', 'another tower' prefer a build.",
    "If the player gives no place or goal, pick the option that lets the game choose.",
  ],
  move: ["Pick the place the player wants the hero to go to. Misheard pad names count."],
  attack: ["Pick which enemy the hero should focus."],
};

export function buildCommand(verb: Verb, place?: Place, mode?: FocusMode): Command | null {
  switch (verb) {
    case "hold": return { kind: "hold" };
    case "attack": return mode ? { kind: "attack", mode } : null;
    case "move": return place ? { kind: "move", to: place } : null;
    case "defend": return null;
  }
}
