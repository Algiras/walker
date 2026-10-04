import { describe, expect, it } from "vitest";
import { generateMap, cellKey } from "../src/game/map";
import { Game } from "../src/game/sim";
import { hintFrom, ruleParse, worldOf } from "../src/voice/rules";
import { PAD_NAMES } from "../src/game/map";
import { actionOptions, extraOptions } from "../src/voice/context";
import { cleanTranscript, enemyNumber, splitCommands, gateOptions, hasEvidence, intents, intentOf, ordinalOf, padsNamed, slotNumber, spokenNumbers } from "../src/voice/verbs";
import { settle } from "../src/voice/settle";
import { PickDecider } from "../src/voice/decide";
import { COSTS } from "../src/game/sim";
import { SpeechQueue } from "../src/voice/speech-queue";
import { buildState, CASES, SCENARIOS, satisfies } from "./e2e/scenarios";
import { allLines, calloutFor, eventLine, refusalCallout, warmLines } from "../src/voice/callouts";
import { existsSync, readFileSync } from "node:fs";
import { Command } from "../src/game/commands";
import type { GameEvent } from "../src/game/sim";

describe("map generation", () => {
  it("is deterministic per seed", () => {
    const a = generateMap(42), b = generateMap(42);
    expect(a.pads).toEqual(b.pads);
    expect(a.path).toEqual(b.path);
  });

  it("produces a connected path from the left edge to the right edge", () => {
    for (let seed = 0; seed < 200; seed++) {
      const m = generateMap(seed);
      expect(Math.floor(m.spawn.x)).toBe(0);
      expect(Math.floor(m.base.x)).toBe(m.w - 1);
      for (let i = 1; i < m.path.length; i++) {
        const a = m.path[i - 1], b = m.path[i];
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
  });

  it("keeps pads off the path, spaced out, and uniquely named", () => {
    for (let seed = 0; seed < 200; seed++) {
      const m = generateMap(seed);
      expect(m.pads.length).toBeGreaterThanOrEqual(4);
      expect(new Set(m.pads.map((p) => p.name)).size).toBe(m.pads.length);
      for (const p of m.pads) expect(m.pathCells.has(cellKey(Math.floor(p.pos.x), Math.floor(p.pos.y)))).toBe(false);
    }
  });
});

describe("candidates", () => {
  it("offers one legal action per pad and prefers building on open pads", () => {
    const g = new Game(generateMap(7));
    const c = g.candidates();
    expect(c).toHaveLength(g.map.pads.length);
    expect(c.every((x) => x.command.kind === "build")).toBe(true);
    expect(g.bestCandidate()?.command.kind).toBe("build");
  });

  it("switches to upgrade for an occupied pad", () => {
    const g = new Game(generateMap(7));
    const pad = g.map.pads[0].name;
    g.command({ kind: "build", pad });
    for (let i = 0; i < 30 * 40 && !g.towerAt(pad); i++) g.step(1 / 30);
    expect(g.candidates().find((x) => "pad" in x.command && x.command.pad === pad)?.command.kind).toBe("upgrade");
  });

  it("steers the automatic pick by hint", () => {
    const g = new Game(generateMap(7));
    const near = (h: "base" | "spawn") => g.bestCandidate({ near: h })!.stats.progress;
    expect(near("base")).toBeGreaterThan(near("spawn"));
    const left = g.bestCandidate({ area: "left" });
    if (left) expect(left.stats.where).toContain("left");
  });

  it("follows the build or upgrade word even when only the other kind is affordable", () => {
    const g = new Game(generateMap(7));
    g.addTower(g.map.pads[1].name);
    g.gold = 45;
    expect(g.bestCandidate({ prefer: "build" })?.command.kind).toBe("build");
    const h = new Game(generateMap(7));
    h.addTower(h.map.pads[1].name, 2);
    h.gold = 60;
    expect(h.bestCandidate({ prefer: "upgrade" })?.command.kind).toBe("upgrade");
    expect(h.bestCandidate()?.command.kind).toBe("build");
  });

  it("summarises the game for the prompt", () => {
    expect(new Game(generateMap(7)).summary()).toMatch(/Gold 100.*Base health 20/);
  });
});

describe("pad and tower numbers", () => {
  it("numbers pads left to right and gives a tower its pad's number", () => {
    const g = new Game(generateMap(7));
    expect(g.map.pads.map((p) => p.number)).toEqual(g.map.pads.map((_, i) => i + 1));
    const late = g.addTower(g.map.pads[2].name), early = g.addTower(g.map.pads[0].name);
    expect([late.id, early.id]).toEqual([3, 1]);
    expect(g.towerById(3)?.pad).toBe(g.map.pads[2].name);
    expect(g.candidates().find((c) => "pad" in c.command && c.command.pad === late.pad && c.command.kind === "upgrade")?.label).toContain("tower 3");
  });

  it("hears numbers however they are spoken", () => {
    for (const t of ["tower two", "Tower 2.", "number two", "pad #2", "no. 2", "sell tower to", "tower too."]) expect(slotNumber(t)).toBe(2);
    expect(slotNumber("pad for")).toBe(4);
    expect(spokenNumbers("put a tower to the left")).toBe("put a tower to the left");
    expect(slotNumber("tower of power")).toBeNull();
  });
});

describe("economy", () => {
  const world = () => new Game(generateMap(7));

  it("refunds 60% of everything spent when selling", () => {
    const g = world();
    const pad = g.map.pads[0].name;
    g.command({ kind: "build", pad });
    for (let i = 0; i < 30 * 40 && !g.towerAt(pad); i++) g.step(1 / 30);
    expect(g.gold).toBe(100 - COSTS.build);
    g.gold = 500;
    g.command({ kind: "upgrade", pad });
    for (let i = 0; i < 60 && g.towerAt(pad)!.level < 2; i++) g.step(1 / 30);
    expect(g.towerAt(pad)!.spent).toBe(COSTS.build + COSTS.upgrade[0]);
    const before = g.gold;
    g.command({ kind: "sell", pad });
    for (let i = 0; i < 60 && g.towerAt(pad); i++) g.step(1 / 30);
    expect(g.towerAt(pad)).toBeUndefined();
    expect(g.gold - before).toBe(Math.floor((COSTS.build + COSTS.upgrade[0]) * COSTS.refund));
  });

  it("refuses what the player cannot afford, shakes, and leaves the hero where it was", () => {
    const g = world();
    g.gold = 10;
    const out = g.command({ kind: "build", pad: g.map.pads[0].name });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Not enough gold/);
    expect(g.hero.shake).toBeGreaterThan(0);
    expect(g.hero.order.type).toBe("idle");
    expect(g.gold).toBe(10);
  });

  it("stops upgrades at the maximum level and refuses to sell or upgrade empty pads", () => {
    const g = world();
    const t = g.addTower(g.map.pads[0].name, 3);
    expect(g.command({ kind: "upgrade", pad: t.pad }).message).toMatch(/maximum level/);
    expect(g.command({ kind: "sell", pad: g.map.pads[1].name }).ok).toBe(false);
    expect(g.command({ kind: "upgrade", pad: g.map.pads[1].name }).ok).toBe(false);
    expect(g.command({ kind: "attack", mode: "nearest" }).message).toMatch(/no enemies/);
  });

  it("never suggests selling on its own", () => {
    const g = world();
    g.addTower(g.map.pads[0].name);
    g.gold = 1000;
    for (let i = 0; i < 40; i++) expect(g.bestCandidate({ near: i % 2 ? "base" : "spawn" })?.command.kind).not.toBe("sell");
  });

  it("warns about selling the only tower while enemies are on the field", () => {
    const g = world();
    g.addTower(g.map.pads[0].name);
    for (let i = 0; i < 30 * 12; i++) g.step(1 / 30);
    expect(g.assess({ kind: "sell", pad: g.map.pads[0].name })?.verdict).toBe("poor");
  });
});

describe("confidence and guard", () => {
  const g = new Game(generateMap(7));
  g.addTower(g.map.pads[2].name);
  const build = { kind: "build", pad: g.map.pads[0].name } as const;

  it("acts at 70% or more, asks between 25% and 70%, and rejects below", () => {
    expect(settle("build at Alpha", build, 0.9, g).status).toBe("act");
    expect(settle("build at Alpha", build, 0.7, g).status).toBe("act");
    expect(settle("build at Alpha", build, 0.5, g).status).toBe("confirm");
    expect(settle("build at Alpha", build, 0.2, g).status).toBe("reject");
    expect(settle("mumble", null, 0.9, g).status).toBe("reject");
  });

  it("does not turn build into upgrade or upgrade into build behind the player's back", () => {
    const occupied = { kind: "upgrade", pad: g.map.pads[2].name } as const;
    expect(settle("build a tower at Charlie", occupied, 0.95, g).status).toBe("reject");
    expect(settle("upgrade Alpha", build, 0.95, g).status).toBe("reject");
    expect(settle("upgrade Charlie", occupied, 0.95, g).status).toBe("act");
  });
});

describe("how sure the decider is", () => {
  const g = new Game(generateMap(7));
  // No verb, so every kind of action stays in play next to Charlie's own, and the keywords can only say "move".
  const model = (weights: Record<string, number>) => async ({ options }: { options: { key: string }[] }) => options.map((o) => weights[o.key] ?? 0.001);

  it("acts when the winner clearly beats the runner-up", async () => {
    const r = await new PickDecider("fake", model({ hold: 0.9, undo: 0.05 })).decide("Charlie please", g);
    expect([r.command, r.status]).toEqual([{ kind: "hold" }, "act"]);
  });

  it("asks first when the runner-up is close", async () => {
    const r = await new PickDecider("fake", model({ hold: 0.45, undo: 0.45 })).decide("Charlie please", g);
    expect(r.status).toBe("confirm");
    expect(r.confidence).toBeCloseTo(0.5);
  });

  it("rejects cleanly when the model's answer cannot be used", async () => {
    const r = await new PickDecider("fake", async ({ options }) => options.map(() => NaN)).decide("Charlie please", g);
    expect([r.status, r.command]).toEqual(["reject", null]);
  });

  it("says why when the game has nothing left to build or upgrade", async () => {
    const full = new Game(generateMap(7));
    for (const p of full.map.pads) full.addTower(p.name, 3);
    const auto = async ({ options }: { options: { key: string }[] }) => options.map((o) => (o.key === "defend_auto" ? 0.9 : 0.01));
    const r = await new PickDecider("fake", auto).decide("we need more defense", full);
    expect([r.status, r.note]).toEqual(["reject", "Every pad has a tower and every tower is at the maximum level."]);
    expect(refusalCallout(r.note!)).toBe("Negative. Maximum level.");
  });
});

describe("option gate details", () => {
  const seven = Array.from({ length: 200 }, (_, i) => i).find((i) => generateMap(i).pads.length === 7)!;
  const g = new Game(generateMap(seven));
  g.hero.pos = { x: 9, y: 5.5 };
  for (const p of g.map.pads) g.addTower(p.name);
  g.enemies.push({ id: 1, num: 1, kind: "grunt", d: 5, hp: 10, maxHp: 10, speed: 1, reward: 1 });
  const all = actionOptions(g);
  const pads = (text: string) => new Set(gateOptions(all, text).flatMap((o) => (o.value && o.value !== "auto" && "pad" in o.value ? [o.value.pad] : [])));

  it("never offers more than Tev1's 24 letters", () => {
    expect(all.length).toBeGreaterThan(24);
    for (const t of ["", "Charlie", "hello there", "go build"]) expect(gateOptions(all, t).length).toBeLessThanOrEqual(24);
  });
  it("keeps none when it has to cut the list, and never repeats an option", () => {
    for (const t of ["", "hello there", "Charlie please"]) {
      const opts = gateOptions(all, t);
      expect(opts.some((o) => o.value === null), t).toBe(true);
      expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length);
    }
  });
  it("leaves only that pad's own move for go-to, with no patrol or nudges", () => {
    const h = new Game(generateMap(7));
    h.hero.pos = { x: 9, y: 5.5 };
    expect(gateOptions(actionOptions(h), "go to Charlie").map((o) => o.key)).toEqual(["move_charlie"]);
    expect(gateOptions(actionOptions(h), "go to pad 3").map((o) => o.key)).toEqual(["move_charlie"]);
  });
  it("narrows to the pad that was named or numbered", () => {
    expect([...pads("sell Charlie")]).toEqual(["Charlie"]);
    expect([...pads("upgrade tower 2")]).toEqual(["Bravo"]);
  });
  it("hears cell as sell", () => {
    expect(intents("Cell Tower 2")).toEqual(["sell"]);
    expect(cleanTranscript("cell Charlie")).toBe("sell Charlie");
    expect(cleanTranscript("the cell phone")).toBe("the cell phone");
  });
});

