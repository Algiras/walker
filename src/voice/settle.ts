import { Command } from "../game/commands";
import { Game } from "../game/sim";
import { mismatch } from "./guard";

/** act: go ahead. confirm: probably right but not sure enough, ask first. reject: not understood or not allowed. */
export type Status = "act" | "confirm" | "reject";

export interface Decision {
  command: Command | null;
  confidence: number;
  status: Status;
  /** Why it was held back, in words for the player. */
  note?: string;
  trace: string;
  ms: number;
}

/** At or above this the hero acts. Between MIN and this it asks first. Below MIN it asks the player to repeat. */
export const ACT_CONFIDENCE = 0.7;
export const MIN_CONFIDENCE = 0.25;
/** When the keyword parser and the model independently reach the same command, that is worth more than either alone. */
export const AGREEMENT_CONFIDENCE = 0.9;

/** Applies the confidence thresholds and the build/upgrade guard to a chosen command. */
export function settle(text: string, command: Command | null, confidence: number, game: Game): Pick<Decision, "status" | "note" | "command"> {
  if (!command || confidence < MIN_CONFIDENCE) return { command: null, status: "reject", note: "I did not catch that. Say it again?" };
  const wrong = mismatch(text, command, game);
  if (wrong) return { command: null, status: "reject", note: wrong };
  if (confidence < ACT_CONFIDENCE) return { command, status: "confirm", note: `I am only ${Math.round(confidence * 100)}% sure.` };
  return { command, status: "act" };
}
