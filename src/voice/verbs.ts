import { Option } from "./context";
import { PAD_NAMES } from "../game/map";
import { mentions } from "./fuzzy";

export type Intent = "move" | "defend" | "attack" | "hold" | "sell" | "game" | "undo" | "repeat";

export const VERBS: Record<Intent, RegExp> = {
  move: /\b(go|goto|move|walk|head|run|retreat|return|fall back|get back|come|patrol|sweep)\b/,
  defend: /\b(build|place|construct|put|create|make|add|upgrade|improve|strengthen|reinforce|defend|defense|defence|protect|cover|stronger)\b/,
  attack: /\b(attack|kill|shoot|fight|target|focus|hit)\b/,
  hold: /\b(stop(?! (them|it|him|her|those|the))|hold|stay|wait|halt|freeze)\b/,
  sell: /\b(sell|scrap|demolish|dismantle|remove|delete|refund|tear down|take down|knock down|pull down|bulldoze|get rid of)\b/,
  game: /\b(pause|resume|unpause|continue|faster|speed|slower|slow|normal speed|next wave|call the wave|send the wave|call wave)\b/,
  undo: /\b(undo|revert|rollback|roll back|take (that|it) back|cancel (that|it|the last)|never ?mind|go back on that|oops)\b/,
  repeat: /\b(again|repeat|redo|same again|one more time)\b/,
};

/** Words that make a request about a tower or pad, not about an enemy. */
const STRUCTURE = /\b(tower|towers|pad|slot|number)\b/;

export const normalize = (text: string) => cleanTranscript(text).toLowerCase().replace(/[^a-z\s]/g, " ");

