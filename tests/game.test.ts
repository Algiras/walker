import { describe, expect, it } from "vitest";
import { generateMap, cellKey } from "../src/game/map";
import { Game } from "../src/game/sim";
import { ruleParse } from "../src/voice/rules";
import { PAD_NAMES } from "../src/game/map";

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
  const pads = PAD_NAMES.slice(0, 6);
  it.each([
    ["build a tower at bravo", { kind: "build", pad: "Bravo" }],
    ["upgrade charlie", { kind: "upgrade", pad: "Charlie" }],
    ["go to the base", { kind: "move", to: { type: "base" } }],
    ["attack the biggest one", { kind: "attack", mode: "strongest" }],
    ["stop", { kind: "hold" }],
    ["move to Alfa", { kind: "move", to: { type: "pad", name: "Alpha" } }],
  ])("%s", (text, expected) => expect(ruleParse(text, pads)).toEqual(expected));

  it("rejects chatter", () => expect(ruleParse("what a lovely day", pads)).toBeNull());
});