describe("nothing to act on", () => {
  const g = new Game(generateMap(7));
  g.hero.pos = { x: 9, y: 5.5 };

  it("offers no option, rather than a wrong one, when asked to sell with no towers", () => {
    expect(gateOptions(actionOptions(g), "sell tower 2")).toEqual([]);
    expect(gateOptions(actionOptions(g), "cell tower 2")).toEqual([]);
  });

  it("refuses to sell a tower that is not there even when other towers exist", () => {
    const h = new Game(generateMap(7));
    h.addTower(h.map.pads[0].name);
    expect(gateOptions(actionOptions(h), "sell tower 3")).toEqual([]);
    expect(gateOptions(actionOptions(h), "sell tower 1").length).toBe(1);
  });

  it("the decider rejects with an explanation instead of asking the model", async () => {
    let asked = false;
    const d = new PickDecider("fake", async () => { asked = true; return [1]; });
    const r = await d.decide("Cell Tower 2", g);
    expect(r.status).toBe("reject");
    expect(r.note).toMatch(/no tower/);
    expect(asked).toBe(false);
  });

  it("trusts the model more when the keywords reach the same command", async () => {
    // 60/40 between two builds near the base; keywords (the game's own pick for "defend the base") agree with the first
    const target = g.bestCandidate({ near: "base" })!.command as { kind: "build"; pad: string };
    const other = g.map.pads.find((p) => p.name !== target.pad)!.name;
    const weights = (first: string, second: string) => async ({ options }: { options: { key: string }[] }) =>
      options.map((o) => (o.key === `build_${first.toLowerCase()}` ? 0.6 : o.key === `build_${second.toLowerCase()}` ? 0.4 : 0));

    const agree = await new PickDecider("fake", weights(target.pad, other)).decide("defend the base", g);
    expect(agree.command).toEqual(target);
    expect(agree.status).toBe("act");
    expect(agree.trace).toMatch(/keywords agree/);
  });
});

