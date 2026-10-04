import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { generateMap } from "../src/game/map";
import { Game } from "../src/game/sim";
import { boardSize, nearestWithin } from "../src/ui/layout";
import { menuItems, placeMenu } from "../src/ui/pad-menu";
import { HeroVoice } from "../src/voice/hero-voice";
import { Mic } from "../src/voice/mic";

const BLOCK_MS = 8;

function rig() {
  let t = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => t);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const mic = new Mic();
  const heard: number[] = [];
  mic.onUtterance = (u) => heard.push(Math.round((u.pcm.length / 16000) * 10) / 10);
  const feed = (level: number, ms: number) => {
    for (let i = 0; i < ms / BLOCK_MS; i++) {
      t += BLOCK_MS;
      mic.feed(new Float32Array(128).fill(level));
    }
  };
  const wait = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
  return { mic, heard, feed, wait };
}

const SPEECH = 0.1;
const QUIET = 0.001;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("microphone: auto-detect", () => {
  it("captures a phrase once the speaker stops", () => {
    const { mic, heard, feed } = rig();
    mic.mode = "vad";
    feed(QUIET, 300);
    feed(SPEECH, 800);
    expect(heard).toEqual([]);
    feed(QUIET, 500);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeGreaterThan(0.8);
  });

  it("does not hear the hero while it speaks, nor for a moment afterwards", () => {
    const { mic, heard, feed } = rig();
    let speaking = true;
    mic.mode = "vad";
    mic.ignoreInput = () => speaking;
    feed(SPEECH, 1000);
    speaking = false;
    feed(SPEECH, 300);
    feed(QUIET, 600);
    expect(heard).toEqual([]);
    expect(mic.listening).toBe(false);
  });

  it("hears the player again once the hero has finished", () => {
    const { mic, heard, feed } = rig();
    let speaking = true;
    mic.mode = "vad";
    mic.ignoreInput = () => speaking;
    feed(SPEECH, 1000);
    speaking = false;
    feed(QUIET, 500);
    feed(SPEECH, 700);
    feed(QUIET, 500);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeLessThan(1.2);
  });

  it("drops a phrase in progress when the hero starts to speak over it", () => {
    const { mic, heard, feed } = rig();
    let speaking = false;
    mic.mode = "vad";
    mic.ignoreInput = () => speaking;
    feed(SPEECH, 400);
    expect(mic.listening).toBe(true);
    speaking = true;
    feed(SPEECH, 200);
    speaking = false;
    feed(QUIET, 1000);
    expect(heard).toEqual([]);
  });

  it("ignores the hero in push-to-talk, where the player decides when to talk", () => {
    const { mic, heard, feed, wait } = rig();
    mic.ignoreInput = () => true;
    mic.press();
    feed(SPEECH, 600);
    mic.release();
    wait(200);
    expect(heard).toHaveLength(1);
  });
});

describe("microphone: push-to-talk", () => {
  it("sends what was said between press and release", () => {
    const { mic, heard, feed, wait } = rig();
    mic.press();
    feed(SPEECH, 1000);
    mic.release();
    expect(heard).toEqual([]);
    wait(150);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeGreaterThanOrEqual(1);
  });

  it("drops a tap too short to be speech", () => {
    const { mic, heard, feed, wait } = rig();
    mic.press();
    feed(SPEECH, 80);
    mic.release();
    wait(150);
    expect(heard).toEqual([]);
  });

  it("does not lose the first phrase when the key is pressed again straight away", () => {
    const { mic, heard, feed, wait } = rig();
    mic.press();
    feed(SPEECH, 600);
    mic.release();
    wait(40);
    mic.press();
    expect(heard).toHaveLength(1);
    feed(SPEECH, 600);
    mic.release();
    wait(150);
    expect(heard).toHaveLength(2);
    expect(heard[1]).toBeLessThan(0.9);
  });

  it("stops recording after a while, so a stuck key cannot fill the memory", () => {
    const { mic, heard, feed, wait } = rig();
    mic.press();
    feed(SPEECH, 20000);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toBeLessThanOrEqual(15.1);
    expect(mic.listening).toBe(false);
    mic.release();
    wait(150);
    expect(heard).toHaveLength(1);
  });

  it("starts clean after switching modes mid-press", () => {
    const { mic, heard, feed, wait } = rig();
    mic.press();
    mic.mode = "vad";
    mic.mode = "ptt";
    expect(mic.listening).toBe(false);
    mic.press();
    feed(SPEECH, 600);
    mic.release();
    wait(150);
    expect(heard).toHaveLength(1);
  });
});

