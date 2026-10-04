export type Place =
  | { type: "pad"; name: string }
  | { type: "base" }
  | { type: "spawn" }
  /** Only the on-screen controls can point at an arbitrary spot. */
  | { type: "point"; x: number; y: number };
export type FocusMode = "nearest" | "strongest" | "weakest" | "first";
export type Dir = "left" | "right" | "up" | "down";

export type Command =
  | { kind: "move"; to: Place }
  | { kind: "nudge"; dir: Dir }
  | { kind: "patrol" }
  | { kind: "attack"; mode: FocusMode }
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
    case "attack": return `attack ${c.mode} enemy`;
    case "build": return `build tower at ${c.pad}`;
    case "upgrade": return `upgrade tower at ${c.pad}`;
    case "sell": return `sell tower at ${c.pad}`;
    case "hold": return "hold position";
    case "pause": return "pause the game";
    case "resume": return "resume the game";
    case "speed": return c.fast ? "speed up" : "normal speed";
    case "nextwave": return "call the next wave";
    case "undo": return "undo the last action";
    case "repeat": return "repeat the last command";
  }
}