describe("verbs", () => {
  it("reads sell separately from defend, and destroy by what it is aimed at", () => {
    expect(intents("sell tower 3")).toEqual(["sell"]);
    expect(intents("destroy tower three")).toEqual(["sell"]);
    expect(intents("destroy the strongest one")).toEqual(["attack"]);
    expect(intents("upgrade tower 3")).toEqual(["defend"]);
    expect(intents("build near the spawn to stop them early")).toEqual(["defend"]);
    expect(intents("stop, hold position")).toEqual(["hold"]);
  });
});

describe("simulation", () => {
  it("builds a tower when the hero reaches a pad", () => {
    const g = new Game(generateMap(7));
    const pad = g.map.pads[0].name;
    g.command({ kind: "build", pad });
    for (let i = 0; i < 30 * 40 && !g.towerAt(pad); i++) g.step(1 / 30);
    expect(g.towerAt(pad)).toBeDefined();
    expect(g.gold).toBe(50);
  });

  it("loses the base when nothing defends it", () => {
    const g = new Game(generateMap(3));
    for (let i = 0; i < 30 * 600 && g.state === "playing"; i++) g.step(1 / 30);
    expect(g.state).toBe("lost");
  });
});

describe("kills, log and advice", () => {
  const enemy = (d: number, hp = 1) => ({ id: 99, num: 1, kind: "grunt" as const, d, hp, maxHp: hp, speed: 0, reward: 6 });
  /** A spot on the path that two different pads can both shoot at. */
  const sharedSpot = (g: Game) => {
    for (let d = 0; d < g.total; d += 0.05) {
      g.enemies = [enemy(d)];
      const hot = g.padStats().filter((s) => s.threat > 0);
      if (hot.length >= 2) { g.enemies = []; return { d, pads: [hot[0].name, hot[1].name] }; }
    }
    throw new Error("no shared spot");
  };

  it("pays for a kill once and removes the enemy at once, however many shooters are in range", () => {
    const g = new Game(generateMap(7));
    const { d, pads } = sharedSpot(g);
    for (const p of pads) g.addTower(p);
    g.enemies = [enemy(d)];
    const before = g.gold;
    g.step(1 / 30);
    expect(g.gold - before).toBe(6);
    expect(g.enemies).toHaveLength(0);
  });

  it("keeps every message, so the page can follow the log by position", () => {
    const g = new Game(generateMap(7));
    for (let i = 0; i < 80; i++) g.say(`message ${i}`);
    expect(g.log).toHaveLength(80);
    expect(g.log[79]).toBe("message 79");
  });

  it("gives no advice about a tower that is not there, and does not crash", () => {
    const g = new Game(generateMap(7));
    const pad = g.map.pads[0].name;
    expect(g.assess({ kind: "sell", pad })).toBeNull();
    expect(g.assess({ kind: "upgrade", pad })).toBeNull();
    g.addTower(pad);
    expect(g.assess({ kind: "build", pad })).toBeNull();
  });

  it("only counts towers when it says another tower sees enemies", () => {
    const g = new Game(generateMap(7));
    const [mine, empty] = [g.map.pads[0].name, g.map.pads[1].name];
    g.addTower(mine);
    for (let d = 0; d < g.total; d += 0.05) {
      g.enemies = [enemy(d)];
      const stat = (name: string) => g.padStats().find((s) => s.name === name)!;
      if (stat(empty).threat > 0 && stat(mine).threat === 0) {
        expect(g.assess({ kind: "upgrade", pad: mine })?.verdict).toBe("ok");
        return;
      }
    }
    throw new Error("no spot only the empty pad covers");
  });

  it("refuses everything once the base has fallen", () => {
    const g = new Game(generateMap(3));
    for (let i = 0; i < 30 * 600 && g.state === "playing"; i++) g.step(1 / 30);
    expect(g.state).toBe("lost");
    const wave = g.wave;
    expect(g.command({ kind: "nextwave" })).toEqual({ ok: false, message: "The base has fallen." });
    expect(g.wave).toBe(wave);
  });

  it("lets a refusal's shake die down even while paused", () => {
    const g = new Game(generateMap(7));
    g.command({ kind: "pause" });
    g.command({ kind: "pause" });
    expect(g.hero.shake).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) g.step(1 / 30);
    expect(g.hero.shake).toBe(0);
  });

  it("refuses a walk to a place that does not exist without remembering it as the last command", () => {
    const g = new Game(generateMap(7));
    const out = g.command({ kind: "move", to: { type: "pad", name: "Nowhere" } });
    expect(out.ok).toBe(false);
    expect(g.last).toBeNull();
    expect(g.hero.shake).toBeGreaterThan(0);
  });
});

describe("orders, waves and targets", () => {
  const world = () => new Game(generateMap(7));
  const enemy = (id: number, d: number, hp: number) => ({ id, num: id, kind: "grunt" as const, d, hp, maxHp: 100, speed: 0, reward: 1 });

  it("checks again on arrival and does not build what can no longer be paid for", () => {
    const g = world();
    const pad = g.map.pads[0];
    g.hero.pos = { x: pad.pos.x + 0.4, y: pad.pos.y };
    g.command({ kind: "build", pad: pad.name });
    g.gold = 10;
    for (let i = 0; i < 30 && g.hero.order.type !== "idle"; i++) g.step(1 / 30);
    expect(g.towerAt(pad.name)).toBeUndefined();
    expect(g.gold).toBe(10);
    expect(g.log[g.log.length - 1]).toMatch(/Not enough gold/);
  });

  it("undoes a build first and the order it interrupted second", () => {
    const g = world();
    const pad = g.map.pads[0].name;
    g.command({ kind: "patrol" });
    g.command({ kind: "build", pad });
    for (let i = 0; i < 30 * 40 && !g.towerAt(pad); i++) g.step(1 / 30);
    expect(g.undo().message).toMatch(/Reverted/);
    expect(g.hero.order.type).toBe("idle");
    expect(g.undo().message).toMatch(/Cancelled: build/);
    expect(g.hero.order.type).toBe("patrol");
  });

  it("pays the early-call bonus for the countdown that is left", () => {
    const g = world();
    expect(g.command({ kind: "nextwave" }).message).toMatch(/\+12 gold/);
    expect(g.gold).toBe(112);
  });

  it("carries enemy numbers on from the highest still on the field when waves overlap", () => {
    const g = world();
    g.command({ kind: "nextwave" });
    for (let i = 0; i < 30 * 8; i++) g.step(1 / 30);
    const first = g.enemies.length;
    expect(g.command({ kind: "nextwave" }).ok).toBe(true);
    for (let i = 0; i < 30 * 12; i++) g.step(1 / 30);
    const nums = g.enemies.map((e) => e.num);
    expect(new Set(nums).size).toBe(nums.length);
    expect(Math.max(...nums)).toBeGreaterThan(first);
  });

  it("picks the strongest, the weakest and the nearest", () => {
    const g = world();
    g.enemies = [enemy(1, 5, 30), enemy(2, 12, 10), enemy(3, 20, 50)];
    expect(g.pick("strongest")?.id).toBe(3);
    expect(g.pick("weakest")?.id).toBe(2);
    g.hero.pos = { ...g.enemyPos(g.enemies[1]) };
    expect(g.pick("nearest")?.id).toBe(2);
  });

  it("ends a numbered attack when its target dies instead of moving on to another enemy", () => {
    const g = world();
    g.enemies = [enemy(1, g.total - 1.2, 100), enemy(2, g.total - 1, 1)];
    g.command({ kind: "attack", mode: "number", n: 2 });
    g.step(1 / 30);
    expect(g.enemies.map((e) => e.num)).toEqual([1]);
    g.step(1 / 30);
    expect(g.hero.order.type).toBe("idle");
  });
});

