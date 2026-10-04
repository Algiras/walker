import { GameMap, Vec, pathLength, pointAt } from "./map";
import { Command, describeCommand, FocusMode, META, ordinal, Place } from "./commands";
import { mulberry32, Rng } from "./rng";

/** num is the label drawn on the enemy: 1, 2, 3 in spawn order within a wave. */
export interface Enemy { id: number; num: number; kind: "grunt" | "fast" | "tank"; d: number; hp: number; maxHp: number; speed: number; reward: number }
/** A tower's id is the number of the pad slot it stands on, so "tower 3" and pad 3 are the same thing. */
export interface Tower { id: number; pad: string; pos: Vec; level: number; cd: number; spent: number }
export interface Beam { from: Vec; to: Vec; ttl: number; hero: boolean }
export type Order =
  | { type: "idle" }
  | { type: "move"; to: Vec; label: string; then?: Command }
  | { type: "patrol"; leg: 0 | 1 }
  | { type: "attack"; mode: FocusMode; n?: number; target?: number };

/** How to take back one change. Pushed when it happens, popped by undo. */
type Undo =
  | { type: "order"; previous: Order; what: string }
  | { type: "build"; pad: string; cost: number }
  | { type: "upgrade"; pad: string; cost: number }
  | { type: "sell"; pad: string; level: number; spent: number; refund: number };

export const COSTS = { build: 50, upgrade: [40, 70], refund: 0.6 };
export const MAX_LEVEL = COSTS.upgrade.length + 1;

export type GameEvent = { kind: "wave"; n: number } | { kind: "baseHit" | "built" | "upgraded" | "sold" | "lost" };
export interface Outcome { ok: boolean; message: string }
export interface Assessment { verdict: "good" | "ok" | "poor"; note: string }

export interface PadStats {
  name: string;
  where: string;
  level: number;
  coverage: number;
  progress: number;
  threat: number;
}

export interface Candidate { command: Command; label: string; score: number; affordable: boolean; stats: PadStats }
export interface Hint { area?: string; near?: "base" | "spawn"; pressure?: boolean; prefer?: "build" | "upgrade" }
const HERO = { speed: 3.2, range: 2.1, damage: 9, cooldown: 0.45 };
const TOWER = { range: 2.6, damage: 5, cooldown: 0.7 };
const ARRIVE = 0.15;
const NUDGE = 3;
const HISTORY = 30;

export class Game {
  map: GameMap;
  rng: Rng;
  total: number;
  enemies: Enemy[] = [];
  towers: Tower[] = [];
  beams: Beam[] = [];
  hero = { pos: { x: 0, y: 0 } as Vec, cd: 0, shake: 0, order: { type: "idle" } as Order };
  gold = 100;
  baseHp = 20;
  wave = 0;
  time = 0;
  /** Everything the game has said, oldest first. The page shows it by index, so entries are never dropped. */
  log: string[] = [];
  state: "playing" | "lost" = "playing";
  paused = false;
  speed: 1 | 2 = 1;
  last: Command | null = null;
  private history: Undo[] = [];
  /** Called when something happens that is worth announcing: a wave arriving, a build finishing, the base being hit. */
  announce: ((e: GameEvent) => void) | null = null;
  private lastHitCall = -10;
  private nextId = 1;
  private nextNum = 1;
  private spawnQueue: { at: number; kind: Enemy["kind"] }[] = [];
  private waveTimer = 4;

  constructor(map: GameMap) {
    this.map = map;
    this.rng = mulberry32(map.seed ^ 0x9e3779b9);
    this.total = pathLength(map.path);
    this.hero.pos = { ...map.base };
  }

  enemyPos(e: Enemy): Vec { return pointAt(this.map.path, e.d); }
  addTower(pad: string, level = 1): Tower {
    const p = this.padByName(pad)!;
    const spent = COSTS.build + COSTS.upgrade.slice(0, level - 1).reduce((a, b) => a + b, 0);
    const t: Tower = { id: p.number, pad: p.name, pos: p.pos, level, cd: 0, spent };
    this.towers.push(t);
    return t;
  }
  towerById(id: number) { return this.towers.find((t) => t.id === id); }
  towerAt(pad: string) { return this.towers.find((t) => t.pad === pad); }
  upgradeCost(t: Tower): number | null { return t.level >= MAX_LEVEL ? null : COSTS.upgrade[t.level - 1]; }
  sellValue(t: Tower) { return Math.floor(t.spent * COSTS.refund); }
  padByName(name: string) { return this.map.pads.find((p) => p.name.toLowerCase() === name.toLowerCase()); }