describe("pad menu", () => {
  const fresh = () => new Game(generateMap(7));

  it("offers to build on an empty pad and to send the hero there", () => {
    const g = fresh();
    const items = menuItems(g, g.map.pads[0].name);
    expect(items.map((i) => [i.label, i.price, i.blocked])).toEqual([["Build tower", "50", null], ["Send hero here", "", null]]);
  });

  it("says why a tower cannot be built", () => {
    const g = fresh();
    g.gold = 30;
    expect(menuItems(g, g.map.pads[0].name)[0].blocked).toMatch(/not enough gold/i);
  });

  it("offers an upgrade and a sale on a built pad, with what they cost and return", () => {
    const g = fresh();
    const pad = g.map.pads[1].name;
    g.addTower(pad);
    const items = menuItems(g, pad);
    expect(items.map((i) => [i.label, i.price])).toEqual([["Upgrade to level 2", "40"], ["Sell / remove tower", "+30"], ["Send hero here", ""]]);
    expect(items.every((i) => i.blocked === null)).toBe(true);
  });

  it("blocks the upgrade of a tower that is at its top level", () => {
    const g = fresh();
    const pad = g.map.pads[1].name;
    g.addTower(pad, 3);
    const [upgrade] = menuItems(g, pad);
    expect(upgrade.label).toBe("Upgrade (max level)");
    expect(upgrade.blocked).toMatch(/maximum level/i);
  });
});

describe("pad menu placement", () => {
  const menu = { w: 200, h: 100 };
  const board = { w: 800, h: 500 };

  it("sits to the right of the pad, centred on it", () => {
    expect(placeMenu({ x: 100, y: 250 }, menu, board, 30)).toEqual({ left: 130, top: 200 });
  });

  it("moves to the left of the pad when there is no room on the right", () => {
    expect(placeMenu({ x: 700, y: 250 }, menu, board, 30)).toEqual({ left: 470, top: 200 });
  });

  it("stays inside the board at the top and the bottom", () => {
    expect(placeMenu({ x: 100, y: 10 }, menu, board, 30).top).toBe(0);
    expect(placeMenu({ x: 100, y: 495 }, menu, board, 30).top).toBe(400);
  });

  it("keeps the corner on the board when the menu is bigger than the board", () => {
    expect(placeMenu({ x: 50, y: 50 }, { w: 400, h: 300 }, { w: 300, h: 200 }, 20)).toEqual({ left: 0, top: 0 });
  });
});

describe("board size", () => {
  const aspect = 18 / 11;

  it("is limited by the height when the stage is wide", () => {
    const { w, h } = boardSize({ stageW: 964, stageH: 550, chrome: 78, aspect, stacked: false });
    expect(h).toBeLessThanOrEqual(550 - 78);
    expect(w).toBeLessThanOrEqual(964);
    expect(Math.abs(w / h - aspect)).toBeLessThan(0.02);
  });

  it("is limited by the width when the stage is narrow", () => {
    expect(boardSize({ stageW: 600, stageH: 700, chrome: 78, aspect, stacked: false }).w).toBe(600);
  });

  it("never gets smaller than the minimum", () => {
    expect(boardSize({ stageW: 600, stageH: 100, chrome: 78, aspect, stacked: false }).w).toBe(240);
  });

  it("follows the width alone when the page is one column", () => {
    expect(boardSize({ stageW: 354, stageH: 100, chrome: 78, aspect, stacked: true }).w).toBe(354);
  });
});

describe("hit targets", () => {
  const dots = [{ id: "a", x: 1, y: 1 }, { id: "b", x: 2, y: 1 }, { id: "c", x: 9, y: 9 }];
  const at = (d: { x: number; y: number }) => d;

  it("picks the closest item inside the radius", () => {
    expect(nearestWithin(dots, at, { x: 1.8, y: 1 }, 1)?.id).toBe("b");
    expect(nearestWithin(dots, at, { x: 1.2, y: 1 }, 1)?.id).toBe("a");
  });

  it("finds nothing outside the radius, or in an empty list", () => {
    expect(nearestWithin(dots, at, { x: 5, y: 5 }, 1)).toBeUndefined();
    expect(nearestWithin([], at, { x: 1, y: 1 }, 1)).toBeUndefined();
  });
});