describe("keyword rules", () => {
  const pads = { padNames: PAD_NAMES.slice(0, 6), padOfSlot: (n: number) => PAD_NAMES[n - 1], hasTower: (n: string) => n === "Charlie" || n === "Delta", best: (h: { near?: string }) => ({ kind: "build", pad: h.near === "base" ? "Foxtrot" : "Echo" }) as const };
  it.each([
    ["build a tower at bravo", { kind: "build", pad: "Bravo" }],
    ["upgrade charlie", { kind: "upgrade", pad: "Charlie" }],
    ["build at charlie", { kind: "upgrade", pad: "Charlie" }],
    ["we need more defense", { kind: "build", pad: "Echo" }],
    ["defend the base", { kind: "build", pad: "Foxtrot" }],
    ["upgrade tower four", { kind: "upgrade", pad: "Delta" }],
    ["upgrade tower 4", { kind: "upgrade", pad: "Delta" }],
    ["upgrade number four", { kind: "upgrade", pad: "Delta" }],
    ["sell tower 3", { kind: "sell", pad: "Charlie" }],
    ["destroy tower three", { kind: "sell", pad: "Charlie" }],
    ["scrap Delta", { kind: "sell", pad: "Delta" }],
    ["destroy the strongest one", { kind: "attack", mode: "strongest" }],
    ["go to the base", { kind: "move", to: { type: "base" } }],
    ["attack the biggest one", { kind: "attack", mode: "strongest" }],
    ["stop", { kind: "hold" }],
    ["move to Alfa", { kind: "move", to: { type: "pad", name: "Alpha" } }],
  ])("%s", (text, expected) => expect(ruleParse(text, pads)).toEqual(expected));

  it("rejects chatter", () => expect(ruleParse("what a lovely day", pads)).toBeNull());
  it("cannot sell what is not built", () => expect(ruleParse("sell Alpha", pads)).toBeNull());
});

describe("keyword gate", () => {
  const g = new Game(generateMap(7));
  g.hero.pos = { x: 9, y: 5.5 };
  const kinds = (text: string) => new Set(gateOptions(actionOptions(g), text).map((o) => intentOf(o)).filter(Boolean));

  it("keeps only movement options when the player says go", () => expect([...kinds("go to Charlie")]).toEqual(["move"]));
  it("keeps only defense options for build, upgrade and stronger", () => {
    for (const t of ["build a tower at Bravo", "upgrade Alpha", "make the towers stronger"]) expect([...kinds(t)]).toEqual(["defend"]);
  });
  it("leaves every option when verbs are mixed or missing", () => {
    expect(kinds("go build a tower").size).toBeGreaterThan(1);
    expect(kinds("Charlie please").size).toBeGreaterThan(1);
  });
  it("drops none once the verbs settle the intent, and keeps it otherwise", () => {
    expect(gateOptions(actionOptions(g), "go to Alpha").some((o) => o.value === null)).toBe(false);
    expect(gateOptions(actionOptions(g), "Alpha").some((o) => o.value === null)).toBe(true);
  });
});

describe("undo and new commands", () => {
  const world = () => new Game(generateMap(7));
  const settle = (g: Game, seconds = 40) => { for (let i = 0; i < seconds * 30; i++) g.step(1 / 30); };

  it("cancels a build while the hero is still walking there", () => {
    const g = world();
    g.command({ kind: "build", pad: g.map.pads[0].name });
    g.step(1 / 30);
    expect(g.undo().message).toMatch(/Cancelled/);
    expect(g.hero.order.type).toBe("idle");
    settle(g, 10);
    expect(g.towers).toHaveLength(0);
    expect(g.gold).toBe(100);
  });

  it("reverts a finished build with a full refund, then the order before it", () => {
    const g = world();
    const pad = g.map.pads[0].name;
    g.command({ kind: "build", pad });
    for (let i = 0; i < 30 * 40 && !g.towerAt(pad); i++) g.step(1 / 30);
    expect(g.gold).toBe(50);
    expect(g.undo().message).toMatch(/Reverted: removed tower 1/);
    expect(g.towerAt(pad)).toBeUndefined();
    expect(g.gold).toBe(100);
  });

  it("reverts an upgrade", () => {
    const g = world();
    const t = g.addTower(g.map.pads[0].name);
    g.gold = 100;
    g.command({ kind: "upgrade", pad: t.pad });
    for (let i = 0; i < 30 * 40 && t.level < 2; i++) g.step(1 / 30);
    const afterUpgrade = g.gold;
    g.undo();
    expect(t.level).toBe(1);
    expect(g.gold).toBe(afterUpgrade + COSTS.upgrade[0]);
    expect(t.spent).toBe(COSTS.build);
  });

  it("brings a sold tower back, and refuses when the player cannot cover it", () => {
    const g = world();
    const t = g.addTower(g.map.pads[0].name, 2);
    g.command({ kind: "sell", pad: t.pad });
    for (let i = 0; i < 30 * 40 && g.towerAt(t.pad); i++) g.step(1 / 30);
    const refund = g.gold - 100;
    expect(refund).toBeGreaterThan(0);
    g.gold = 0;
    expect(g.undo().ok).toBe(false);
    expect(g.towerAt(t.pad)).toBeUndefined();
    g.gold = refund + 10;
    expect(g.undo().ok).toBe(true);
    expect(g.towerAt(t.pad)?.level).toBe(2);
    expect(g.gold).toBe(10);
  });

  it("says so when there is nothing to undo", () => {
    expect(world().undo()).toEqual({ ok: false, message: "Nothing to undo." });
  });

  it("pauses, resumes and changes speed", () => {
    const g = world();
    g.command({ kind: "pause" });
    const t = g.time;
    g.step(1);
    expect(g.time).toBe(t);
    expect(g.command({ kind: "pause" }).ok).toBe(false);
    g.command({ kind: "resume" });
    g.command({ kind: "speed", fast: true });
    expect(g.speed).toBe(2);
  });

  it("calls the next wave early only between waves", () => {
    const g = world();
    expect(g.command({ kind: "nextwave" }).ok).toBe(true);
    expect(g.wave).toBe(1);
    expect(g.command({ kind: "nextwave" }).message).toMatch(/still arriving/);
  });

  it("nudges inside the map and patrols between spawn and base", () => {
    const g = world();
    g.hero.pos = { x: 0.6, y: 5 };
    g.command({ kind: "nudge", dir: "left" });
    settle(g, 3);
    expect(g.hero.pos.x).toBeGreaterThanOrEqual(0.5);
    g.command({ kind: "patrol" });
    settle(g, 3);
    expect(g.orderText()).toBe("patrolling");
  });

  it("repeats the last real command but not itself", () => {
    const g = world();
    expect(g.command({ kind: "repeat" }).ok).toBe(false);
    g.command({ kind: "attack", mode: "first" });
    g.command({ kind: "pause" });
    g.command({ kind: "resume" });
    g.command({ kind: "hold" });
    expect(g.command({ kind: "repeat" }).message).toMatch(/Holding/);
  });
});

