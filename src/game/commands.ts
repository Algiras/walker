export type Place = { type: "pad"; name: string } | { type: "base" } | { type: "spawn" };
export type FocusMode = "nearest" | "strongest" | "weakest" | "first";

export type Command =
  | { kind: "move"; to: Place }
  | { kind: "attack"; mode: FocusMode }
  | { kind: "build"; pad: string }
  | { kind: "upgrade"; pad: string }
  | { kind: "hold" };

export const placeLabel = (p: Place) => (p.type === "pad" ? p.name : p.type);

export function describeCommand(c: Command): string {
  switch (c.kind) {
    case "move": return `move to ${placeLabel(c.to)}`;
    case "attack": return `attack ${c.mode} enemy`;
    case "build": return `build tower at ${c.pad}`;
    case "upgrade": return `upgrade tower at ${c.pad}`;
    case "hold": return "hold position";
  }
}
