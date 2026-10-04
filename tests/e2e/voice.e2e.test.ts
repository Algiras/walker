import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { buildState, CASES, fixtureName, SCENARIOS, satisfies, VOICES } from "./scenarios";
import { loadAsr, loadDecider, NodeStt, readWav } from "./node-models";
import { Decider } from "../../src/voice/decide";
import { describeCommand } from "../../src/game/commands";
import { cleanTranscript } from "../../src/voice/verbs";

const AUDIO = new URL("../fixtures/audio/", import.meta.url).pathname;
const words = (t: string) => t.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);

const seen: { text: string; conf: number; status: string }[] = [];
let asr: NodeStt;
let decider: Decider;

beforeAll(async () => {
  [asr, decider] = await Promise.all([loadAsr(), loadDecider()]);
});

afterAll(() => {
  const act = seen.filter((s) => s.status === "act").length;
  console.log(`CONFIDENCE: ${act}/${seen.length} acted at 70% or more, ${seen.filter((s) => s.status === "confirm").length} would ask first`);
  for (const s of seen.filter((s) => s.status !== "act")) console.log(`  ${s.status} ${Math.round(s.conf * 100)}% "${s.text}"`);
});

describe.each(CASES)("$scenario: “$text”", (c) => {
  it.each(VOICES)("spoken by %s becomes the expected command", async (voice) => {
    const t0 = performance.now();
    const heard = { text: await asr.transcribe(readWav(path.join(AUDIO, fixtureName(c.text, voice)))), ms: { total: performance.now() - t0 } };
    const said = new Set(words(c.text));
    const overlap = words(cleanTranscript(heard.text)).filter((w) => said.has(w)).length / said.size;

    const game = buildState(SCENARIOS[c.scenario]);
    const d = await decider.decide(heard.text, game);
    seen.push({ text: c.text, conf: d.confidence, status: d.status });
    console.log(`[${voice}] ${d.status} heard "${heard.text}" (${heard.ms.total.toFixed(0)} ms) → ${d.command ? describeCommand(d.command) : "none"} | ${d.trace} (${d.ms.toFixed(0)} ms)`);

    expect(overlap, `speech recognition heard "${heard.text}"`).toBeGreaterThanOrEqual(0.6);
    expect(satisfies(game, d.command, c.expect), `decision for "${heard.text}": ${d.trace}`).toBeNull();
  });
});
