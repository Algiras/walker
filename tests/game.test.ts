import { describe, expect, it } from "vitest";
import { generateMap, cellKey } from "../src/game/map";
import { Game } from "../src/game/sim";
import { ruleParse } from "../src/voice/rules";
import { PAD_NAMES } from "../src/game/map";
import { actionOptions } from "../src/voice/context";
import { gateOptions, intentOf, towerNumber } from "../src/voice/verbs";

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

describe("tower numbers", () => {
  it("numbers towers in build order and finds them by number", () => {
    const g = new Game(generateMap(7));
    const a = g.addTower(g.map.pads[2].name), b = g.addTower(g.map.pads[0].name);
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(g.towerById(2)?.pad).toBe(g.map.pads[0].name);
    expect(g.candidates().find((c) => "pad" in c.command && c.command.pad === a.pad)?.label).toContain("tower 1");
  });

  it("hears numbers however they are spoken", () => {
    for (const t of ["tower two", "Tower 2.", "number two", "tower #2", "no. 2"]) expect(towerNumber(t)).toBe(2);
    expect(towerNumber("tower of power")).toBeNull();
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
  const pads = { padNames: PAD_NAMES.slice(0, 6), padOfTower: (id: number) => (id === 2 ? "Delta" : undefined), hasTower: (n: string) => n === "Charlie" || n === "Delta", best: (h: { near?: string }) => ({ kind: "build", pad: h.near === "base" ? "Foxtrot" : "Echo" }) as const };
  it.each([
    ["build a tower at bravo", { kind: "build", pad: "Bravo" }],
    ["upgrade charlie", { kind: "upgrade", pad: "Charlie" }],
    ["build at charlie", { kind: "upgrade", pad: "Charlie" }],
    ["we need more defense", { kind: "build", pad: "Echo" }],
    ["defend the base", { kind: "build", pad: "Foxtrot" }],
    ["upgrade tower two", { kind: "upgrade", pad: "Delta" }],
    ["upgrade tower 2", { kind: "upgrade", pad: "Delta" }],
    ["upgrade number two", { kind: "upgrade", pad: "Delta" }],
    ["go to the base", { kind: "move", to: { type: "base" } }],
    ["attack the biggest one", { kind: "attack", mode: "strongest" }],
    ["stop", { kind: "hold" }],
    ["move to Alfa", { kind: "move", to: { type: "pad", name: "Alpha" } }],
  ])("%s", (text, expected) => expect(ruleParse(text, pads)).toEqual(expected));

  it("rejects chatter", () => expect(ruleParse("what a lovely day", pads)).toBeNull());
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