describe("speech queue", () => {
  it("queues replies to orders in order and drops the oldest when it is full", () => {
    const q = new SpeechQueue(3);
    for (const l of ["a", "b", "c", "d"]) expect(q.push(l, 2, true)).toBe(true);
    expect([q.next()?.line, q.next()?.line, q.next()?.line, q.next()]).toEqual(["b", "c", "d", undefined]);
  });

  it("never lets a game event wait behind speech", () => {
    const q = new SpeechQueue();
    expect(q.push("Wave one incoming.", 1, true)).toBe(false);
    q.push("Moving out.", 2, false);
    expect(q.push("Wave one incoming.", 1, false)).toBe(false);
    q.next();
    expect(q.push("Wave one incoming.", 1, false)).toBe(true);
  });

  it("skips a line that repeats the one just queued", () => {
    const q = new SpeechQueue();
    expect(q.push("Moving out.", 2, false)).toBe(true);
    expect(q.push("Moving out.", 2, true)).toBe(false);
    expect(q.length).toBe(1);
  });
});

describe("hero callouts", () => {
  const g = new Game(generateMap(7));
  g.addTower(g.map.pads[2].name);

  it("says what it is about to do, tersely", () => {
    expect(calloutFor({ kind: "build", pad: "Alpha" }, g)).toBe("Building at Alpha.");
    expect(calloutFor({ kind: "upgrade", pad: "Charlie" }, g)).toBe("Upgrading tower three.");
    expect(calloutFor({ kind: "sell", pad: "Charlie" }, g)).toBe("Selling tower three.");
    expect(calloutFor({ kind: "move", to: { type: "pad", name: "Bravo" } }, g)).toBe("Moving to Bravo.");
    expect(calloutFor({ kind: "move", to: { type: "base" } }, g)).toBe("Falling back.");
    expect(calloutFor({ kind: "attack", mode: "number", n: 4 }, g)).toBe("Engaging target four.");
    expect(calloutFor({ kind: "attack", mode: "rank", n: 2 }, g)).toBe("Engaging the second target.");
    expect(calloutFor({ kind: "hold" }, g)).toBe("Holding position.");
  });

  it("repeats the callout of the command being repeated", () => {
    const h = new Game(generateMap(7));
    h.last = { kind: "patrol" };
    expect(calloutFor({ kind: "repeat" }, h)).toBe("Patrolling.");
    expect(calloutFor({ kind: "repeat" }, new Game(generateMap(7)))).toBeNull();
  });

  it("refuses in the same voice", () => {
    expect(refusalCallout("Not enough gold: a tower costs 50, you have 10.")).toBe("Insufficient funds.");
    expect(refusalCallout("There is no tower at Alpha to sell.")).toBe("Negative. No tower there.");
    expect(refusalCallout("Pad 3 Charlie already has a tower.")).toBe("Negative. Pad occupied.");
    expect(refusalCallout("I did not catch that. Say it again?")).toBe("Say again?");
    expect(refusalCallout("something else")).toBe("Negative.");
  });

  it("announces game events, with the base-hit warning rate limited", () => {
    const h = new Game(generateMap(3));
    const heard: string[] = [];
    h.announce = (e) => heard.push(eventLine(e));
    for (let i = 0; i < 30 * 600 && h.state === "playing"; i++) h.step(1 / 30);
    expect(heard).toContain("Wave one incoming.");
    expect(heard).toContain("Base destroyed.");
    expect(heard.filter((l) => l === "Base under attack.").length).toBeLessThan(heard.length);
  });

  it("only ever says lines from the recorded vocabulary", () => {
    const lines = new Set(allLines());
    const g2 = new Game(generateMap(7));
    for (const p of g2.map.pads) g2.addTower(p.name, 2);
    const commands: Command[] = [
      { kind: "hold" }, { kind: "pause" }, { kind: "resume" }, { kind: "patrol" }, { kind: "undo" }, { kind: "nextwave" },
      { kind: "speed", fast: true }, { kind: "speed", fast: false },
      ...(["left", "right", "up", "down"] as const).map((dir): Command => ({ kind: "nudge", dir })),
      ...(["nearest", "strongest", "weakest", "first", "last"] as const).map((mode): Command => ({ kind: "attack", mode })),
      ...Array.from({ length: 60 }, (_, i): Command => ({ kind: "attack", mode: "number", n: i })),
      ...Array.from({ length: 10 }, (_, i): Command => ({ kind: "attack", mode: "rank", n: i + 1 })),
      { kind: "move", to: { type: "base" } }, { kind: "move", to: { type: "spawn" } }, { kind: "move", to: { type: "point", x: 3, y: 3 } },
      ...g2.map.pads.flatMap((p): Command[] => [{ kind: "build", pad: p.name }, { kind: "upgrade", pad: p.name }, { kind: "sell", pad: p.name }, { kind: "move", to: { type: "pad", name: p.name } }]),
    ];
    for (const c of commands) {
      const line = calloutFor(c, g2);
      if (line) expect(lines.has(line), `no recording for "${line}" (${JSON.stringify(c)})`).toBe(true);
    }
    for (const e of [...Array.from({ length: 60 }, (_, n): GameEvent => ({ kind: "wave", n })), ...(["baseHit", "built", "upgraded", "sold", "lost"] as const).map((kind): GameEvent => ({ kind }))]) {
      expect(lines.has(eventLine(e)), `no recording for "${eventLine(e)}"`).toBe(true);
    }
    for (const m of ["Not enough gold: a tower costs 50", "There is no tower at A", "Pad 3 Charlie already has a tower.", "maximum level", "no enemies", "Nothing to undo.", "still arriving", "I did not catch that", "other", "The base has fallen.", "There is no pad 8.", "The hero is already there.", "There are no enemies to attack.", "Pad Alpha already has tower 1."]) {
      expect(lines.has(refusalCallout(m)), `no recording for "${refusalCallout(m)}"`).toBe(true);
    }
  });

  it("only warms up lines that have been recorded", () => {
    const lines = new Set(allLines());
    for (const l of warmLines(new Game(generateMap(7)))) expect(lines.has(l), l).toBe(true);
  });

  it("has a recording file for every line once they have been generated", () => {
    const file = new URL("../public/voice/manifest.json", import.meta.url).pathname;
    if (!existsSync(file)) return;
    const recorded = new Set(Object.keys(JSON.parse(readFileSync(file, "utf8")).lines));
    for (const line of allLines()) expect(recorded.has(line), `not recorded: "${line}"`).toBe(true);
  });
});