  say(msg: string) { this.log.push(msg); }

  resolve(p: Place): { pos: Vec; label: string } | undefined {
    if (p.type === "point") return { pos: { x: p.x, y: p.y }, label: "that spot" };
    if (p.type === "base") return { pos: this.map.base, label: "base" };
    if (p.type === "spawn") return { pos: this.map.spawn, label: "spawn" };
    const pad = this.padByName(p.name);
    return pad && { pos: pad.pos, label: pad.name };
  }

  /** Checks a command against the current state without changing anything. Null means it can go ahead. */
  refusal(c: Command): string | null {
    if (this.state === "lost") return "The base has fallen.";
    switch (c.kind) {
      case "attack":
        if (!this.enemies.length) return "There are no enemies to attack.";
        if (c.mode === "number" && !this.pick("number", c.n)) return `There is no enemy ${c.n} on the field.`;
        if (c.mode === "rank" && !this.pick("rank", c.n)) return `There are only ${this.enemies.length} enemies on the field.`;
        return null;
      case "build": {
        const pad = this.padByName(c.pad);
        if (!pad) return "No such pad.";
        if (this.towerAt(pad.name)) return `Pad ${pad.number} ${pad.name} already has a tower.`;
        return this.gold < COSTS.build ? `Not enough gold: a tower costs ${COSTS.build}, you have ${this.gold}.` : null;
      }
      case "upgrade": {
        const t = this.towerAt(c.pad);
        if (!t) return `There is no tower at ${c.pad} to upgrade.`;
        const cost = this.upgradeCost(t);
        if (cost === null) return `Tower ${t.id} is already at the maximum level.`;
        return this.gold < cost ? `Not enough gold: upgrading costs ${cost}, you have ${this.gold}.` : null;
      }
      case "sell": return this.towerAt(c.pad) ? null : `There is no tower at ${c.pad} to sell.`;
      case "move": return this.resolve(c.to) ? null : "No such place.";
      case "nextwave": return this.spawnQueue.length ? "The current wave is still arriving." : null;
      case "pause": return this.paused ? "Already paused." : null;
      case "resume": return this.paused ? null : "Not paused.";
      case "undo": return this.history.length ? null : "Nothing to undo.";
      case "repeat": return this.last ? null : "There is nothing to repeat yet.";
      default: return null;
    }
  }

  private order(o: Order, what: string) {
    this.remember({ type: "order", previous: this.hero.order, what });
    this.hero.order = o;
  }

  private remember(u: Undo) {
    this.history.push(u);
    if (this.history.length > HISTORY) this.history.shift();
  }

  command(c: Command): Outcome {
    const no = this.refusal(c);
    if (no) {
      this.hero.shake = 0.6;
      return { ok: false, message: no };
    }
    const ok = (message: string): Outcome => ({ ok: true, message });
    if (!META.includes(c.kind)) this.last = c;
    switch (c.kind) {
      case "hold":
        this.order({ type: "idle" }, "hold position");
        return ok("Holding position.");
      case "attack":
        this.order({ type: "attack", mode: c.mode, n: c.n }, describeCommand(c));
        return ok(c.mode === "number" ? `Attacking enemy ${c.n}.` : c.mode === "rank" ? `Attacking the ${ordinal(c.n!)} enemy.` : `Attacking the ${c.mode} enemy.`);
      case "patrol":
        this.order({ type: "patrol", leg: 1 }, "patrol");
        return ok("Patrolling the path.");
      case "nudge": {
        const to = this.nudged(c.dir);
        this.order({ type: "move", to, label: c.dir }, `move ${c.dir}`);
        return ok(`Moving ${c.dir}.`);
      }
      case "move": {
        const t = this.resolve(c.to)!;
        this.order({ type: "move", to: t.pos, label: t.label }, `move to ${t.label}`);
        return ok(`Moving to ${t.label}.`);
      }
      case "pause":
        this.paused = true;
        return ok("Paused.");
      case "resume":
        this.paused = false;
        return ok("Resumed.");
      case "speed":
        this.speed = c.fast ? 2 : 1;
        return ok(c.fast ? "Double speed." : "Normal speed.");
      case "nextwave": {
        const bonus = Math.max(0, Math.ceil(this.waveTimer * 3));
        this.planWave();
        this.waveTimer = 6;
        this.gold += bonus;
        return ok(bonus ? `Wave ${this.wave} called early. +${bonus} gold.` : `Wave ${this.wave} called.`);
      }
      case "undo":
        return this.undo();
      case "repeat":
        return this.command(this.last!);
      default: {
        const pad = this.padByName(c.pad)!;
        this.order({ type: "move", to: pad.pos, label: pad.name, then: c }, `${c.kind} at ${pad.name}`);
        return ok(`Heading to ${pad.name} to ${c.kind}.`);
      }
    }
  }

