import { Option } from "./context";
import { PAD_NAMES } from "../game/map";
import { mentions } from "./fuzzy";

export type Intent = "move" | "defend" | "attack" | "hold" | "sell";

export const VERBS: Record<Intent, RegExp> = {
  move: /\b(go|goto|move|walk|head|run|retreat|return|back|fall back|come)\b/,
  defend: /\b(build|place|construct|put|create|make|add|upgrade|improve|strengthen|reinforce|defend|defense|defence|protect|cover|stronger)\b/,
  attack: /\b(attack|kill|shoot|fight|target|focus|hit)\b/,
  hold: /\b(stop(?! (them|it|him|her|those|the))|hold|stay|wait|halt|freeze)\b/,
  sell: /\b(sell|scrap|demolish|dismantle|remove|refund|tear down|get rid of)\b/,
};

/** Words that make a request about a tower or pad, not about an enemy. */
const STRUCTURE = /\b(tower|towers|pad|slot|number)\b/;

export const normalize = (text: string) => cleanTranscript(text).toLowerCase().replace(/[^a-z\s]/g, " ");

/** Which kinds of action the player's words point at. "Destroy" means sell for a tower and attack for an enemy. */
export function intents(text: string): Intent[] {
  const s = cleanTranscript(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const found = (Object.keys(VERBS) as Intent[]).filter((k) => VERBS[k].test(s));
  if (/\bdestroy\b/.test(s)) found.push(STRUCTURE.test(s) ? "sell" : "attack");
  return [...new Set(found)];
}

export function intentOf(o: Option): Intent | null {
  if (o.value === null) return null;
  if (o.value === "auto") return "defend";
  const k = o.value.kind;
  return k === "build" || k === "upgrade" ? "defend" : k;
}

export interface Goal { area?: string; near?: "base" | "spawn"; pressure?: boolean }

/** Where on the map the player wants something, as keywords: an area, a spot along the path, or where enemies are. */
export function goalOf(text: string): Goal {
  const s = normalize(text);
  const area = s.match(/\b(left|right|top|bottom|middle|center|centre)\b/)?.[1];
  return {
    area: area === "centre" ? "center" : area,
    near: /\b(spawn|entrance|early|start)\b/.test(s) ? "spawn" : /\b(base|home|last line)\b/.test(s) ? "base" : undefined,
    pressure: /\b(pressure|under attack|where (they|the enemies|enemies) (are|come))\b/.test(s),
  };
}

const BUILD = /\b(build|place|construct|put|create)\b/;
const UPGRADE = /\b(upgrade|improve|strengthen|reinforce|stronger)\b/;
export const MAX_OPTIONS = 24;

const padOf = (o: Option) => (o.value && o.value !== "auto" && "pad" in o.value ? o.value.pad : o.value && o.value !== "auto" && o.value.kind === "move" && o.value.to.type === "pad" ? o.value.to.name : null);

/**
 * Keyword guard in front of the model, three steps:
 * 1. When the words clearly signal one kind of action only that kind is offered, without "none":
 *    "go to Charlie" can never become "build at Charlie". Mixed or no verbs leave every kind in play.
 * 2. When a pad is named or numbered, options about other pads are dropped.
 * 3. When the player says build (or upgrade) but not both, the other kind is dropped, as long as something is left.
 * The list is finally capped at Tev1's 24 letters.
 */
export function gateOptions(options: Option[], text: string): Option[] {
  const clean = cleanTranscript(text).toLowerCase();
  let out = options;

  const found = intents(text);
  if (found.length === 1) out = out.filter((o) => intentOf(o) === found[0]);

  const words = clean.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const slot = slotNumber(text);
  const padNames = [...new Set(out.map(padOf).filter((n): n is string => !!n))];
  const named = padNames.filter((n) => mentions(words, n));
  const numbered = slot === null ? null : PAD_NAMES[slot - 1];
  const focus = new Set([...named, ...(numbered && padNames.includes(numbered) ? [numbered] : [])]);
  if (focus.size) {
    out = out.filter((o) => {
      const v = o.value && o.value !== "auto" ? o.value : null;
      if (v?.kind === "move" && v.to.type !== "pad") return false;
      const p = padOf(o);
      return p === null || focus.has(p);
    });
  } else {
    const goal = goalOf(text);
    const where = (o: Option) => o.text.slice(o.text.indexOf("(") + 1);
    const structural = (o: Option) => { const v = o.value && o.value !== "auto" ? o.value : null; return v?.kind === "build" || v?.kind === "upgrade" || v?.kind === "sell"; };
    const keep = (test: (o: Option) => boolean) => {
      const narrowed = out.filter((o) => !structural(o) || test(o));
      if (narrowed.some(structural)) out = narrowed;
    };
    if (goal.area && found.includes("defend") || goal.area && !found.length) keep((o) => where(o).includes(goal.area!));
    if (goal.near && found.includes("defend")) keep((o) => where(o).includes(`near the ${goal.near}`));
    if (goal.pressure) keep((o) => where(o).includes("enemies in range now"));
  }

  const kinds = (k: string) => out.filter((o) => o.value && o.value !== "auto" && o.value.kind === k);
  const s = clean.replace(/[^a-z\s]/g, " ");
  if (BUILD.test(s) && !UPGRADE.test(s) && kinds("build").length) out = out.filter((o) => !(o.value && o.value !== "auto" && o.value.kind === "upgrade"));
  else if (UPGRADE.test(s) && !BUILD.test(s) && kinds("upgrade").length) out = out.filter((o) => !(o.value && o.value !== "auto" && o.value.kind === "build"));

  return cap(out.length ? out : options);
}

/** Tev1 labels options A to X. Past that, drop the least likely first: sells, then walking to pads. */
export function cap(options: Option[], max = MAX_OPTIONS): Option[] {
  const out = [...options];
  const drop = (pred: (o: Option) => boolean) => {
    for (let i = out.length - 1; i >= 0 && out.length > max; i--) if (pred(out[i])) out.splice(i, 1);
  };
  const kind = (o: Option) => (o.value && o.value !== "auto" ? o.value : null);
  drop((o) => kind(o)?.kind === "sell");
  drop((o) => { const v = kind(o); return v?.kind === "move" && v.to.type === "pad"; });
  return out.slice(0, max);
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const SOUNDS_LIKE: Record<string, number> = { won: 1, to: 2, too: 2, for: 4, fore: 4, ate: 8 };
const NOUN = "(?:tower|pad|slot|number|no)";

/**
 * "tower two", "pad 2", "number #2" and a trailing "tower to" all become "tower 2" (a pad slot number).
 * Sound-alikes such as to/for are only trusted as the last word, so "a tower to the left" stays intact.
 */
export function spokenNumbers(text: string): string {
  return text
    .replace(new RegExp(`\\b${NOUN}\\.?\\s*#?\\s*(\\d+|${Object.keys(WORDS).join("|")})\\b`, "gi"), (_, n: string) => `tower ${WORDS[n.toLowerCase()] ?? n}`)
    .replace(new RegExp(`\\b${NOUN}\\.?\\s+(${Object.keys(SOUNDS_LIKE).join("|")})\\s*[.!?]?\\s*$`, "i"), (_, n: string) => `tower ${SOUNDS_LIKE[n.toLowerCase()]}`);
}

/** Fixes what speech recognition tends to get wrong here, then normalises spoken numbers. */
export function cleanTranscript(text: string): string {
  return spokenNumbers(text.replace(/\b(cell|sale|sail|sel)\b(?=\s+(?:the\s+)?(?:tower|pad|slot|number|no\b|\d|one|two|three|four|five|six|seven|eight|nine|ten|alpha|alfa|bravo|charlie|charley|delta|echo|foxtrot|golf))/gi, "sell"));
}

export const slotNumber = (text: string): number | null => {
  const m = cleanTranscript(text).match(/\btower (\d+)\b/i);
  return m ? Number(m[1]) : null;
};