describe("colour contrast", () => {
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

  const block = (after: string) => {
    const start = css.indexOf("{", css.indexOf(after));
    for (let i = start, depth = 0; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start + 1, i);
    }
    throw new Error(`no block after ${after}`);
  };
  const tokens = (body: string) => Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const light = tokens(block(":root {"));
  const dark = { ...light, ...tokens(block(':root:not([data-theme="light"])')) };

  const resolve = (all: Record<string, string>, name: string): string => {
    const v = all[name];
    const ref = v.match(/^var\(--([\w-]+)\)$/);
    return ref ? resolve(all, ref[1]) : v;
  };
  const channel = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const text: [string, string][] = [
    ["ink", "card"], ["ink", "bg"],
    ["muted", "card"], ["muted", "bg"], ["muted", "accent-soft"],
    ["accent-text", "card"], ["accent-text", "bg"], ["accent-text", "accent-soft"],
    ["accent-text-hover", "card"],
    ["accent-ink", "accent"], ["accent-ink", "accent-hover"],
    ["ok-text", "card"],
  ];
  const parts: [string, string][] = [["ring", "card"], ["ring", "bg"]];

  for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
    it(`keeps text readable (4.5:1) in the ${name} theme`, () => {
      for (const [fg, bg] of text) expect(ratio(resolve(theme, fg), resolve(theme, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it(`keeps the focus ring visible (3:1) in the ${name} theme`, () => {
      for (const [fg, bg] of parts) expect(ratio(resolve(theme, fg), resolve(theme, bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("hero voice", () => {
  const LINE = "Holding position.";
  const sources: { started: boolean; stopped: boolean }[] = [];

  function setup(state: "running" | "suspended" = "running") {
    sources.length = 0;
    class Source {
      buffer: { duration: number } | null = null;
      onended: (() => void) | null = null;
      started = false;
      stopped = false;
      connect() {}
      start() {
        this.started = true;
        setTimeout(() => this.onended?.(), (this.buffer?.duration ?? 0) * 1000);
      }
      stop() {
        this.stopped = true;
        queueMicrotask(() => this.onended?.());
      }
      constructor() { sources.push(this); }
    }
    class Context {
      state = state;
      destination = {};
      createGain() { return { gain: { value: 0 }, connect: (n: unknown) => n }; }
      createDynamicsCompressor() { return { threshold: { value: 0 }, ratio: { value: 0 }, connect: (n: unknown) => n }; }
      createBufferSource() { return new Source(); }
      decodeAudioData() { return Promise.resolve({ duration: 0.5 }); }
      resume() { return state === "suspended" ? new Promise<void>(() => {}) : Promise.resolve(); }
    }
    vi.useFakeTimers();
    vi.stubGlobal("document", { baseURI: "http://localhost/" });
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("fetch", async (url: URL) => ({
      ok: true,
      json: async () => ({ lines: { [LINE]: "line.mp3" }, version: "1" }),
      arrayBuffer: async () => new ArrayBuffer(8),
      url,
    }));
    return new HeroVoice();
  }

  const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is speaking from the moment a line is accepted until it has finished", async () => {
    const hero = setup();
    expect(hero.speaking).toBe(false);
    hero.say(LINE);
    expect(hero.speaking).toBe(true);
    await pass(300);
    expect(sources[0].started).toBe(true);
    expect(hero.speaking).toBe(true);
    await pass(500);
    expect(hero.speaking).toBe(false);
  });

  it("holds a reply back while the player is talking, and is not speaking meanwhile", async () => {
    const hero = setup();
    let talking = true;
    hero.holdWhile = () => talking;
    hero.say(LINE);
    await pass(1000);
    expect(sources).toHaveLength(0);
    expect(hero.speaking).toBe(false);
    talking = false;
    await pass(200);
    expect(sources[0].started).toBe(true);
    expect(hero.speaking).toBe(true);
  });

  it("drops a game event instead of speaking over the player", async () => {
    const hero = setup();
    hero.holdWhile = () => true;
    hero.say(LINE, 1);
    await pass(1000);
    expect(sources).toHaveLength(0);
    expect(hero.speaking).toBe(false);
  });

  it("gives up waiting for a player who never stops, rather than staying silent for ever", async () => {
    const hero = setup();
    hero.holdWhile = () => true;
    hero.say(LINE);
    await pass(7000);
    expect(sources[0]?.started).toBe(true);
  });

  it("does not start a line on a suspended audio context, and is not left speaking", async () => {
    const hero = setup("suspended");
    hero.say(LINE);
    await pass(2000);
    expect(sources).toHaveLength(0);
    expect(hero.speaking).toBe(false);
  });

  it("says nothing once switched off", async () => {
    const hero = setup();
    hero.setEnabled(false);
    hero.say(LINE);
    expect(hero.speaking).toBe(false);
    await pass(1000);
    expect(sources).toHaveLength(0);
  });
});