/** Which kinds of action the player's words point at. "Destroy" means sell for a tower and attack for an enemy. */
export function intents(text: string): Intent[] {
  const s = cleanTranscript(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const found = (Object.keys(VERBS) as Intent[]).filter((k) => VERBS[k].test(s));
  if (/\bdestroy\b/.test(s)) {
    const words = s.split(/\s+/).filter(Boolean);
    found.push(STRUCTURE.test(s) || slotNumber(text) !== null || PAD_NAMES.some((n) => mentions(words, n)) ? "sell" : "attack");
  }
  if (/\benemy \d+\b/.test(s) || ordinalOf(text) !== null) found.push("attack");
  return [...new Set(found)];
}

export function intentOf(o: Option): Intent | null {
  if (o.value === null) return null;
  if (o.value === "auto") return "defend";
  const k = o.value.kind;
  if (k === "build" || k === "upgrade") return "defend";
  if (k === "nudge" || k === "patrol") return "move";
  if (k === "pause" || k === "resume" || k === "speed" || k === "nextwave") return "game";
  return k;
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

/** Commands with an unmistakable keyword: when it is said, the model only has to confirm that one option. */
function narrowByKeyword(options: Option[], s: string, found: Intent[]): Option[] {
  const kind = (o: Option) => (o.value && o.value !== "auto" ? o.value : null);
  const only = (pred: (o: Option) => boolean) => {
    const hit = options.filter(pred);
    return hit.length ? hit : options;
  };
  if (/\bpatrol\b/.test(s)) return only((o) => kind(o)?.kind === "patrol");
  if (found.includes("attack")) {
    if (/\benemy \d+\b/.test(s)) return only((o) => kind(o)?.kind === "attack" && (kind(o) as { mode: string }).mode === "number");
    if (ordinalOf(s) !== null) return only((o) => kind(o)?.kind === "attack" && (kind(o) as { mode: string }).mode === "rank");
    if (/\blast\b/.test(s)) return only((o) => kind(o)?.kind === "attack" && (kind(o) as { mode: string }).mode === "last");
    if (/\bfirst\b/.test(s)) return only((o) => kind(o)?.kind === "attack" && (kind(o) as { mode: string }).mode === "first");
  }
  if (!found.includes("game")) return options;
  if (/\b(next wave|call (the )?wave|send (the )?wave)\b/.test(s)) return only((o) => kind(o)?.kind === "nextwave");
  if (/\bpause\b/.test(s)) return only((o) => kind(o)?.kind === "pause");
  if (/\b(resume|unpause|continue)\b/.test(s)) return only((o) => kind(o)?.kind === "resume");
  if (/\b(slower|slow|normal speed)\b/.test(s)) return only((o) => { const v = kind(o); return v?.kind === "speed" && !v.fast; });
  if (/\b(faster|speed)\b/.test(s)) return only((o) => { const v = kind(o); return v?.kind === "speed" && v.fast; });
  return options;
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
  if (found.length === 1) {
    out = out.filter((o) => intentOf(o) === found[0]);
    if (!out.length) return [];
  }

  out = narrowByKeyword(out, clean.replace(/[^a-z0-9\s]/g, " "), found);

  const words = clean.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const slot = slotNumber(text);
  const named = PAD_NAMES.filter((n) => mentions(words, n));
  const numbered = slot === null ? null : PAD_NAMES[slot - 1];
  const focus = new Set([...named, ...(numbered ? [numbered] : [])]);
  if (focus.size) {
    out = out.filter((o) => {
      const v = o.value && o.value !== "auto" ? o.value : null;
      if (v?.kind === "move" && v.to.type !== "pad") return false;
      if (v?.kind === "nudge" || v?.kind === "patrol") return false;
      const p = padOf(o);
      return p === null || focus.has(p);
    });
    if (!out.length) return [];
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

  const dir = clean.match(/\b(left|right|up|down|north|south|east|west)\b/)?.[1];
  if (dir && found.includes("move") && !focus.size && !/\b(to|pad|tower|base|spawn)\b/.test(clean)) {
    const want = ({ north: "up", south: "down", east: "right", west: "left" } as Record<string, string>)[dir] ?? dir;
    const nudges = out.filter((o) => o.value && o.value !== "auto" && o.value.kind === "nudge" && o.value.dir === want);
    if (nudges.length) out = nudges;
  }

  const kinds = (k: string) => out.filter((o) => o.value && o.value !== "auto" && o.value.kind === k);
  const s = clean.replace(/[^a-z\s]/g, " ");
  if (BUILD.test(s) && !UPGRADE.test(s) && kinds("build").length) out = out.filter((o) => !(o.value && o.value !== "auto" && o.value.kind === "upgrade"));
  else if (UPGRADE.test(s) && !BUILD.test(s) && kinds("upgrade").length) out = out.filter((o) => !(o.value && o.value !== "auto" && o.value.kind === "build"));

  return cap(out);
}

/** Tev1 labels options A to X. Past that, drop the least likely first: sells, then walking to pads. */
export function cap(options: Option[], max = MAX_OPTIONS): Option[] {
  const out = [...options];
  const kind = (o: Option) => (o.value && o.value !== "auto" ? o.value : null);
  const drop = (pred: (o: Option) => boolean) => {
    for (let i = out.length - 1; i >= 0 && out.length > max; i--) if (pred(out[i])) out.splice(i, 1);
  };
  drop((o) => kind(o)?.kind === "sell");
  drop((o) => kind(o)?.kind === "nudge");
  drop((o) => { const v = kind(o); return v?.kind === "move" && v.to.type === "pad"; });
  drop((o) => kind(o)?.kind === "speed");
  drop((o) => kind(o)?.kind === "patrol");
  const none = out.find((o) => o.value === null);
  const kept = out.filter((o) => o.value !== null).slice(0, max - (none ? 1 : 0));
  return none ? [...kept, none] : kept;
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const SOUNDS_LIKE: Record<string, number> = { won: 1, to: 2, too: 2, for: 4, fore: 4, ate: 8 };
const NOUN = "(?:tower|pad|slot|number|no)";

const COUNT = Object.keys(WORDS).join("|");

/**
 * "tower two", "pad 2" and "number #2" become "tower 2" (a pad slot number); "enemy three" and, when the
 * sentence is about attacking, "number 3" become "enemy 3". Sound-alikes such as to/for are only trusted as the
 * last word after a tower or pad, so "a tower to the left" stays intact.
 */
export function spokenNumbers(text: string): string {
  const aboutEnemies = /\b(attack|kill|shoot|target|fight|focus|hit)\b/i.test(text) && !/\b(tower|pad|slot)\b/i.test(text);
  let t = text.replace(new RegExp(`\\b(?:enemy|enemies|monster|creep)\\.?\\s*#?\\s*(\\d+|${COUNT})\\b`, "gi"), (_, n: string) => `enemy ${WORDS[n.toLowerCase()] ?? n}`);
  if (aboutEnemies) t = t.replace(new RegExp(`\\b(?:number|no)\\.?\\s*#?\\s*(\\d+|${COUNT})\\b`, "gi"), (_, n: string) => `enemy ${WORDS[n.toLowerCase()] ?? n}`);
  return t
    .replace(new RegExp(`\\b${NOUN}\\.?\\s*#?\\s*(\\d+|${COUNT})\\b`, "gi"), (_, n: string) => `tower ${WORDS[n.toLowerCase()] ?? n}`)
    .replace(new RegExp(`\\b${NOUN}\\.?\\s+(${Object.keys(SOUNDS_LIKE).join("|")})\\s*[.!?]?\\s*$`, "i"), (_, n: string) => `tower ${SOUNDS_LIKE[n.toLowerCase()]}`);
}

const RANKS: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5, "6th": 6, "7th": 7, "8th": 8, "9th": 9, "10th": 10 };

/** The enemy label the player named, as in "attack enemy 3". */
export const enemyNumber = (text: string): number | null => {
  const m = cleanTranscript(text).match(/\benemy (\d+)\b/i);
  return m ? Number(m[1]) : null;
};

/** "the second one", "third enemy": a place in the line from the front. First and last are modes of their own. */
export const ordinalOf = (text: string): number | null => {
  const m = text.toLowerCase().match(new RegExp(`\\b(${Object.keys(RANKS).join("|")})\\s+(?:one|enemy|enemies|guy|monster|creep|unit)\\b`));
  return m ? RANKS[m[1]] : null;
};

/** Fixes what speech recognition tends to get wrong here, then normalises spoken numbers. */
export function cleanTranscript(text: string): string {
  return spokenNumbers(text.replace(/\b(cell|sale|sail|sel)\b(?=\s+(?:the\s+)?(?:tower|pad|slot|number|no\b|\d|one|two|three|four|five|six|seven|eight|nine|ten|alpha|alfa|bravo|charlie|charley|delta|echo|foxtrot|golf))/gi, "sell"));
}

const JOINERS = /\s*(?:[,;]|(?<=[.!?])\s|\band then\b|\bthen\b|\bafter that\b|\bafterwards\b|\band also\b|\balso\b|\band\b)\s*/i;
export const MAX_CLAUSES = 4;

/**
 * Splits "go to Charlie and then build at Alpha" into separate commands. A piece without a verb of its own
 * ("build at Alpha and Bravo") is kept with the clause before it, so lists are not torn apart.
 */
export function splitCommands(text: string): string[] {
  const parts = text.split(JOINERS).map((p) => p.trim().replace(/[.!?]+$/, "")).filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    if (out.length && intents(part).length === 0) out[out.length - 1] += ` and ${part}`;
    else out.push(part);
  }
  if (out.length > MAX_CLAUSES) return [...out.slice(0, MAX_CLAUSES - 1), out.slice(MAX_CLAUSES - 1).join(" and ")];
  return out.length ? out : [text.trim()];
}

/** Does the transcript contain anything the game could act on: a verb, a pad, a number, a place or a game word? */
export function hasEvidence(text: string): boolean {
  const s = cleanTranscript(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const words = s.split(/\s+/).filter(Boolean);
  const g = goalOf(text);
  return (
    intents(text).length > 0 ||
    slotNumber(text) !== null ||
    PAD_NAMES.some((n) => mentions(words, n)) ||
    !!(g.area || g.near || g.pressure) ||
    /\b(towers?|enem(y|ies)|waves?|hero|base|spawn|gold|upgrade|path)\b/.test(s)
  );
}

export const slotNumber = (text: string): number | null => {
  const m = cleanTranscript(text).match(/\btower (\d+)\b/i);
  return m ? Number(m[1]) : null;
};
