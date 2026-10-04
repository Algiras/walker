# Walker

Talk to a hero in a tower-defense map. Speech recognition and command understanding both run in your browser; nothing is sent to a server.

- **Speech to text:** [Parakeet Redux](https://huggingface.co/moondream/parakeet-redux), a 1.58-bit (ternary) version of NVIDIA's `parakeet-tdt-0.6b-v3`, via the [ONNX export](https://huggingface.co/eschmidbauer/parakeet-redux-onnx) on onnxruntime-web (encoder on WebGPU, wasm fallback).
- **Decisions:** Together's [Tev1 0.8B](https://huggingface.co/togethercomputer/Tev1-0.8B-experimental), an open decision model in the spirit of Jev, via the [ONNX export](https://huggingface.co/goldenfox/tev1-0.8b-decision-onnx) on onnxruntime-web (WebGPU). It never generates text: the game lists every legal action as a lettered option and the model's next-token logits pick one. Low confidence means "say again", not a guess. A keyword gate in front of it ("go" means movement, "build" means defense) keeps small-model confusions out.
- **Game:** a seeded random map (path plus named build pads) and a hero you command by voice.

## Play

```bash
npm install
npm run dev
```

Open the page, press **Load voice models** (about 1.3 GB on first load, cached afterwards), then hold **Space** and speak:

- "build a tower at Bravo"
- "upgrade Charlie"
- "go back to base"
- "attack the strongest one" / "nearest" / "weakest" / "first"
- "stop"

There is also a text box that goes through the same decision step, and a keyword fallback is used until the models have loaded. `?seed=123` pins a map.

Needs a Chromium-based browser with WebGPU. Without it the decision model is unavailable and the keyword fallback is used.

## What to say

The decision step handles named pads, goals and "you choose". Keywords carry the decision; the page's **Try saying** card shows live examples for the current map.

| You want | Say something with | Example |
|---|---|---|
| A specific tower | `build` / `upgrade` + a pad name | "build a tower at Bravo" |
| A tower by goal | `defend` / `protect` + `base`, `spawn`, `left`/`right`/`top`/`bottom`, or `where the enemies are` | "defend the base", "stop them early near the spawn" |
| The game to choose | `more defense`, `stronger`, `reinforce` with no place | "we need more defense" |
| Move the hero | `go to` / `retreat` + a pad, `base` or `spawn` | "go to Charlie" |
| Focus fire | `attack` + `nearest` / `strongest` / `weakest` / `first` | "attack the strongest one" |
| Stop | `stop` / `hold` | "stop, hold position" |
| Sell a tower | `sell` / `scrap` / `demolish` / `destroy` + a pad or number | "sell tower 3" |

For build and upgrade the model sees one legal action per pad (build if empty, upgrade if occupied), each annotated with path coverage, how far along the path it is, enemies in range now and cost, plus an explicit "choose the best spot for me" option that the game resolves with a heuristic.

## Pads, towers and gold

- Every build pad has a number (1, 2, 3, left to right) and a name (Alpha, Bravo, Charlie, in the same order), visible before anything is built. A tower takes its pad's number, so "tower 3", "pad 3" and "Charlie" are the same spot. "Two", "to" and "too" at the end of a phrase are heard as 2.
- Build costs 50, upgrades cost 40 then 70 (maximum level 3), and selling refunds 60% of everything spent on that tower. Enemies drop gold when they die. "Sell" is never picked by "you choose".
- If you cannot afford something, the tower is already at maximum level, or there is nothing to sell, the hero shakes and says why. It does not walk off first.
- Each decision is shown with a short verdict (good, fine, poor) and why, for example selling your only tower while enemies are on the field. It is advice only.

## When the hero is not sure

The confidence is how decisively the best action beats the runner-up (so several near-identical towers sharing the leftover probability do not drag it down).

| Confidence | What happens |
|---|---|
| 70% or more | the hero acts |
| 25% to 70% | the hero shakes and asks "did you mean …? say yes"; "yes" confirms, "no" cancels, it expires after 10 s |
| under 25% | "I did not catch that" |

Also guarded: saying "build at Charlie" when Charlie already has a tower is refused with a hint, never turned into an upgrade (and the reverse). One action per sentence.

## How a command flows

```
Space held → mic (16 kHz) → Parakeet (preprocessor → encoder → TDT decode loop) → text
           → keyword gate → legal actions in the current state → Tev1 letter pick → Command → game state
```

Speech to text, one decision, then the action: `(state, text) → new state`. The decision prompt is Tev1's native JSON (`state`, `question`, `options` with label, key and description) and lists only transitions that are legal right now.

## Layout

| Path | What |
|---|---|
| `src/game/` | seeded map generator, simulation, canvas renderer |
| `src/voice/asr.ts` | Parakeet Redux ONNX pipeline and TDT greedy decoder |
| `src/voice/tev1.ts`, `llm.ts`, `decide.ts`, `context.ts` | Tev1 runner, the single-pass decider, legal-action list |
| `src/voice/verbs.ts`, `guard.ts`, `fuzzy.ts` | keyword gate (verbs, named pad, area and goal words), transcript fixes such as cell to sell, build/upgrade guard |
| `src/voice/rules.ts` | keyword fallback before the models load |
| `src/voice/mic.ts` | capture, push-to-talk and simple energy VAD |

## Tests

```bash
npm test            # unit tests: map, simulation, keyword rules and gate
npm run gen:audio   # records spoken fixtures with Kokoro (cached; only missing clips are synthesised)
npm run test:e2e    # spoken fixtures → Parakeet → Tev1 → expected command in a given game state
npm run bench:llm   # decision accuracy on the ground-truth text
npm run bench:stt   # compares speech recognizers, clean and noisy
```

The end-to-end cases live in `tests/e2e/scenarios.ts`: named game states (seed, towers, gold, wave progress, hero position) and a phrase with the expected outcome. Audio fixtures in `tests/fixtures/audio/` are committed. The first e2e run downloads about 1.3 GB into the gitignored `.cache/`.

## Speech recognizer comparison

`npm run bench:stt` on the spoken fixtures with added noise (word error rate, Node CPU):

| Model | Download | clean | 15 dB | 5 dB | per clip |
|---|---|---|---|---|---|
| Parakeet Redux (default) | 440 MB | 2.5% | 2.5% | 8.2% | ~150 ms |
| Parakeet TDT 0.6B v2 int8 | 661 MB | 1.3% | 1.3% | 2.5% | ~100 ms |
| Moonshine base | 63 MB | 1.3% | 1.9% | 8.2% | ~65 ms |
| Whisper base.en | ~150 MB | 3.2% | 2.5% | 5.1% | ~350 ms |
| Whisper small.en | ~250 MB | 2.5% | 0.6% | 1.3% | ~1 s |

The clips are clean TTS plus synthetic noise, so treat this as a relative ranking, not a field measurement.

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on push to `main`. Pages cannot send COOP/COEP headers, so wasm runs single-threaded there; the WebGPU path is unaffected.

## Credits and licenses

Code: MIT. Models are fetched from the Hugging Face Hub at runtime and are not part of this repository:

- Parakeet Redux: CC-BY-4.0, by [moondream](https://huggingface.co/moondream/parakeet-redux), derived from [NVIDIA parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). ONNX export by [eschmidbauer](https://huggingface.co/eschmidbauer/parakeet-redux-onnx).
- Tev1 0.8B: by Together AI on Qwen3.5-0.8B (Apache-2.0). The fine-tune's own license is still being finalised upstream; check [the model card](https://huggingface.co/togethercomputer/Tev1-0.8B-experimental) before redistributing. ONNX export by [goldenfox](https://huggingface.co/goldenfox/tev1-0.8b-decision-onnx).
- Kokoro-82M (Apache-2.0) is used only to record the test fixtures.