describe("several commands in one sentence", () => {
  it("splits at and, then, commas and sentence ends", () => {
    expect(splitCommands("go to Charlie and build a tower at Alpha")).toEqual(["go to Charlie", "build a tower at Alpha"]);
    expect(splitCommands("sell tower 3, then upgrade tower 1")).toEqual(["sell tower 3", "upgrade tower 1"]);
    expect(splitCommands("pause the game. go left")).toEqual(["pause the game", "go left"]);
    expect(splitCommands("go left and then patrol and then attack the last one")).toHaveLength(3);
  });

  it("keeps lists and single commands whole", () => {
    expect(splitCommands("build a tower at Alpha and Bravo")).toEqual(["build a tower at Alpha and Bravo"]);
    expect(splitCommands("attack the weakest and strongest")).toEqual(["attack the weakest and strongest"]);
    expect(splitCommands("go to Charlie")).toEqual(["go to Charlie"]);
    expect(splitCommands("")).toEqual([""]);
  });

  it("never returns more than four clauses", () => {
    const many = splitCommands("go left, go right, go up, go down, go left, patrol");
    expect(many).toHaveLength(4);
  });
});

describe("evidence", () => {
  it("sees something to act on, or nothing", () => {
    for (const t of ["go to Charlie", "sell tower 3", "defend the base", "pause", "undo", "we need more towers", "Charlie"]) expect(hasEvidence(t)).toBe(true);
    for (const t of ["you", "Thank you.", "uh huh", "what a lovely day"]) expect(hasEvidence(t)).toBe(false);
  });

  it("rejects noise outright and never lets a keyword-free guess act", async () => {
    const g = new Game(generateMap(7));
    const confident = new PickDecider("fake", async ({ options }) => options.map((_, i) => (i === 0 ? 0.95 : 0.01)));
    const noise = await confident.decide("you", g);
    expect(noise.status).toBe("reject");
    const vague = await confident.decide("could you maybe help me a little here", g);
    expect(vague.status).toBe("confirm");
  });
});

describe("keyword shortcuts", () => {
  const g = new Game(generateMap(7));
  g.hero.pos = { x: 9, y: 5.5 };
  const keys = (t: string) => gateOptions(actionOptions(g), t).map((o) => o.key);

  it("narrows unmistakable keywords to a single option", () => {
    expect(keys("patrol the path")).toEqual(["patrol"]);
    expect(keys("pause the game")).toEqual(["pause"]);
    expect(keys("resume")).toEqual(["resume"]);
    expect(keys("speed it up")).toEqual(["speed_up"]);
    expect(keys("slow it down")).toEqual(["speed_down"]);
    expect(keys("call the next wave")).toEqual(["nextwave"]);
  });
});

describe("new voice intents", () => {
  it("separates undo, repeat and game control from movement", () => {
    expect(intents("undo that")).toEqual(["undo"]);
    expect(intents("take that back")).toEqual(["undo"]);
    expect(intents("do that again")).toEqual(["repeat"]);
    expect(intents("pause the game")).toEqual(["game"]);
    expect(intents("call the next wave")).toEqual(["game"]);
    expect(intents("go left")).toEqual(["move"]);
  });

  it("keeps only the matching direction for a bare go-left", () => {
    const g = new Game(generateMap(7));
    g.hero.pos = { x: 9, y: 5.5 };
    const opts = gateOptions(actionOptions(g), "go left");
    expect(opts.map((o) => (o.value && o.value !== "auto" && o.value.kind === "nudge" ? o.value.dir : "x"))).toEqual(["left"]);
  });

  it("the keyword fallback understands them", () => {
    const w = { padNames: PAD_NAMES.slice(0, 6), padOfSlot: (n: number) => PAD_NAMES[n - 1], hasTower: () => false, best: () => null };
    expect(ruleParse("undo that", w)).toEqual({ kind: "undo" });
    expect(ruleParse("pause the game", w)).toEqual({ kind: "pause" });
    expect(ruleParse("resume", w)).toEqual({ kind: "resume" });
    expect(ruleParse("speed it up", w)).toEqual({ kind: "speed", fast: true });
    expect(ruleParse("go left", w)).toEqual({ kind: "nudge", dir: "left" });
    expect(ruleParse("patrol the path", w)).toEqual({ kind: "patrol" });
    expect(ruleParse("call the next wave", w)).toEqual({ kind: "nextwave" });
    expect(ruleParse("do that again", w)).toEqual({ kind: "repeat" });
  });
});

describe("targeting enemies by number and place in line", () => {
  const field = () => {
    const g = new Game(generateMap(7));
    for (let i = 0; i < 30 * 12; i++) g.step(1 / 30);
    return g;
  };

  it("labels enemies 1, 2, 3 in spawn order within a wave", () => {
    const g = field();
    expect(g.enemies.map((e) => e.num)).toEqual(g.enemies.map((_, i) => i + 1));
  });

  it("picks by number, by rank from the front, and by first and last", () => {
    const g = field();
    const byDistance = [...g.enemies].sort((a, b) => b.d - a.d);
    expect(g.pick("first")).toBe(byDistance[0]);
    expect(g.pick("last")).toBe(byDistance[byDistance.length - 1]);
    expect(g.pick("rank", 2)).toBe(byDistance[1]);
    expect(g.pick("number", 3)?.num).toBe(3);
    expect(g.pick("number", 99)).toBeUndefined();
  });

  it("refuses an enemy that is not there and locks onto a numbered one until it dies", () => {
    const g = field();
    expect(g.command({ kind: "attack", mode: "number", n: 99 }).message).toMatch(/no enemy 99/);
    expect(g.command({ kind: "attack", mode: "rank", n: 99 }).message).toMatch(/only \d+ enemies/);
    const target = g.pick("number", 2)!;
    g.command({ kind: "attack", mode: "number", n: 2 });
    for (let i = 0; i < 30 * 60 && g.enemies.includes(target); i++) g.step(1 / 30);
    g.step(1 / 30);
    expect(g.hero.order.type === "idle" || !g.enemies.includes(target)).toBe(true);
  });
});

