import { afterEach, describe, expect, it, vi } from "vitest";
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