  private nudged(dir: "left" | "right" | "up" | "down"): Vec {
    const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
    const clamp = (v: number, hi: number) => Math.min(hi - 0.5, Math.max(0.5, v));
    return { x: clamp(this.hero.pos.x + d[0] * NUDGE, this.map.w), y: clamp(this.hero.pos.y + d[1] * NUDGE, this.map.h) };
  }

  /** Takes back the most recent change: a hero order that is still running, or a completed build, upgrade or sale. */
  undo(): Outcome {
    for (let guard = 0; guard < HISTORY; guard++) {
      const u = this.history[this.history.length - 1];
      if (!u) return { ok: false, message: "Nothing to undo." };
      if (u.type === "order") {
        this.history.pop();
        this.hero.order = u.previous;
        return { ok: true, message: `Cancelled: ${u.what}.` };
      }
      const t = this.towerAt(u.pad);
      if (u.type === "sell") {
        if (this.gold < u.refund) return { ok: false, message: `Not enough gold to take the sale back: you need ${u.refund}.` };
        this.history.pop();
        this.gold -= u.refund;
        const back = this.addTower(u.pad, u.level);
        back.spent = u.spent;
        return { ok: true, message: `Tower ${back.id} at ${u.pad} is back, level ${u.level}.` };
      }
      this.history.pop();
      if (!t) continue;
      if (u.type === "build") {
        this.towers = this.towers.filter((x) => x !== t);
        this.gold += u.cost;
        return { ok: true, message: `Reverted: removed tower ${t.id} at ${u.pad}, refunded ${u.cost}.` };
      }
      t.level--;
      t.spent -= u.cost;
      this.gold += u.cost;
      return { ok: true, message: `Reverted: tower ${t.id} at ${u.pad} is back to level ${t.level}, refunded ${u.cost}.` };
    }
    return { ok: false, message: "Nothing to undo." };
  }

  private finish(c: Command) {
    const no = this.refusal(c);
    if (no) {
      this.hero.shake = 0.6;
      return this.say(no);
    }
    if (c.kind === "build") {
      this.gold -= COSTS.build;
      const t = this.addTower(c.pad);
      this.remember({ type: "build", pad: c.pad, cost: COSTS.build });
      this.say(`Built tower ${t.id} at ${c.pad}.`);
      this.announce?.({ kind: "built" });
    } else if (c.kind === "upgrade") {
      const t = this.towerAt(c.pad)!;
      const cost = this.upgradeCost(t)!;
      this.gold -= cost;
      t.spent += cost;
      t.level++;
      this.remember({ type: "upgrade", pad: c.pad, cost });
      this.say(`Upgraded tower ${t.id} at ${c.pad} to level ${t.level}.`);
      this.announce?.({ kind: "upgraded" });
    } else if (c.kind === "sell") {
      const t = this.towerAt(c.pad)!;
      const value = this.sellValue(t);
      this.gold += value;
      this.remember({ type: "sell", pad: c.pad, level: t.level, spent: t.spent, refund: value });
      this.towers = this.towers.filter((x) => x !== t);
      this.say(`Sold tower ${t.id} at ${c.pad} for ${value} gold.`);
      this.announce?.({ kind: "sold" });
    }
  }

  private planWave() {
    this.wave++;
    this.nextNum = 1 + Math.max(0, ...this.enemies.map((e) => e.num));
    const n = 4 + this.wave * 2;
    for (let i = 0; i < n; i++) {
      const roll = this.rng();
      const kind: Enemy["kind"] = this.wave >= 3 && roll < 0.2 ? "tank" : this.wave >= 2 && roll < 0.5 ? "fast" : "grunt";
      this.spawnQueue.push({ at: this.time + i * 0.9, kind });
    }
    this.say(`Wave ${this.wave} incoming.`);
    this.announce?.({ kind: "wave", n: this.wave });
  }

