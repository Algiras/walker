# Walker

Talk to a hero in a tower-defense map. Speech recognition and command understanding both run in your browser; nothing is sent to a server.

- **Speech to text:** [Parakeet Redux](https://huggingface.co/moondream/parakeet-redux), a 1.58-bit (ternary) version of NVIDIA's `parakeet-tdt-0.6b-v3`, via the [ONNX export](https://huggingface.co/eschmidbauer/parakeet-redux-onnx) on onnxruntime-web (encoder on WebGPU, wasm fallback).
- **Decisions:** a small open instruct model (default [SmolLM2-360M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct), q4f16) through transformers.js. It never generates text. Each step is a calibrated *pick one* over a fixed option list, scored from the next-token logits of the option letters (the same idea as Jev). Low confidence means "say again", not a guess.
- **Game:** a seeded random map (path plus named build pads) and a hero you command by voice.

## Play

```bash
npm install
npm run dev
```

Open the page, press **Load voice models** (about 700 MB on first load, cached afterwards), then hold **Space** and speak:

- "build a tower at Bravo"
- "upgrade Charlie"
- "go back to base"
- "attack the strongest one" / "nearest" / "weakest" / "first"
- "stop"

There is also a text box that goes through the same decision step, and a keyword fallback is used until the LLM has loaded. `?seed=123` pins a map. `?llm=onnx-community/Qwen2.5-0.5B-Instruct` swaps the decision model.

Needs a Chromium-based browser with WebGPU for a comfortable speed. On other browsers it falls back to wasm, which is much slower.

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

For build and upgrade the model sees one legal action per pad (build if empty, upgrade if occupied), each annotated with path coverage, how far along the path it is, enemies in range now and cost, plus an explicit "choose the best spot for me" option that the game resolves with a heuristic.

## How a command flows

```
Space held → mic (16 kHz) → Parakeet (preprocessor → encoder → TDT decode loop)
           → text → action pick → (place | enemy-focus pick) → Command → hero order
```

Each pick prompt lists the options with live game context (pad names, where they are, which have towers). The decider returns the winning option and its probability.

## Layout

| Path | What |
|---|---|
| `src/game/` | seeded map generator, simulation, canvas renderer |
| `src/voice/asr.ts` | Parakeet Redux ONNX pipeline and TDT greedy decoder |
| `src/voice/llm.ts`, `decide.ts` | pick-one scoring and the two-step decider |
| `src/voice/rules.ts` | keyword fallback, also a test oracle |
| `src/voice/mic.ts` | capture, push-to-talk and simple energy VAD |

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on push to `main`. Pages cannot send COOP/COEP headers, so wasm runs single-threaded there; the WebGPU path is unaffected.

## Credits and licenses

Code: MIT. Models are fetched from the Hugging Face Hub at runtime and are not part of this repository:

- Parakeet Redux: CC-BY-4.0, by [moondream](https://huggingface.co/moondream/parakeet-redux), derived from [NVIDIA parakeet-tdt-0.6b-v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). ONNX export by [eschmidbauer](https://huggingface.co/eschmidbauer/parakeet-redux-onnx).
- SmolLM2-360M-Instruct: Apache-2.0, Hugging Face.
