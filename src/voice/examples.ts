import { Command } from "../game/commands";
import { Game } from "../game/sim";

export type Expect =
  | { kind: "exact"; command: Command }
  | { kind: "defend"; pick?: "base" | "spawn" | "left" | "pressure" };

export interface Example { group: string; text: string; expect: Expect }

/** Phrases the decision step is built to handle. **Bold** marks the keywords that carry the decision. */
export function examplesFor(g: Game): Example[] {
  const pads = g.map.pads;
  const a = pads[0].name;
  const b = g.towers[0]?.pad ?? pads[Math.min(1, pads.length - 1)].name;
  const c = pads[Math.min(2, pads.length - 1)].name;
  const built = !!g.towerAt(b);
  return [
    { group: "Name a pad", text: `**build** a tower at **${a}**`, expect: { kind: "exact", command: { kind: "build", pad: a } } },
    { group: "Name a pad", text: `**upgrade** **${b}**`, expect: { kind: "exact", command: { kind: built ? "upgrade" : "build", pad: b } } },
    ...(g.towers.length
      ? [
          { group: "Name a pad", text: `**upgrade** **tower ${g.towers[0].id}**`, expect: { kind: "exact", command: { kind: "upgrade", pad: g.towers[0].pad } } as Expect },
          { group: "Sell", text: `**sell** **tower ${g.towers[0].id}**`, expect: { kind: "exact", command: { kind: "sell", pad: g.towers[0].pad } } as Expect },
        ]
      : []),
    { group: "Say a goal", text: `**defend** the **base**`, expect: { kind: "defend", pick: "base" } },
    { group: "Say a goal", text: `**build** near the **spawn** to stop them early`, expect: { kind: "defend", pick: "spawn" } },
    { group: "Say a goal", text: `**protect** the **left** side with a tower`, expect: { kind: "defend", pick: "left" } },
    { group: "Say a goal", text: `**put** a tower **where the enemies are**`, expect: { kind: "defend", pick: "pressure" } },
    { group: "Let the game choose", text: `we need **more defense**`, expect: { kind: "defend" } },
    { group: "Let the game choose", text: `make the towers **stronger**`, expect: { kind: "defend" } },
    { group: "Hero", text: `**go to** **${c}**`, expect: { kind: "exact", command: { kind: "move", to: { type: "pad", name: c } } } },
    { group: "Hero", text: `**retreat** to the **base**`, expect: { kind: "exact", command: { kind: "move", to: { type: "base" } } } },
    { group: "Hero", text: `**attack** the **strongest** one`, expect: { kind: "exact", command: { kind: "attack", mode: "strongest" } } },
    { group: "Hero", text: `**attack** the **nearest** enemy`, expect: { kind: "exact", command: { kind: "attack", mode: "nearest" } } },
    { group: "Hero", text: `**stop**, hold position`, expect: { kind: "exact", command: { kind: "hold" } } },
  ];
}

export const plain = (t: string) => t.replaceAll("**", "");
