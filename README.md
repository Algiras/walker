# Walker

Command a hero in a tower-defense map with your voice. Speech recognition and command understanding both run in your browser; nothing is sent to a server.

**Play:** https://algiras.github.io/walker/

- **Speech to text:** [Whisper small.en](https://huggingface.co/onnx-community/whisper-small.en) through transformers.js on WebGPU (wasm fallback). One model, chosen for accuracy: see [the comparison](#why-whisper-smallen).
- **Decisions:** Together's [Tev1 0.8B](https://huggingface.co/togethercomputer/Tev1-0.8B-experimental), an open decision model in the spirit of Jev, via the [ONNX export](https://huggingface.co/goldenfox/tev1-0.8b-decision-onnx) on onnxruntime-web (WebGPU). It never writes text: the game lists every legal action as a lettered option and the model's next-token logits pick one. A keyword gate in front of it keeps small-model confusions out ("go" means movement, "build" means defense).
- **Game:** a seeded random map (path plus numbered, named build pads) and a hero you command by voice, buttons or clicks.

Needs a Chromium-based browser with WebGPU for voice. On the first visit a **setup screen** comes before the game: it shows what is already downloaded, downloads and loads the two models (about 1.3 GB once: Whisper small.en about 520 MB, Tev1 about 770 MB, cached afterwards), and only then starts the game, so waves do not run while you wait. You can also start without voice, and reopen the screen later with **Set up voice** (the game pauses while it is open). Without WebGPU the buttons, clicks and typed commands still work through a keyword fallback. `?start=1` skips the screen.

## Controls

Hold **Space** and speak, or use the **Hero** panel, click a pad on the map (build, upgrade, sell, send the hero), or click the ground to send the hero there. `Ctrl/Cmd+Z` undoes, `P` pauses. `?seed=123` pins a map.

| You want | Say something with | Example |
|---|---|---|
| A specific tower | `build` / `upgrade` + a pad name or number | "build a tower at Bravo", "upgrade tower 3" |
| A tower by goal | `defend` / `protect` + `base`, `spawn`, `left` / `right` / `top` / `bottom`, or `where the enemies are` | "defend the base", "build near the spawn to stop them early" |
| The game to choose | `more defense`, `stronger`, `reinforce` with no place | "we need more defense" |
| Sell or remove a tower | `sell` / `remove` / `delete` / `scrap` / `demolish` / `destroy` + a pad or number | "sell tower 3", "delete tower 2" |
| Move the hero | `go to` / `retreat` + a pad, `base` or `spawn`; `go left` / `right` / `up` / `down` | "go to Charlie", "go left" |
| Patrol | `patrol` | "patrol the path" |
| Focus fire | `attack` + `nearest` / `strongest` / `weakest` / `first` / `last`, an enemy number, or its place in line | "attack the strongest one", "attack enemy 3", "attack the last one", "attack the second one" |
| Stop | `stop` / `hold` | "stop, hold position" |
| Fix a mistake | `undo` / `revert` / `take that back` | "undo that" |
| Again | `again` / `repeat` | "do that again" |
| The game | `pause`, `resume`, `speed up`, `next wave` | "pause the game", "call the next wave" |

**Several commands in one sentence.** "Go to Charlie and then build a tower there" is split at *and*, *then*, commas and sentence ends. The first command runs; the next one is only worked out after the first has finished (a walk ends on arrival, an endless order such as an attack mode or a patrol yields after three seconds), so it sees the game as it is by then. If a command is not understood or needs confirming, the rest of the queue is dropped. A piece without a verb ("build at Alpha and Bravo") stays with the command before it. Any new command or button press clears the queue.

Enemies carry a number (1, 2, 3 in spawn order within a wave) on the map; "enemy 3" and a click on an enemy mean the same thing. "First" is the enemy furthest along the path, "last" the one at the back, "second" the second from the front.

**Undo** takes back the most recent change, one step at a time: an order the hero is still carrying out is cancelled, and a finished build, upgrade or sale is reverted (a build or upgrade is fully refunded; a sold tower comes back if you can cover the refund again). **Stop** only cancels what the hero is doing.

### Pads, towers and gold

- Every pad has a number (1, 2, 3, left to right) and a name (Alpha, Bravo, Charlie, in the same order), visible before anything is built. A tower takes its pad's number, so "tower 3", "pad 3" and "Charlie" are the same spot. "Two", "to" and "too" at the end of a phrase are heard as 2.
- Build costs 50, upgrades cost 40 then 70 (maximum level 3), and selling refunds 60% of everything spent on that tower. Enemies drop gold when they die. "You choose" never sells.
- If you cannot afford something, the tower is at maximum level, or there is nothing to sell, the hero shakes and says why. It does not walk off first.
- Each decision shows a short verdict (good, fine, poor) and why, for example selling your only tower while enemies are on the field. It is advice only.

### When the hero is not sure

The confidence is how decisively the best action beats the runner-up, so several near-identical towers sharing the leftover probability do not drag it down.

| Confidence | What happens |
|---|---|
| 70% or more | the hero acts |
| 25% to 70% | the hero shakes and asks "did you mean …? say yes"; "yes" confirms, "no" cancels, it expires after 10 s |
| under 25% | "I did not catch that" |

Also guarded: "build at Charlie" when Charlie already has a tower is refused with a hint, never turned into an upgrade (and the reverse). One action per sentence.

## The hero answers aloud

Like a unit acknowledging an order in Command & Conquer, the hero says what it is about to do in a deep male voice: "Building at Charlie.", "Upgrading tower three.", "Engaging target four.", "Insufficient funds.", "Say again?", and game events such as "Wave two incoming." and "Base under attack." Replies to your orders cut off whatever is playing; game events never interrupt.

The voice is **pre-recorded**, not synthesised in the page: everything the hero can say is a short fixed line (`allLines()` in `src/voice/callouts.ts`: command acknowledgements, refusals, pad names, tower and target numbers, wave numbers). `npm run gen:voice` records each line once with Kokoro (`am_onyx`, the deepest of its male voices), then ffmpeg trims the silence, lowers the pitch about 8%, adds low-end weight, compresses lightly and encodes 64 kbps mono MP3. The 163 files are about 3 MB in `public/voice/`, loaded in the background and played through the Web Audio API. It works with typed and clicked commands too, needs no model and no WebGPU, and a unit test fails if the game can say a line that has no recording. Toggle it with the **Hero voice** button or in the setup screen; the choice is remembered.

## How a command flows

```
Space held → mic (16 kHz) → Whisper small.en → text
           → keyword gate → legal actions in the current state → Tev1 letter pick → Command → game state
```

Speech to text, one decision, then the action: `(state, text) → new state`. The decision prompt is Tev1's native JSON (`state`, `question`, `options` with label, key and description) and lists only transitions that are legal right now. Buttons and map clicks skip the first two steps and go straight to the command.

| Path | What |
|---|---|
| `src/game/` | seeded map generator, simulation (economy, undo, patrol), canvas renderer |
| `src/voice/stt.ts` | Whisper small.en loader |
| `src/voice/tev1.ts`, `llm.ts`, `decide.ts`, `context.ts` | Tev1 runner, the single-pass decider, legal-action list |
| `src/voice/verbs.ts`, `guard.ts`, `fuzzy.ts` | keyword gate (verbs, named pad, area and goal words), transcript fixes such as cell to sell, build/upgrade guard |
| `src/voice/rules.ts` | keyword fallback before the models load |
| `src/voice/mic.ts` | capture, push-to-talk and a simple energy VAD |
| `src/voice/callouts.ts`, `hero-voice.ts` | what the hero says, the full list of recorded lines, and the Web Audio player |

## Tests

```bash
npm install
npm test            # unit tests: map, simulation, economy, undo, keyword rules and gate
npm run gen:audio   # records spoken test fixtures with Kokoro (cached; only missing clips are synthesised)
npm run gen:voice   # records the hero's lines to public/voice/ (needs ffmpeg; cached, --force to redo)
npm run test:e2e    # spoken fixtures → Whisper → Tev1 → expected command in a given game state
npm run bench:llm   # decision accuracy on the ground-truth text
```

The end-to-end cases live in `tests/e2e/scenarios.ts`: named game states (seed, towers, gold, wave progress, hero position) and a phrase with the expected outcome. The audio fixtures in `tests/fixtures/audio/` are committed. The first e2e run downloads about 1.3 GB into the gitignored `.cache/`.

## Why Whisper small.en

Compared on the spoken fixtures with synthetic noise added (word error rate, Node CPU):

| Model | Download | clean | 15 dB | 5 dB | per clip |
|---|---|---|---|---|---|
| Whisper small.en (used) | ~250 MB q8 | 2.5% | 0.6% | **1.3%** | ~1 s CPU |
| Parakeet TDT 0.6B v2 int8 | 661 MB | 1.3% | 1.3% | 2.5% | ~100 ms |
| Whisper base.en | ~150 MB | 3.2% | 2.5% | 5.1% | ~350 ms |
| Parakeet Redux | 440 MB | 2.5% | 2.5% | 8.2% | ~150 ms |
| Moonshine base | 63 MB | 1.3% | 1.9% | 8.2% | ~65 ms |

The clips are clean TTS plus synthetic noise, so this is a relative ranking, not a field measurement. Whisper small.en held up best in noise and has a proven WebGPU path in the browser. Parakeet v2 is faster, but its int8 encoder is unlikely to run on WebGPU.

## Deploy

```bash
npm run deploy      # runs the tests, builds, and publishes dist/ to the gh-pages branch
```

GitHub Pages serves the `gh-pages` branch. Pages cannot send COOP/COEP headers, so wasm runs single-threaded there; the WebGPU path is unaffected.

## Design

The UI follows Wix Design System conventions: Wix Madefor type (self-hosted, no font requests to third parties), the WDS blue and neutral palette behind named tokens, 6px spacing steps, 8px cards, pill buttons, and light and dark themes. Loading uses skeleton placeholders instead of spinners: each model is a skeleton track that fills as it downloads, and the command panel shows skeleton lines while a command is being worked out (only if it takes noticeably long). Skeletons stay still for people who prefer reduced motion.

## Credits and licenses

Code: MIT. Models are fetched from the Hugging Face Hub at runtime and are not part of this repository:

- Whisper small.en: MIT, OpenAI. ONNX conversion by [onnx-community](https://huggingface.co/onnx-community/whisper-small.en).
- Tev1 0.8B: by Together AI on Qwen3.5-0.8B (Apache-2.0). The fine-tune's own license is still being finalised upstream; check [the model card](https://huggingface.co/togethercomputer/Tev1-0.8B-experimental) before redistributing. ONNX export by [goldenfox](https://huggingface.co/goldenfox/tev1-0.8b-decision-onnx).
- Kokoro-82M (Apache-2.0) recorded the test fixtures and the hero's voice lines at build time; it is not loaded by the page.
- Wix Madefor Text and Display: SIL Open Font License 1.1, Wix.com, via Google Fonts (Latin subsets, self-hosted in `public/fonts/`).
