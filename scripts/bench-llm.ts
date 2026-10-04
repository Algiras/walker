// Scores decision models on the e2e cases using the ground-truth text, so speech recognition is out of the picture.
import { buildState, CASES, SCENARIOS, satisfies } from "../tests/e2e/scenarios";
import { loadDecider } from "../tests/e2e/node-models";
import { describeCommand } from "../src/game/commands";

const decider = await loadDecider();
let ok = 0, ms = 0;
const misses: string[] = [];
for (const c of CASES) {
  const g = buildState(SCENARIOS[c.scenario]);
  const d = await decider.decide(c.text, g);
  ms += d.ms;
  const why = satisfies(g, d.command, c.expect);
  if (!why) ok++;
  else misses.push(`  ✗ [${c.scenario}] "${c.text}" → ${d.command ? describeCommand(d.command) : "none"} (${d.trace}) ${why}`);
}
console.log(`\n${decider.name}: ${ok}/${CASES.length} correct, ${(ms / CASES.length).toFixed(0)} ms/decision`);
for (const m of misses) console.log(m);