  private spawn(kind: Enemy["kind"]) {
    const scale = 1 + (this.wave - 1) * 0.18;
    const base = { grunt: [30, 1.0, 6], fast: [18, 1.8, 7], tank: [110, 0.6, 14] }[kind];
    const hp = Math.round(base[0] * scale);
    this.enemies.push({ id: this.nextId++, num: this.nextNum++, kind, d: 0, hp, maxHp: hp, speed: base[1], reward: base[2] });
  }

  pick(mode: FocusMode, n?: number): Enemy | undefined {
    const live = this.enemies;
    if (!live.length) return undefined;
    const by = (f: (e: Enemy) => number) => live.reduce((a, b) => (f(b) < f(a) ? b : a));
    switch (mode) {
      case "first": return by((e) => -e.d);
      case "last": return by((e) => e.d);
      case "strongest": return by((e) => -e.hp);
      case "weakest": return by((e) => e.hp);
      case "nearest": return by((e) => dist(this.hero.pos, this.enemyPos(e)));
      case "number": return live.find((e) => e.num === n);
      case "rank": return [...live].sort((a, b) => b.d - a.d)[(n ?? 1) - 1];
    }
  }

  step(dt: number) {
    this.hero.shake = Math.max(0, this.hero.shake - dt);
    if (this.state !== "playing" || this.paused) return;
    this.time += dt;

    this.waveTimer -= dt;
    if (this.spawnQueue.length === 0 && this.enemies.length === 0 && this.waveTimer <= 0) {
      this.planWave();
      this.waveTimer = 6;
    }
    while (this.spawnQueue.length && this.spawnQueue[0].at <= this.time) this.spawn(this.spawnQueue.shift()!.kind);

    for (const e of this.enemies) e.d += e.speed * dt;
    for (const e of this.enemies.filter((e) => e.d >= this.total)) {
      this.baseHp -= 1;
      e.hp = 0;
      this.say("An enemy reached the base!");
      if (this.time - this.lastHitCall > 8) {
        this.lastHitCall = this.time;
        this.announce?.({ kind: "baseHit" });
      }
    }
    this.enemies = this.enemies.filter((e) => e.hp > 0 && e.d < this.total);
    if (this.baseHp <= 0) { this.state = "lost"; this.say("The base has fallen."); this.announce?.({ kind: "lost" }); return; }

    for (const t of this.towers) {
      t.cd -= dt;
      if (t.cd > 0) continue;
      const range = TOWER.range + (t.level - 1) * 0.3;
      const target = this.enemies.filter((e) => dist(t.pos, this.enemyPos(e)) <= range).sort((a, b) => b.d - a.d)[0];
      if (target) {
        this.hit(t.pos, target, TOWER.damage * (1 + (t.level - 1) * 0.8), false);
        t.cd = TOWER.cooldown;
      }
    }

    this.stepHero(dt);
    this.beams = this.beams.filter((b) => (b.ttl -= dt) > 0);
  }

  private stepHero(dt: number) {
    const h = this.hero;
    h.cd -= dt;
    const o = h.order;
    let focus: Enemy | undefined;
    if (o.type === "attack") {
      focus = this.enemies.find((e) => e.id === o.target);
      if (!focus && (o.mode === "number" || o.mode === "rank") && o.target !== undefined) h.order = { type: "idle" };
      else if (!focus) focus = this.pick(o.mode, o.n);
      o.target = focus?.id ?? o.target;
      if (focus) {
        const p = this.enemyPos(focus);
        if (dist(h.pos, p) > HERO.range * 0.9) this.walk(p, dt);
      }
    } else if (o.type === "patrol") {
      const goal = o.leg ? this.map.base : this.map.spawn;
      if (dist(h.pos, goal) <= ARRIVE) o.leg = o.leg ? 0 : 1;
      else this.walk(goal, dt);
    } else if (o.type === "move") {
      if (dist(h.pos, o.to) <= ARRIVE) {
        h.order = { type: "idle" };
        if (o.then) this.finish(o.then);
      } else this.walk(o.to, dt);
    }
    if (h.cd <= 0) {
      const t = focus && dist(h.pos, this.enemyPos(focus)) <= HERO.range
        ? focus
        : this.enemies.filter((e) => dist(h.pos, this.enemyPos(e)) <= HERO.range).sort((a, b) => b.d - a.d)[0];
      if (t) {
        this.hit(h.pos, t, HERO.damage, true);
        h.cd = HERO.cooldown;
      }
    }
  }

