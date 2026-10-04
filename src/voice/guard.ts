import { Command } from "../game/commands";
import { Game } from "../game/sim";
import { normalize } from "./verbs";

const BUILD = /\b(build|place|construct|put|create)\b/;
const UPGRADE = /\b(upgrade|improve|strengthen|reinforce|stronger)\b/;

/**
 * Catches a decision that spends the player's gold on something other than what they literally said.
 * "build at Charlie" must not quietly become an upgrade, and "upgrade Charlie" must not quietly become a build.
 */
export function mismatch(text: string, c: Command | null, g: Game): string | null {
  if (!c) return null;
  const s = normalize(text);
  if (c.kind === "upgrade" && BUILD.test(s) && !UPGRADE.test(s)) {
    return `Pad ${c.pad} already has tower ${g.towerAt(c.pad)?.id}. Say "upgrade tower ${g.towerAt(c.pad)?.id}" to upgrade it.`;
  }
  if (c.kind === "build" && UPGRADE.test(s) && !BUILD.test(s)) {
    return `There is no tower at ${c.pad} yet. Say "build at ${c.pad}" to build one.`;
  }
  return null;
}
