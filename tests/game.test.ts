import { describe, expect, it } from "vitest";
import { generateMap, cellKey } from "../src/game/map";
import { Game } from "../src/game/sim";
import { ruleParse } from "../src/voice/rules";
import { PAD_NAMES } from "../src/game/map";
import { actionOptions } from "../src/voice/context";
import { cleanTranscript, gateOptions, intents, intentOf, slotNumber, spokenNumbers } from "../src/voice/verbs";
import { settle } from "../src/voice/decide";
import { COSTS } from "../src/game/sim";

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

describe("option gate details", () => {
  const seven = Array.from({ length: 200 }, (_, i) => i).find((i) => generateMap(i).pads.length === 7)!;
  const g = new Game(generateMap(seven));
  g.hero.pos = { x: 9, y: 5.5 };
  for (const p of g.map.pads) g.addTower(p.name);
  g.enemies.push({ id: 1, kind: "grunt", d: 5, hp: 10, maxHp: 10, speed: 1, reward: 1 });
  const all = actionOptions(g);
  const pads = (text: string) => new Set(gateOptions(all, text).flatMap((o) => (o.value && o.value !== "auto" && "pad" in o.value ? [o.value.pad] : [])));

  it("never offers more than Tev1's 24 letters", () => {
    expect(all.length).toBeGreaterThan(24);
    for (const t of ["", "Charlie", "hello there", "go build"]) expect(gateOptions(all, t).length).toBeLessThanOrEqual(24);
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
