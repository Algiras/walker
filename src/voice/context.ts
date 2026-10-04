import { Game } from "../game/sim";
import { Command, FocusMode, Place } from "../game/commands";

export interface Option<T> { label: string; value: T | null }

export const VERBS: Option<"move" | "attack" | "build" | "upgrade" | "hold">[] = [
  { label: "move the hero to a place", value: "move" },
  { label: "attack enemies", value: "attack" },
  { label: "build a tower on a pad", value: "build" },
  { label: "upgrade an existing tower", value: "upgrade" },
  { label: "stop and hold position", value: "hold" },
  { label: "none of these, or unclear", value: null },
];

export const MODES: Option<FocusMode>[] = [
  { label: "the nearest enemy to the hero (closest, nearby)", value: "nearest" },
  { label: "the strongest enemy (most health, biggest, tank)", value: "strongest" },
  { label: "the weakest enemy (least health, smallest)", value: "weakest" },
  { label: "the first enemy (furthest along the path, leading, closest to the base)", value: "first" },
  { label: "none of these, or unclear", value: null },
];

export function placeOptions(g: Game, kind: "move" | "build" | "upgrade"): Option<Place>[] {
  const pads: Option<Place>[] = g.map.pads.map((p) => {
    const t = g.towerAt(p.name);
    const note = kind === "move" ? "" : t ? `, has a level ${t.level} tower` : ", empty";
    return { label: `pad ${p.name} (${p.where}${note})`, value: { type: "pad", name: p.name } };
  });
  const extra: Option<Place>[] =
    kind === "move"
      ? [
          { label: "the base (home, retreat)", value: { type: "base" } },
          { label: "the spawn (where enemies come from, entrance)", value: { type: "spawn" } },
        ]
      : [];
  return [...pads, ...extra, { label: "none of these, or unclear", value: null }];
}

export function buildCommand(verb: string, place?: Place, mode?: FocusMode): Command | null {
  switch (verb) {
    case "hold": return { kind: "hold" };
    case "attack": return mode ? { kind: "attack", mode } : null;
    case "move": return place ? { kind: "move", to: place } : null;
    case "build": return place?.type === "pad" ? { kind: "build", pad: place.name } : null;
    case "upgrade": return place?.type === "pad" ? { kind: "upgrade", pad: place.name } : null;
  }
  return null;
}