  private walk(to: Vec, dt: number) {
    const h = this.hero.pos;
    const d = dist(h, to);
    const s = Math.min(d, HERO.speed * dt);
    h.x += ((to.x - h.x) / d) * s;
    h.y += ((to.y - h.y) / d) * s;
  }

  private hit(from: Vec, e: Enemy, dmg: number, hero: boolean) {
    const to = this.enemyPos(e);
    this.beams.push({ from: { ...from }, to, ttl: 0.12, hero });
    e.hp -= dmg;
    if (e.hp > 0) return;
    // Gone at once, so a second shooter in the same step cannot hit it again and be paid for it twice.
    this.gold += e.reward;
    this.enemies = this.enemies.filter((x) => x !== e);
  }

  /** How well a pad covers the path: tiles of path within range, where along the path that is, and enemies in range now. */
  padStats(): PadStats[] {
    return this.map.pads.map((p) => {
      const t = this.towerAt(p.name);
      const range = TOWER.range + ((t?.level ?? 1) - 1) * 0.3;
      let covered = 0, mid = 0;
      const step = 0.25;
      for (let d = 0; d <= this.total; d += step) {
        if (dist(p.pos, pointAt(this.map.path, d)) <= range) { covered += step; mid += d * step; }
      }
      const threat = this.enemies.filter((e) => dist(p.pos, this.enemyPos(e)) <= range).length;
      return { name: p.name, where: p.where, level: t?.level ?? 0, coverage: covered, progress: covered ? mid / covered / this.total : 0.5, threat };
    });
  }

  /** One option per pad for the defense (build if empty, upgrade if occupied) plus a sell option for each tower. */
  candidates(): Candidate[] {
    const out: Candidate[] = [];
    for (const s of this.padStats()) {
      const pad = this.padByName(s.name)!;
      const value = s.coverage + 4 * s.threat;
      const pressure = s.threat ? `, ${s.threat} enemies in range now` : "";
      const where = `${s.where}, ${progressWord(s.progress)}${pressure}`;
      const t = this.towerAt(s.name);
      if (!t) {
        out.push({ command: { kind: "build", pad: s.name }, label: `build a new tower at pad ${pad.number} ${s.name} (${where})`, score: value + 2, affordable: this.gold >= COSTS.build, stats: s });
        continue;
      }
      const cost = this.upgradeCost(t);
      out.push({
        command: { kind: "upgrade", pad: s.name },
        label: `upgrade tower ${t.id} at pad ${s.name}, level ${s.level}${cost === null ? ", already at maximum level" : ` to ${s.level + 1} for ${cost} gold`}, make it stronger (${where})`,
        score: cost === null ? -1 : (value * 0.8) / s.level,
        affordable: cost !== null && this.gold >= cost,
        stats: s,
      });
      out.push({
        command: { kind: "sell", pad: s.name },
        label: `sell (remove, delete) tower ${t.id} at pad ${s.name}, level ${s.level}, for ${this.sellValue(t)} gold (${where})`,
        score: -1,
        affordable: true,
        stats: s,
      });
    }
    return out;
  }

  /** The game's own pick for "you choose", steered by whatever area or goal the player hinted at. It never sells. */
  bestCandidate(hint: Hint = {}): Candidate | undefined {
    let pool = this.candidates().filter((c) => c.command.kind !== "sell" && c.score >= 0);
    if (hint.prefer) {
      const kind = pool.filter((c) => c.command.kind === hint.prefer);
      if (kind.length) pool = kind;
    }
    const ok = pool.filter((c) => c.affordable);
    if (ok.length) pool = ok;
    if (hint.area) {
      const inArea = pool.filter((c) => c.stats.where.includes(hint.area!));
      if (inArea.length) pool = inArea;
    }
    const bonus = (c: Candidate) =>
      (hint.near === "base" ? c.stats.progress * 60 : 0) + (hint.near === "spawn" ? (1 - c.stats.progress) * 60 : 0) + (hint.pressure ? c.stats.threat * 20 : 0);
    return pool.reduce<Candidate | undefined>((a, b) => (!a || b.score + bonus(b) > a.score + bonus(a) ? b : a), undefined);
  }

