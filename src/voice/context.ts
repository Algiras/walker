import { describeCommand } from "../game/commands";
import { Game } from "../game/sim";
import { Command } from "../game/commands";

export type Action = Command | "auto";
export interface Option { key: string; text: string; value: Action | null }


export const NONE = "none of these, or unclear";
export const AUTO = "strengthen the defense wherever it is needed most (the player named no place)";

/**
 * The legal transitions out of the current game state, one per letter. Impossible ones are left out:
 * no attacking an empty field and no walking to where the hero already stands.
 */
export function actionOptions(g: Game): Option[] {
  const out: Option[] = [];
  const at = (x: number, y: number) => Math.hypot(g.hero.pos.x - x, g.hero.pos.y - y) < 0.3;

  for (const c of g.candidates()) {
    const note = c.affordable || c.command.kind === "sell" ? "" : c.label.includes("maximum level") ? "" : " [cannot afford yet]";
    out.push({ key: `${c.command.kind}_${(c.command as { pad: string }).pad.toLowerCase()}`, text: c.label + note, value: c.command });
  }
  out.push({ key: "defend_auto", text: AUTO, value: "auto" });

  if (g.enemies.length) {
    out.push({ key: "attack_nearest", text: "attack the nearest enemy (closest)", value: { kind: "attack", mode: "nearest" } });
    out.push({ key: "attack_strongest", text: "attack the strongest enemy (most health, biggest)", value: { kind: "attack", mode: "strongest" } });
    out.push({ key: "attack_weakest", text: "attack the weakest enemy (least health)", value: { kind: "attack", mode: "weakest" } });
    out.push({ key: "attack_first", text: "attack the first enemy (furthest along, nearest the base)", value: { kind: "attack", mode: "first" } });
  }

  for (const p of g.map.pads) {
    if (!at(p.pos.x, p.pos.y)) out.push({ key: `move_${p.name.toLowerCase()}`, text: `go to pad ${p.number} ${p.name} (${p.where}), just walk there`, value: { kind: "move", to: { type: "pad", name: p.name } } });
  }
  if (!at(g.map.base.x, g.map.base.y)) out.push({ key: "move_base", text: "go to the base, just walk there (retreat, go home)", value: { kind: "move", to: { type: "base" } } });
  if (!at(g.map.spawn.x, g.map.spawn.y)) out.push({ key: "move_spawn", text: "go to the spawn, just walk there (where enemies come from)", value: { kind: "move", to: { type: "spawn" } } });

  for (const dir of ["left", "right", "up", "down"] as const) {
    out.push({ key: `nudge_${dir}`, text: `walk the hero a few tiles ${dir}`, value: { kind: "nudge", dir } });
  }
  out.push({ key: "patrol", text: "patrol the path, walking back and forth from the spawn to the base", value: { kind: "patrol" } });

  out.push({ key: "hold", text: "stop and hold position, cancel the current order", value: { kind: "hold" } });
  out.push({ key: "undo", text: "undo or revert the last action", value: { kind: "undo" } });
  out.push({ key: "repeat", text: `do the last command again${g.last ? ` (${describeCommand(g.last)})` : ""}`, value: { kind: "repeat" } });
  out.push({ key: "pause", text: "pause the game", value: { kind: "pause" } });
  out.push({ key: "resume", text: "resume the paused game", value: { kind: "resume" } });
  out.push({ key: "speed_up", text: "speed the game up, double speed", value: { kind: "speed", fast: true } });
  out.push({ key: "speed_down", text: "slow the game back to normal speed", value: { kind: "speed", fast: false } });
  out.push({ key: "nextwave", text: "call the next wave early for bonus gold", value: { kind: "nextwave" } });
  out.push({ key: "none", text: NONE, value: null });
  return out;
}
