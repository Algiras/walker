import { Command, ordinal } from "../game/commands";
import { PAD_NAMES } from "../game/map";
import { Game, GameEvent } from "../game/sim";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty"];
export const MAX_SPOKEN_NUMBER = 40;

/** A number as words, or null past what has been recorded. */
export function word(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > MAX_SPOKEN_NUMBER) return null;
  if (n < 20) return ONES[n];
  return n % 10 ? `${TENS[Math.floor(n / 10)]} ${ONES[n % 10]}` : TENS[n / 10];
}

const numbered = (n: number, fallback: string, make: (w: string) => string) => {
  const w = word(n);
  return w ? make(w) : fallback;
};

/** What the hero says when it takes an order: short and military. Null when there is nothing worth saying. */
export function calloutFor(c: Command, g: Game): string | null {
  const towerNo = (pad: string) => g.towerAt(pad)?.id ?? g.padByName(pad)?.number ?? 0;
  switch (c.kind) {
    case "build": return `Building at ${c.pad}.`;
    case "upgrade": return numbered(towerNo(c.pad), "Upgrading.", (w) => `Upgrading tower ${w}.`);
    case "sell": return numbered(towerNo(c.pad), "Selling.", (w) => `Selling tower ${w}.`);
    case "move":
      if (c.to.type === "pad") return `Moving to ${c.to.name}.`;
      if (c.to.type === "base") return "Falling back.";
      if (c.to.type === "spawn") return "Moving to the spawn.";
      return "Moving out.";
    case "nudge": return `Moving ${c.dir}.`;
    case "patrol": return "Patrolling.";
    case "attack":
      if (c.mode === "number") return numbered(c.n!, "Engaging the target.", (w) => `Engaging target ${w}.`);
      if (c.mode === "rank") return `Engaging the ${ordinal(c.n!)} target.`;
      return { first: "Engaging the lead target.", last: "Engaging the rear target.", strongest: "Engaging the heavy.", weakest: "Engaging the weakest.", nearest: "Engaging the nearest." }[c.mode] ?? null;
    case "hold": return "Holding position.";
    case "pause": return "Standing by.";
    case "resume": return "Resuming.";
    case "speed": return c.fast ? "Double time." : "Normal speed.";
    case "nextwave": return "Calling the next wave.";
    case "undo": return "Reverting.";
    case "repeat": return g.last ? calloutFor(g.last, g) : null;
  }
}

/** A refusal in the same voice. */
export function refusalCallout(message: string): string {
  if (/not enough gold/i.test(message)) return "Insufficient funds.";
  if (/already has a tower/i.test(message)) return "Negative. Pad occupied.";
  if (/maximum level/i.test(message)) return "Negative. Maximum level.";
  if (/no tower/i.test(message)) return "Negative. No tower there.";
  if (/no enem|only \d+ enemies/i.test(message)) return "Negative. No such target.";
  if (/nothing to undo|nothing to repeat/i.test(message)) return "Nothing to revert.";
  if (/still arriving/i.test(message)) return "Wave in progress.";
  if (/did not catch|say it again/i.test(message)) return "Say again?";
  return "Negative.";
}

export const CONFIRM = "Confirm?";

/** The line for something that happened in the game. */
export function eventLine(e: GameEvent): string {
  switch (e.kind) {
    case "wave": return numbered(e.n, "Wave incoming.", (w) => `Wave ${w} incoming.`);
    case "baseHit": return "Base under attack.";
    case "built": return "Construction complete.";
    case "upgraded": return "Upgrade complete.";
    case "sold": return "Tower sold.";
    case "lost": return "Base destroyed.";
  }
}

/** Lines worth loading up front: the fixed ones plus what this map's pads and a first few waves can produce. */
export function warmLines(g: Game): string[] {
  const out = new Set<string>(STATIC_LINES);
  for (const p of g.map.pads) {
    out.add(`Building at ${p.name}.`);
    out.add(`Moving to ${p.name}.`);
    out.add(`Upgrading tower ${word(p.number)}.`);
    out.add(`Selling tower ${word(p.number)}.`);
  }
  for (let n = 1; n <= 12; n++) out.add(`Engaging target ${word(n)}.`);
  for (let n = 2; n <= 6; n++) out.add(`Engaging the ${ordinal(n)} target.`);
  for (let n = 1; n <= 5; n++) out.add(`Wave ${word(n)} incoming.`);
  return [...out];
}

/** Everything the hero can ever say. These are the lines that get recorded, and the test checks nothing else is produced. */
const STATIC_LINES = [
    "Holding position.", "Standing by.", "Resuming.", "Double time.", "Normal speed.", "Patrolling.", "Moving out.", "Falling back.",
    "Moving to the spawn.", "Moving up.", "Moving down.", "Moving left.", "Moving right.", "Reverting.", "Calling the next wave.",
    "Upgrading.", "Selling.", "Engaging the target.",
    "Engaging the lead target.", "Engaging the rear target.", "Engaging the heavy.", "Engaging the weakest.", "Engaging the nearest.",
    "Insufficient funds.", "Negative.", "Negative. No tower there.", "Negative. Pad occupied.", "Negative. Maximum level.", "Negative. No such target.",
    "Nothing to revert.", "Wave in progress.", "Say again?", CONFIRM,
    "Construction complete.", "Upgrade complete.", "Tower sold.", "Base under attack.", "Base destroyed.", "Wave incoming.",
];

export function allLines(): string[] {
  const out = new Set<string>(STATIC_LINES);
  for (const pad of PAD_NAMES) {
    out.add(`Building at ${pad}.`);
    out.add(`Moving to ${pad}.`);
  }
  for (let n = 0; n <= MAX_SPOKEN_NUMBER; n++) {
    const w = word(n)!;
    out.add(`Engaging target ${w}.`);
    out.add(`Wave ${w} incoming.`);
    if (n >= 1 && n <= PAD_NAMES.length) {
      out.add(`Upgrading tower ${w}.`);
      out.add(`Selling tower ${w}.`);
    }
  }
  for (let r = 1; r <= 10; r++) out.add(`Engaging the ${ordinal(r)} target.`);
  return [...out];
}