  /** Is this a sensible thing to do right now? Advice only; the player decides. */
  assess(c: Command): Assessment | null {
    const stats = this.padStats();
    const of = (pad: string) => stats.find((s) => s.name === pad);
    if (c.kind === "build") {
      const s = of(c.pad);
      if (!s || this.towerAt(c.pad)) return null;
      const best = Math.max(...stats.filter((x) => x.level === 0).map((x) => x.coverage));
      if (s.threat > 0) return { verdict: "good", note: `${s.threat} enemies are in range of ${c.pad} right now.` };
      if (s.coverage < 0.5 * best) return { verdict: "poor", note: `${c.pad} covers only ${s.coverage.toFixed(1)} tiles of path; the best free pad covers ${best.toFixed(1)}.` };
      return { verdict: "ok", note: `${c.pad} covers ${s.coverage.toFixed(1)} tiles of path.` };
    }
    if (c.kind === "upgrade") {
      const s = of(c.pad), t = this.towerAt(c.pad);
      if (!s || !t) return null;
      const busiest = Math.max(0, ...stats.filter((x) => x.level > 0).map((x) => x.threat));
      if (s.threat > 0) return { verdict: "good", note: `Tower ${t.id} is shooting at ${s.threat} enemies right now.` };
      if (busiest > 0) return { verdict: "poor", note: `Tower ${t.id} sees no enemies while another tower sees ${busiest}.` };
      return { verdict: "ok", note: "No enemies yet, so this is an investment." };
    }
    if (c.kind === "nextwave") {
      if (!this.towers.length) return { verdict: "poor", note: "You have no towers yet." };
      if (this.enemies.length) return { verdict: "poor", note: `${this.enemies.length} enemies are still on the field.` };
      return { verdict: "good", note: "The field is clear, so calling early earns bonus gold." };
    }
    if (c.kind === "sell") {
      const s = of(c.pad), t = this.towerAt(c.pad);
      if (!s || !t) return null;
      if (this.towers.length === 1 && this.enemies.length) return { verdict: "poor", note: "That is your only tower and enemies are on the field." };
      if (s.threat > 0) return { verdict: "poor", note: `Tower ${t.id} is shooting at ${s.threat} enemies right now.` };
      if (s.coverage < 3) return { verdict: "good", note: `It covers only ${s.coverage.toFixed(1)} tiles of path, so the gold is better spent elsewhere.` };
      return { verdict: "ok", note: `You get back ${this.sellValue(t)} gold, 60% of what it cost.` };
    }
    return null;
  }

  summary(): string {
    const kinds = ["fast", "tank", "grunt"].map((k) => [k, this.enemies.filter((e) => e.kind === k).length] as const).filter(([, n]) => n);
    const enemies = this.enemies.length ? `${this.enemies.length} enemies (${kinds.map(([k, n]) => `${n} ${k}`).join(", ")})` : "no enemies right now";
    const towers = this.towers.length ? this.towers.map((t) => `#${t.id} ${t.pad} L${t.level}`).join(", ") : "none";
    return `Wave ${this.wave}. Gold ${this.gold} (build ${COSTS.build}, upgrade ${COSTS.upgrade.join("/")}). Base health ${this.baseHp}. Towers: ${towers}. ${enemies}. Hero is ${this.orderText()}.${this.paused ? " The game is paused." : ""}${this.speed === 2 ? " Double speed." : ""}${this.last ? ` Last command: ${describeCommand(this.last)}.` : ""}`;
  }

  orderText(): string {
    const o = this.hero.order;
    if (o.type === "idle") return "idle";
    if (o.type === "attack") return o.mode === "number" ? `attacking enemy ${o.n}` : o.mode === "rank" ? `attacking the ${ordinal(o.n!)} enemy` : `attacking ${o.mode}`;
    if (o.type === "patrol") return "patrolling";
    return `moving to ${o.label}${o.then ? ` to ${o.then.kind}` : ""}`;
  }
}

export const progressWord = (p: number) => (p < 0.34 ? "near the spawn" : p > 0.66 ? "near the base" : "midway along the path");
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