describe("enemy words", () => {
  it("hears enemy numbers and keeps tower numbers apart", () => {
    expect(enemyNumber("attack enemy three")).toBe(3);
    expect(enemyNumber("attack number 3")).toBe(3);
    expect(enemyNumber("kill monster 4")).toBe(4);
    expect(slotNumber("attack number 3")).toBeNull();
    expect(slotNumber("sell number 3")).toBe(3);
    expect(enemyNumber("sell number 3")).toBeNull();
  });

  it("reads ordinals only when they name an enemy", () => {
    expect(ordinalOf("attack the second one")).toBe(2);
    expect(ordinalOf("kill the 3rd enemy")).toBe(3);
    expect(ordinalOf("hold on a second")).toBeNull();
  });

  it("reads delete and remove as selling a tower, and destroy by what it is aimed at", () => {
    for (const t of ["delete tower 3", "remove Charlie", "take down tower 2", "bulldoze Delta", "destroy Charlie", "destroy tower 3"]) expect(intents(t)).toEqual(["sell"]);
    expect(intents("destroy enemy 3")).toEqual(["attack"]);
  });

  it("narrows to the named enemy, the last one, or the first one", () => {
    const g = new Game(generateMap(7));
    g.enemies.push({ id: 1, num: 1, kind: "grunt", d: 5, hp: 10, maxHp: 10, speed: 1, reward: 1 });
    const keys = (t: string) => gateOptions([...extraOptions(t), ...actionOptions(g)], t).map((o) => o.key);
    expect(keys("attack enemy 3")).toEqual(["attack_enemy_3"]);
    expect(keys("attack the second one")).toEqual(["attack_rank_2"]);
    expect(keys("attack the last one")).toEqual(["attack_last"]);
    expect(keys("attack the first one")).toEqual(["attack_first"]);
  });

  it("the keyword fallback parses them", () => {
    const w = { padNames: PAD_NAMES.slice(0, 6), padOfSlot: (n: number) => PAD_NAMES[n - 1], hasTower: (n: string) => n === "Charlie", best: () => null };
    expect(ruleParse("attack enemy 3", w)).toEqual({ kind: "attack", mode: "number", n: 3 });
    expect(ruleParse("attack the last one", w)).toEqual({ kind: "attack", mode: "last" });
    expect(ruleParse("attack the second one", w)).toEqual({ kind: "attack", mode: "rank", n: 2 });
    expect(ruleParse("delete tower 3", w)).toEqual({ kind: "sell", pad: "Charlie" });
    expect(ruleParse("remove Charlie", w)).toEqual({ kind: "sell", pad: "Charlie" });
  });
});

describe("a pad the map does not have", () => {
  // Seed 7 has five pads, Alpha to Echo.
  const world = () => {
    const g = new Game(generateMap(7));
    g.hero.pos = { x: 9, y: 5.5 };
    return g;
  };
  const ask = async (text: string, g = world()) => {
    let asked = false;
    const d = new PickDecider("fake", async ({ options }) => { asked = true; return options.map((_, i) => (i === 0 ? 1 : 0)); });
    return { ...(await d.decide(text, g)), asked };
  };

  it("leaves nothing to choose, instead of falling back to the game's own pick", () => {
    const g = world();
    for (const t of ["upgrade tower 8", "upgrade tower 7", "build at Golf", "build a tower at Hotel", "go to Hotel"]) expect(gateOptions(actionOptions(g), t), t).toEqual([]);
  });

  it("is turned down with a reason, without asking the model", async () => {
    const r = await ask("upgrade tower 8");
    expect([r.status, r.note, r.asked]).toEqual(["reject", "There is no pad 8.", false]);
    expect((await ask("build at Golf")).note).toBe("There is no pad Golf.");
    expect((await ask("go to Hotel")).note).toBe("There is no pad Hotel.");
  });

  it("is not guessed by the keyword fallback either", () => {
    const w = { padNames: PAD_NAMES.slice(0, 5), padOfSlot: (n: number) => PAD_NAMES.slice(0, 5)[n - 1], hasTower: () => false, best: () => ({ kind: "build", pad: "Echo" }) as const };
    expect(ruleParse("upgrade tower 8", w)).toBeNull();
    expect(ruleParse("build at Hotel", w)).toBeNull();
    expect(ruleParse("we need more defense", w)).toEqual({ kind: "build", pad: "Echo" });
  });

  it("is not what 'delete', 'home' or 'gold' sound like", () => {
    expect(padsNamed("delete the tower")).toEqual([]);
    expect(padsNamed("go home")).toEqual([]);
    expect(padsNamed("upgrade with the gold")).toEqual([]);
    expect(padsNamed("move to Alfa")).toEqual(["Alpha"]);
    expect(padsNamed("upgrade tower 2")).toEqual(["Bravo"]);
  });

  it("is still heard when speech recognition splits the name in two", () => {
    expect(padsNamed("go to fox trot")).toEqual(["Foxtrot"]);
    expect(padsNamed("build a tower at Fox Trot.")).toEqual(["Foxtrot"]);
    expect(padsNamed("the fox ran")).toEqual([]);
  });

  it("does not make 'delete the tower' mean the tower on Delta", () => {
    const g = world();
    for (const p of ["Bravo", "Delta"]) g.addTower(p);
    expect(gateOptions(actionOptions(g), "delete the tower").map((o) => o.key)).toEqual(["sell_bravo", "sell_delta"]);
    expect(ruleParse("delete the tower", worldOf(g))).toBeNull();
  });

  it("still lets 'go home' reach the base", () => {
    expect(gateOptions(actionOptions(world()), "go home").map((o) => o.key)).toContain("move_base");
  });
});

describe("naming a pad settles the decision", () => {
  const g = new Game(generateMap(7));
  g.hero.pos = { x: 9, y: 5.5 };

  it("drops the 'you choose' option, since the player did name a place", () => {
    expect(gateOptions(actionOptions(g), "build a tower at Alpha").map((o) => o.key)).toEqual(["build_alpha"]);
    expect(gateOptions(actionOptions(g), "make Charlie stronger").map((o) => o.key)).toEqual(["build_charlie"]);
  });

  it("keeps it when no pad is named", () => {
    expect(gateOptions(actionOptions(g), "we need more defense").map((o) => o.key)).toContain("defend_auto");
  });

  it("does not run the model when the words leave a single option", async () => {
    let asked = false;
    const d = new PickDecider("fake", async () => { asked = true; return [1]; });
    const r = await d.decide("build a tower at Alpha", g);
    expect(asked).toBe(false);
    expect([r.status, r.command]).toEqual(["act", { kind: "build", pad: "Alpha" }]);
  });
});

describe("the hero is already there", () => {
  const atBase = () => new Game(generateMap(7));

  it("leaves nothing to guess when asked to go where it already stands", () => {
    for (const t of ["retreat to the base", "go to the base", "go home"]) expect(gateOptions(actionOptions(atBase()), t), t).toEqual([]);
    const g = atBase();
    g.hero.pos = { ...g.map.spawn };
    expect(gateOptions(actionOptions(g), "go to the spawn")).toEqual([]);
  });

  it("says so", async () => {
    const d = new PickDecider("fake", async () => [1]);
    expect((await d.decide("retreat to the base", atBase())).note).toBe("The hero is already there.");
  });

  it("keeps every move once the hero is somewhere else, and for a patrol or a route", () => {
    const g = atBase();
    g.hero.pos = { x: 9, y: 5.5 };
    expect(gateOptions(actionOptions(g), "retreat to the base").map((o) => o.key)).toContain("move_base");
    const home = atBase();
    expect(gateOptions(actionOptions(home), "start patrol").map((o) => o.key)).toEqual(["patrol"]);
    expect(gateOptions(actionOptions(home), "go from the base to Alpha").map((o) => o.key)).toEqual(["move_alpha"]);
  });

  it("tells the player when there is nothing to attack", async () => {
    const d = new PickDecider("fake", async () => [1]);
    expect((await d.decide("attack the nearest enemy", atBase())).note).toBe("There are no enemies to attack.");
  });
});

