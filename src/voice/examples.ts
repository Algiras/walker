import { Game } from "../game/sim";

export interface Example { group: string; text: string }

/** Phrases the decision step is built to handle. **Bold** marks the keywords that carry the decision. */
export function examplesFor(g: Game): Example[] {
  const pads = g.map.pads;
  const a = pads[0].name;
  const b = pads[Math.min(1, pads.length - 1)].name;
  const c = pads[Math.min(2, pads.length - 1)].name;
  return [
    { group: "Name a pad", text: `**build** a tower at **${a}**` },
    { group: "Name a pad", text: `**upgrade** **${b}**` },
    { group: "Say a goal", text: `**defend** the **base**` },
    { group: "Say a goal", text: `**stop them early** near the **spawn**` },
    { group: "Say a goal", text: `**protect** the **left** side` },
    { group: "Say a goal", text: `put a tower **where the enemies are**` },
    { group: "Let the game choose", text: `we need **more defense**` },
    { group: "Let the game choose", text: `make the towers **stronger**` },
    { group: "Hero", text: `**go to** **${c}**` },
    { group: "Hero", text: `**retreat** to the **base**` },
    { group: "Hero", text: `**attack** the **strongest** one` },
    { group: "Hero", text: `**attack** the **nearest** enemy` },
    { group: "Hero", text: `**stop**, hold position` },
  ];
}
