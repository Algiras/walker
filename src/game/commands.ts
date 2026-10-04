export type Place =
  | { type: "pad"; name: string }
  | { type: "base" }
  | { type: "spawn" }
  /** Only the on-screen controls can point at an arbitrary spot. */
  | { type: "point"; x: number; y: number };
/** number: the enemy labelled n on the map. rank: the nth enemy from the front of the line. */
export type FocusMode = "nearest" | "strongest" | "weakest" | "first" | "last" | "number" | "rank";
export type Dir = "left" | "right" | "up" | "down";

export type Command =
  | { kind: "move"; to: Place }
  | { kind: "nudge"; dir: Dir }
  | { kind: "patrol" }
  | { kind: "attack"; mode: FocusMode; n?: number }
  | { kind: "build"; pad: string }
  | { kind: "upgrade"; pad: string }
  | { kind: "sell"; pad: string }
  | { kind: "hold" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "speed"; fast: boolean }
  | { kind: "nextwave" }
  | { kind: "undo" }
  | { kind: "repeat" };

/** Commands that act on the game or on earlier commands, not on the hero. They are never "repeated" or undone. */
export const META: Command["kind"][] = ["pause", "resume", "speed", "nextwave", "undo", "repeat"];

export const placeLabel = (p: Place) => (p.type === "pad" ? p.name : p.type === "point" ? "that spot" : p.type);

export function describeCommand(c: Command): string {
  switch (c.kind) {
    case "move": return `move to ${placeLabel(c.to)}`;
    case "nudge": return `move ${c.dir}`;
    case "patrol": return "patrol the path";
    case "attack":
      if (c.mode === "number") return `attack enemy ${c.n}`;
      if (c.mode === "rank") return `attack the ${ordinal(c.n!)} enemy`;
      return `attack ${c.mode} enemy`;
    case "build": return `build tower at ${c.pad}`;
    case "upgrade": return `upgrade tower at ${c.pad}`;
    case "sell": return `sell (remove) tower at ${c.pad}`;
    case "hold": return "hold position";
    case "pause": return "pause the game";
    case "resume": return "resume the game";
    case "speed": return c.fast ? "speed up" : "normal speed";
    case "nextwave": return "call the next wave";
    case "undo": return "undo the last action";
    case "repeat": return "repeat the last command";
  }
}

const ORDINALS = ["zeroth", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
export const ordinal = (n: number) => ORDINALS[n] ?? `${n}th`;