describe("attack words", () => {
  const g = new Game(generateMap(7));
  g.hero.pos = { x: 9, y: 5.5 };
  g.enemies.push({ id: 1, num: 1, kind: "grunt", d: 5, hp: 10, maxHp: 10, speed: 1, reward: 1 });
  const keys = (t: string) => gateOptions([...extraOptions(t), ...actionOptions(g)], t).map((o) => o.key);
  const world = worldOf(g);

  it("does not read 'first' or 'last' as the front or back of the line when another kind of enemy is named", () => {
    for (const t of ["attack the weakest enemy first", "kill the nearest one first", "attack the strongest one last"]) expect(keys(t), t).toHaveLength(5);
    expect(keys("attack the first one")).toEqual(["attack_first"]);
    expect(keys("attack the last one")).toEqual(["attack_last"]);
  });

  it("is read the same way by the keyword fallback", () => {
    expect(ruleParse("attack the weakest enemy first", world)).toEqual({ kind: "attack", mode: "weakest" });
    expect(ruleParse("kill the nearest one first", world)).toEqual({ kind: "attack", mode: "nearest" });
    expect(ruleParse("attack the first one", world)).toEqual({ kind: "attack", mode: "first" });
  });

  it("understands the words the hero says back, such as 'engage target four' and 'attack the heavy'", () => {
    expect(intents("engage the nearest")).toEqual(["attack"]);
    expect(cleanTranscript("engage target four")).toBe("engage enemy 4");
    expect(keys("attack target 3")).toEqual(["attack_enemy_3"]);
    expect(ordinalOf("engage the second target")).toBe(2);
    expect(keys("engage the second target")).toEqual(["attack_rank_2"]);
    expect(ruleParse("attack the heavy", world)).toEqual({ kind: "attack", mode: "strongest" });
    expect(ruleParse("attack the lead target", world)).toEqual({ kind: "attack", mode: "first" });
    expect(ruleParse("attack the rear target", world)).toEqual({ kind: "attack", mode: "last" });
    expect(keys("double time")).toEqual(["speed_up"]);
  });

  it("hears 'destroy enemy number three' as an enemy, not a tower", () => {
    expect(cleanTranscript("destroy enemy number three")).toBe("destroy enemy 3");
    expect(cleanTranscript("attack enemy number 3")).toBe("attack enemy 3");
    expect(intents("destroy enemy number three")).toEqual(["attack"]);
    expect(enemyNumber("destroy enemy number three")).toBe(3);
    expect(keys("destroy enemy number three")).toEqual(["attack_enemy_3"]);
  });
});

describe("build and upgrade words", () => {
  it("are all defend words, and steer the game's own pick", () => {
    for (const w of ["build", "place", "construct", "put", "create", "upgrade", "improve", "strengthen", "reinforce", "stronger"]) expect(intents(`${w} it`), w).toContain("defend");
    expect(hintFrom("build near the base")).toMatchObject({ prefer: "build", near: "base" });
    expect(hintFrom("make the towers stronger").prefer).toBe("upgrade");
    expect(hintFrom("build and upgrade").prefer).toBeUndefined();
  });

  it("only imply an attack for an enemy number or a place in line, not next to build, hold or sell", () => {
    expect(intents("the second one")).toEqual(["attack"]);
    expect(intents("go after enemy 3")).toEqual(["move", "attack"]);
    expect(intents("remove enemy 3")).toEqual(["sell", "attack"]);
    expect(intents("sell tower 2 near enemy 3")).toEqual(["sell"]);
    expect(intents("go to Alpha near enemy 3")).toEqual(["move"]);
    expect(intents("sell the second one")).toEqual(["sell"]);
    expect(intents("build a tower near enemy 3")).toEqual(["defend"]);
    expect(intents("stop attacking enemy 3")).toEqual(["hold"]);
  });
});

describe("stopping", () => {
  const g = new Game(generateMap(7));
  g.hero.pos = { x: 9, y: 5.5 };
  const keys = (t: string) => gateOptions(actionOptions(g), t).map((o) => o.key);

  it("hears 'stop there' as stop, but 'stop them' as something about the enemies", () => {
    expect(intents("stop there")).toEqual(["hold"]);
    expect(intents("stop them")).toEqual([]);
    expect(intents("build near the spawn to stop them early")).toEqual(["defend"]);
  });

  it("does not start a patrol when asked to stop it", () => {
    for (const t of ["stop patrol", "stop the patrol", "end the patrol", "cancel patrol"]) {
      expect(keys(t), t).toEqual(["hold"]);
      expect(ruleParse(t, worldOf(g)), t).toEqual({ kind: "hold" });
    }
    expect(keys("patrol the path")).toEqual(["patrol"]);
  });
});

describe("sentences with a lead-in and with abbreviations", () => {
  it("keeps a lead-in with the command that follows it", () => {
    expect(splitCommands("Okay, go to Charlie")).toEqual(["Okay go to Charlie"]);
    expect(splitCommands("Yes, build at Alpha. Then go left.")).toEqual(["Yes build at Alpha", "go left"]);
    expect(splitCommands("Alpha, go there")).toEqual(["Alpha go there"]);
    expect(splitCommands("Okay, thank you.")).toEqual(["Okay thank you"]);
  });

  it("does not cut a sentence after 'no.' as in 'tower no. 2'", () => {
    expect(splitCommands("sell tower no. 2")).toEqual(["sell tower no. 2"]);
    expect(slotNumber("sell tower no. 2")).toBe(2);
    expect(splitCommands("go left. Pause.")).toEqual(["go left", "Pause"]);
  });

  it("does not hear 'no one' as a tower number", () => {
    expect(cleanTranscript("there is no one here")).toBe("there is no one here");
    expect(slotNumber("no one is coming")).toBeNull();
    expect(slotNumber("no. 3")).toBe(3);
    expect(slotNumber("no 3")).toBe(3);
  });
});

describe("the spoken test cases, checked without the models", () => {
  const states = CASES.map((c) => ({ c, g: buildState(SCENARIOS[c.scenario]) }));

  it("keep the command they expect among the options the gate leaves", () => {
    for (const { c, g } of states) {
      const opts = gateOptions([...extraOptions(c.text), ...actionOptions(g)], c.text);
      const want = c.expect;
      const kept = want.kind === "exact"
        ? opts.some((o) => JSON.stringify(o.value) === JSON.stringify(want.command))
        : opts.some((o) => o.value === "auto" || o.value?.kind === "build" || o.value?.kind === "upgrade");
      expect(kept, `${c.scenario}: "${c.text}" -> ${opts.map((o) => o.key).join(", ")}`).toBe(true);
    }
  });

  it("are all understood by the keyword fallback too", () => {
    for (const { c, g } of states) expect(satisfies(g, ruleParse(c.text, worldOf(g)), c.expect), `${c.scenario}: "${c.text}"`).toBeNull();
  });
});

describe("what the hero says about a refusal", () => {
  it("calls an occupied pad occupied, whichever way the message words it", () => {
    expect(refusalCallout("Pad 3 Charlie already has a tower.")).toBe("Negative. Pad occupied.");
    expect(refusalCallout('Pad Charlie already has tower 3. Say "upgrade tower 3" to upgrade it.')).toBe("Negative. Pad occupied.");
    expect(refusalCallout("There are no enemies to attack.")).toBe("Negative. No such target.");
    expect(refusalCallout("The base has fallen.")).toBe("Negative.");
  });
});
