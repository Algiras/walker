import { Option } from "./context";

export type Intent = "move" | "defend" | "attack" | "hold";

export const VERBS: Record<Intent, RegExp> = {
  move: /\b(go|goto|move|walk|head|run|retreat|return|back|fall back|come)\b/,
  defend: /\b(build|place|construct|put|create|make|add|upgrade|improve|strengthen|reinforce|defend|defense|defence|protect|cover|tower|towers|stronger)\b/,
  attack: /\b(attack|kill|shoot|fight|target|focus|hit)\b/,
  hold: /\b(stop|hold|stay|wait|halt|freeze)\b/,
};

export const normalize = (text: string) => text.toLowerCase().replace(/[^a-z\s]/g, " ");

/** Which kinds of action the player's words point at. */
export function intents(text: string): Intent[] {
  const s = normalize(text);
  return (Object.keys(VERBS) as Intent[]).filter((k) => VERBS[k].test(s));
}

export function intentOf(o: Option): Intent | null {
  if (o.value === null) return null;
  if (o.value === "auto") return "defend";
  return o.value.kind === "build" || o.value.kind === "upgrade" ? "defend" : o.value.kind;
}

/**
 * Keyword guard in front of the model: when the words clearly signal one kind of action, only that kind
 * is offered, without "none": the words already settled what the player is doing, only the target is open.
 * "go to Charlie" can then never become "build at Charlie". Mixed or no verbs leave every option in play.
 */
export function gateOptions(options: Option[], text: string): Option[] {
  const found = intents(text);
  if (found.length !== 1) return options;
  return options.filter((o) => intentOf(o) === found[0]);
}
