import { GameMap, Vec, pathLength, pointAt } from "./map";
import { Command, FocusMode, Place } from "./commands";
import { mulberry32, Rng } from "./rng";

export interface Enemy { id: number; kind: "grunt" | "fast" | "tank"; d: number; hp: number; maxHp: number; speed: number; reward: number }
export interface Tower { id: number; pad: string; pos: Vec; level: number; cd: number }
export interface Beam { from: Vec; to: Vec; ttl: number; hero: boolean }
type Order =
  | { type: "idle" }
  | { type: "move"; to: Vec; label: string; then?: Command }
  | { type: "attack"; mode: FocusMode; target?: number };

export const COSTS = { build: 50, upgrade: 40 };

export interface PadStats {
  name: string;
  where: string;
  level: number;
  coverage: number;
  progress: number;
  threat: number;
}

export interface Candidate { command: Command; label: string; score: number; affordable: boolean; stats: PadStats }
export interface Hint { area?: string; near?: "base" | "spawn"; pressure?: boolean }
const HERO = { speed: 3.2, range: 2.1, damage: 9, cooldown: 0.45 };
const TOWER = { range: 2.6, damage: 5, cooldown: 0.7 };
const ARRIVE = 0.15;

export class Game {
  map: GameMap;
  rng: Rng;
  total: number;
  enemies: Enemy[] = [];
  towers: Tower[] = [];
  beams: Beam[] = [];
  hero = { pos: { x: 0, y: 0 } as Vec, cd: 0, order: { type: "idle" } as Order };
  gold = 100;
  baseHp = 20;
  wave = 0;
  time = 0;
  log: string[] = [];
  state: "playing" | "lost" = "playing";
  private nextId = 1;
  private nextTower = 1;
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
    const t: Tower = { id: this.nextTower++, pad: p.name, pos: p.pos, level, cd: 0 };
    this.towers.push(t);
    return t;
  }
  towerById(id: number) { return this.towers.find((t) => t.id === id); }
  towerAt(pad: string) { return this.towers.find((t) => t.pad === pad); }
  padByName(name: string) { return this.map.pads.find((p) => p.name.toLowerCase() === name.toLowerCase()); }

  say(msg: string) { this.log.push(msg); if (this.log.length > 50) this.log.shift(); }

  resolve(p: Place): { pos: Vec; label: string } | undefined {
    if (p.type === "base") return { pos: this.map.base, label: "base" };
    if (p.type === "spawn") return { pos: this.map.spawn, label: "spawn" };
    const pad = this.padByName(p.name);
    return pad && { pos: pad.pos, label: pad.name };
  }

  command(c: Command): string {
    switch (c.kind) {
      case "hold":
        this.hero.order = { type: "idle" };
        return "Holding position.";
      case "attack":
        this.hero.order = { type: "attack", mode: c.mode };
        return `Attacking the ${c.mode} enemy.`;
      case "move": {
        const t = this.resolve(c.to);
        if (!t) return "No such place.";
        this.hero.order = { type: "move", to: t.pos, label: t.label };
        return `Moving to ${t.label}.`;
      }
      case "build":
      case "upgrade": {
        const pad = this.padByName(c.pad);
        if (!pad) return "No such pad.";
        this.hero.order = { type: "move", to: pad.pos, label: pad.name, then: c };
        return `Heading to ${pad.name} to ${c.kind === "build" ? "build" : "upgrade"}.`;
      }
    }
  }

  private finish(c: Command) {
    if (c.kind === "build") {
      const pad = this.padByName(c.pad)!;
      if (this.towerAt(pad.name)) return this.say(`${pad.name} already has a tower.`);
      if (this.gold < COSTS.build) return this.say(`Need ${COSTS.build} gold to build.`);
      this.gold -= COSTS.build;
      const t = this.addTower(pad.name);
      this.say(`Built tower ${t.id} at ${pad.name}.`);
    } else if (c.kind === "upgrade") {
      const t = this.towerAt(c.pad);
      if (!t) return this.say(`No tower at ${c.pad} to upgrade.`);
      if (this.gold < COSTS.upgrade) return this.say(`Need ${COSTS.upgrade} gold to upgrade.`);
      this.gold -= COSTS.upgrade;
      t.level++;
      this.say(`Upgraded tower ${t.id} at ${c.pad} to level ${t.level}.`);
    }
  }

  private planWave() {
    this.wave++;
    const n = 4 + this.wave * 2;
    for (let i = 0; i < n; i++) {
      const roll = this.rng();
      const kind: Enemy["kind"] = this.wave >= 3 && roll < 0.2 ? "tank" : this.wave >= 2 && roll < 0.5 ? "fast" : "grunt";
      this.spawnQueue.push({ at: this.time + i * 0.9, kind });
    }
    this.say(`Wave ${this.wave} incoming.`);
  }

  private spawn(kind: Enemy["kind"]) {
    const scale = 1 + (this.wave - 1) * 0.18;
    const base = { grunt: [30, 1.0, 6], fast: [18, 1.8, 7], tank: [110, 0.6, 14] }[kind];
    const hp = Math.round(base[0] * scale);
    this.enemies.push({ id: this.nextId++, kind, d: 0, hp, maxHp: hp, speed: base[1], reward: base[2] });
  }

  pick(mode: FocusMode): Enemy | undefined {
    const live = this.enemies;
    if (!live.length) return undefined;
    const by = (f: (e: Enemy) => number) => live.reduce((a, b) => (f(b) < f(a) ? b : a));
    switch (mode) {
      case "first": return by((e) => -e.d);
      case "strongest": return by((e) => -e.hp);
      case "weakest": return by((e) => e.hp);
      case "nearest": return by((e) => dist(this.hero.pos, this.enemyPos(e)));
    }
  }

  step(dt: number) {
    if (this.state !== "playing") return;
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
    }
    this.enemies = this.enemies.filter((e) => e.hp > 0 && e.d < this.total);
    if (this.baseHp <= 0) { this.state = "lost"; this.say("The base has fallen."); return; }

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
      focus = this.enemies.find((e) => e.id === o.target) ?? this.pick(o.mode);
      o.target = focus?.id;
      if (focus) {
        const p = this.enemyPos(focus);
        if (dist(h.pos, p) > HERO.range * 0.9) this.walk(p, dt);
      }
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
    if (e.hp <= 0) this.gold += e.reward;
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

  /** One legal concrete action per pad (build if empty, upgrade if occupied), with a heuristic score. */
  candidates(): Candidate[] {
    return this.padStats().map((s) => {
      const value = s.coverage + 4 * s.threat;
      const pressure = s.threat ? `, ${s.threat} enemies in range now` : "";
      const where = `${s.where}, ${progressWord(s.progress)}${pressure}`;
      if (s.level === 0) {
        return { command: { kind: "build", pad: s.name }, label: `build a new tower at pad ${s.name} (${where})`, score: value + 2, affordable: this.gold >= COSTS.build, stats: s };
      }
      return {
        command: { kind: "upgrade", pad: s.name },
        label: `upgrade tower ${this.towerAt(s.name)!.id} at pad ${s.name}, level ${s.level} to ${s.level + 1}, make it stronger (${where})`,
        score: (value * 0.8) / s.level,
        affordable: this.gold >= COSTS.upgrade,
        stats: s,
      };
    });
  }

  /** The game's own pick for "you choose", steered by whatever area or goal the player hinted at. */
  bestCandidate(hint: Hint = {}): Candidate | undefined {
    let pool = this.candidates();
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

  summary(): string {
    const kinds = ["fast", "tank", "grunt"].map((k) => [k, this.enemies.filter((e) => e.kind === k).length] as const).filter(([, n]) => n);
    const enemies = this.enemies.length ? `${this.enemies.length} enemies (${kinds.map(([k, n]) => `${n} ${k}`).join(", ")})` : "no enemies right now";
    return `Wave ${this.wave}. Gold ${this.gold} (build ${COSTS.build}, upgrade ${COSTS.upgrade}). Base health ${this.baseHp}. ${enemies}. Hero is ${this.orderText()}.`;
  }

  orderText(): string {
    const o = this.hero.order;
    if (o.type === "idle") return "idle";
    if (o.type === "attack") return `attacking ${o.mode}`;
    return `moving to ${o.label}${o.then ? ` to ${o.then.kind}` : ""}`;
  }
}

export const progressWord = (p: number) => (p < 0.34 ? "near the spawn" : p > 0.66 ? "near the base" : "midway along the path");
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
