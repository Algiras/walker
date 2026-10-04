import { generateMap } from "./game/map";
import { Game, Order } from "./game/sim";
import { render } from "./game/render";
import { Command, describeCommand } from "./game/commands";
import { Mic } from "./voice/mic";
import { loadStt, Stt, sttCached } from "./voice/stt";
import { loadPicker, TEV1_DATA_URL } from "./voice/llm";
import { Decider, PickDecider } from "./voice/decide";
import { RuleDecider } from "./voice/rules";
import { examplesFor, plain } from "./voice/examples";
import { splitCommands } from "./voice/verbs";
import { isCached, Progress } from "./voice/cache";
import { HeroVoice } from "./voice/hero-voice";
import { calloutFor, CONFIRM, eventLine, refusalCallout, warmLines } from "./voice/callouts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
let game: Game;
let decider: Decider = new RuleDecider();
let stt: Stt | null = null;
let mic: Mic | null = null;
let shownLog = 0;
const hero = new HeroVoice();
const sayLine = (line: string | null) => { if (line) hero.say(line, 2); };

function newGame(seed = Math.floor(Math.random() * 1e6)) {
  game = new Game(generateMap(seed));
  $("seed").textContent = String(seed);
  history.replaceState(null, "", `?seed=${seed}`);
  shownLog = 0;
  $("log").innerHTML = "";
  $("banner").hidden = true;
  $("menu").hidden = true;
  pending = null;
  clearQueue();
  game.announce = (e) => hero.say(eventLine(e), 1);
  hero.prefetch(warmLines(game));
  $("decider").textContent = `Decision engine: ${decider.name}`;
  showExamples();
}

function showExamples() {
  const box = $("examples");
  box.innerHTML = "";
  for (const ex of examplesFor(game)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = ex.group;
    btn.innerHTML = ex.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    btn.addEventListener("click", () => void handleText(plain(ex.text), performance.now()));
    box.append(btn);
  }
}

function log(msg: string) {
  const d = document.createElement("div");
  d.textContent = msg;
  $("log").prepend(d);
}

function setTiming(rows: [string, string][]) {
  $("timing").querySelector("tbody")!.innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
}

// --- skeleton while the command is being worked out ---------------------------------------------

let thinkingTimer: number | undefined;

/** Shows skeleton lines in place of the result, but only if the work takes long enough to notice. */
function thinking(on: boolean) {
  clearTimeout(thinkingTimer);
  $("command").setAttribute("aria-busy", String(on));
  if (!on) {
    $("thinking").hidden = true;
    return;
  }
  thinkingTimer = window.setTimeout(() => {
    $("empty").hidden = true;
    $("result").hidden = true;
    $("thinking").hidden = false;
  }, 140);
}

function showResult() {
  $("empty").hidden = true;
  $("thinking").hidden = true;
  $("result").hidden = false;
}

// --- running commands ---------------------------------------------------------------------------

const YES = /^\s*(yes|yeah|yep|yup|confirm|do it|sure|ok|okay|correct|right)\b/i;
const NO = /^\s*(no|nope|cancel|never mind|nevermind|stop that|wrong)\b/i;
let pending: { command: Command; until: number } | null = null;

function advise(c: Command) {
  const a = game.assess(c);
  const el = $("advice");
  el.textContent = a ? `${{ good: "Good move", ok: "Fine", poor: "Poor move" }[a.verdict]}: ${a.note}` : "";
  el.dataset.verdict = a?.verdict ?? "";
}

function run(c: Command) {
  advise(c);
  const line = calloutFor(c, game);
  const out = game.command(c);
  log(out.message);
  sayLine(out.ok ? line : refusalCallout(out.message));
  $("decision").textContent = out.ok ? `${describeCommand(c)}` : out.message;
  return out;
}

/** Commands from the buttons and the map skip the speech and decision steps. */
function press(c: Command) {
  pending = null;
  clearQueue();
  showResult();
  $("heard").textContent = "";
  run(c);
}

// --- several commands in one sentence: do one, then work out the next with the game as it now stands ----

let queue: string[] = [];
let issuedAt = 0;
let working = false;

const showQueue = () => {
  $("queued").textContent = queue.length ? `Next: “${queue[0]}”${queue.length > 1 ? ` and ${queue.length - 1} more` : ""}` : "";
};

function clearQueue() {
  queue = [];
  showQueue();
}

/** An order that never finishes by itself, so the next command should not wait for it. */
const endless = (o: Order) => o.type === "patrol" || (o.type === "attack" && o.mode !== "number" && o.mode !== "rank");

function readyForNext() {
  const o = game.hero.order;
  return o.type === "idle" || (endless(o) && performance.now() - issuedAt > 3000);
}

async function advanceQueue() {
  if (working || !queue.length || !readyForNext()) return;
  const clause = queue.shift()!;
  showQueue();
  working = true;
  try {
    const acted = await interpret(clause, performance.now());
    if (!acted && queue.length) {
      log(`Stopped: not doing “${queue.join(" … ")}”.`);
      clearQueue();
    }
  } finally {
    working = false;
  }
}

/** Decides one clause against the current game and acts on it. Returns whether a command was carried out. */
async function interpret(text: string, t0: number, asrMs?: number): Promise<boolean> {
  thinking(true);
  try {
    const d = await decider.decide(text, game);
    thinking(false);
    showResult();
    $("heard").textContent = `“${text}”`;
    $("advice").textContent = "";
    const pct = `${Math.round(d.confidence * 100)}%`;
    let acted = false;
    if (d.status === "act" && d.command) {
      acted = run(d.command).ok;
      if (acted) issuedAt = performance.now();
      $("decision").textContent = acted ? `${describeCommand(d.command)}  ·  ${d.trace}` : $("decision").textContent;
    } else if (d.status === "confirm" && d.command) {
      pending = { command: d.command, until: Date.now() + 10_000 };
      game.hero.shake = 0.35;
      $("decision").textContent = `${d.note} Did you mean “${describeCommand(d.command)}”? Say yes to confirm.`;
      log(`Not sure (${pct}): ${describeCommand(d.command)}?`);
      sayLine(CONFIRM);
      advise(d.command);
    } else {
      game.hero.shake = 0.6;
      $("decision").textContent = `${d.note ?? "Not understood."}  ·  ${d.trace}`;
      log(d.note ?? "Not understood.");
      sayLine(refusalCallout(d.note ?? "I did not catch that."));
    }
    const rows: [string, string][] = [];
    if (asrMs !== undefined) rows.push(["Speech to text", `${asrMs.toFixed(0)} ms`]);
    rows.push([`Decision (${decider.name})`, `${d.ms.toFixed(0)} ms`]);
    rows.push(["Release to action", `${(performance.now() - t0).toFixed(0)} ms`]);
    setTiming(rows);
    return acted;
  } finally {
    thinking(false);
  }
}

async function handleText(text: string, t0: number, asrMs?: number) {
  if (!text.trim()) {
    showResult();
    $("heard").textContent = "(nothing heard)";
    return;
  }

  if (pending && Date.now() < pending.until) {
    if (YES.test(text)) {
      const c = pending.command;
      pending = null;
      showResult();
      $("heard").textContent = `“${text}”`;
      run(c);
      issuedAt = performance.now();
      $("decision").textContent = `Confirmed: ${describeCommand(c)}`;
      return;
    }
    if (NO.test(text)) {
      pending = null;
      showResult();
      $("heard").textContent = `“${text}”`;
      $("decision").textContent = "Cancelled.";
      return;
    }
  }
  pending = null;
  clearQueue();

  const [first, ...rest] = splitCommands(text);
  working = true;
  try {
    const acted = await interpret(first, t0, asrMs);
    if (rest.length) {
      if (acted) {
        queue = rest;
        showQueue();
      } else {
        log(`Stopped: not doing “${rest.join(" … ")}”.`);
      }
    }
  } finally {
    working = false;
  }
}

async function onUtterance(pcm: Float32Array, endedAt: number) {
  if (!stt) return;
  thinking(true);
  try {
    const r = await stt.transcribe(pcm);
    await handleText(r.text, endedAt, r.ms);
  } finally {
    thinking(false);
  }
}

// --- setting up the voice stack before the game starts ------------------------------------------

type Step = "stt" | "llm";

function stepProgress(step: Step): Progress {
  const li = $(`step-${step}`);
  const state = li.querySelector<HTMLElement>(".step-state")!;
  const track = li.querySelector<HTMLElement>(".sk-track")!;
  const fill = track.querySelector<HTMLElement>("i")!;
  const files = new Map<string, { got: number; total: number }>();
  let best = 0;
  li.classList.remove("cached");
  track.classList.add("skeleton");
  state.textContent = "Starting";
  return (file, got, total) => {
    files.set(file, { got, total: total || got });
    let g = 0, t = 0;
    for (const v of files.values()) { g += v.got; t += v.total; }
    best = Math.max(best, t ? g / t : 0);
    fill.style.width = `${best * 100}%`;
    track.setAttribute("aria-valuenow", String(Math.round(best * 100)));
    state.textContent = `${Math.round(best * 100)}%`;
  };
}

function stepEnd(step: Step, outcome: "done" | "failed", text: string) {
  const li = $(`step-${step}`);
  li.classList.remove("cached");
  li.classList.add(outcome);
  li.querySelector(".sk-track")!.classList.remove("skeleton");
  li.querySelector<HTMLElement>(".step-state")!.textContent = text;
  if (outcome === "done") li.querySelector<HTMLElement>("i")!.style.width = "100%";
}

const setup = $("setup");
const startBtn = $<HTMLButtonElement>("start");
const loadBtn = $<HTMLButtonElement>("load");
let setupOpen = !params.has("start");
let voiceReady = false;
let gameStarted = !setupOpen;
const voiceStatus = (m: string) => ($("status").textContent = m);
const setupNote = (m: string) => ($("setup-note").textContent = m);

function renderSetupButtons() {
  loadBtn.hidden = voiceReady;
  startBtn.textContent = voiceReady ? (gameStarted ? "Back to the game" : "Start game") : gameStarted ? "Back to the game" : "Start without voice";
  startBtn.classList.toggle("primary", voiceReady);
}

async function openSetup() {
  setupOpen = true;
  setup.hidden = false;
  renderSetupButtons();
  if (voiceReady) return;

  const gpu = "gpu" in navigator;
  const [llmHit, sttHit] = await Promise.all([isCached(TEV1_DATA_URL), sttCached()]);
  for (const [step, hit] of [["stt", sttHit], ["llm", llmHit]] as const) {
    const li = $(`step-${step}`);
    if (li.classList.contains("done")) continue;
    li.classList.toggle("cached", hit);
    li.querySelector<HTMLElement>(".step-state")!.textContent = hit ? "Downloaded" : "Not downloaded";
  }
  if (!gpu) {
    loadBtn.disabled = true;
    setupNote("WebGPU is not available in this browser, so voice is off. You can still play with the buttons, the map and typed commands.");
  } else if (sttHit && llmHit) {
    loadBtn.textContent = "Load models";
    setupNote("Both models are already downloaded. Loading takes a few seconds.");
  } else {
    loadBtn.textContent = "Download and load models";
    setupNote(sttHit || llmHit ? "Part of the download is already cached." : "Downloads about 1.3 GB once, then it is cached in this browser.");
  }
  (voiceReady ? startBtn : loadBtn).focus();
}

function closeSetup() {
  setupOpen = false;
  gameStarted = true;
  setup.hidden = true;
  canvas.focus();
}

startBtn.addEventListener("click", closeSetup);
$("setupOpen").addEventListener("click", () => void openSetup());

loadBtn.addEventListener("click", async () => {
  loadBtn.disabled = true;
  loadBtn.textContent = "Loading…";
  startBtn.disabled = true;
  let step: Step = "stt";
  try {
    setupNote("Downloading and loading. The game is waiting for you.");
    stt = await loadStt(stepProgress("stt"), log);
    stepEnd("stt", "done", stt.device);

    step = "llm";
    decider = new PickDecider("Tev1 0.8B", await loadPicker(stepProgress("llm")));
    stepEnd("llm", "done", "webgpu");
    $("decider").textContent = `Decision engine: ${decider.name}`;
    voiceReady = true;

    try {
      mic = await Mic.start();
      mic.onUtterance = (u) => onUtterance(u.pcm, u.endedAt);
      mic.onLevel = (rms, active) => {
        $("level").style.width = `${Math.min(100, rms * 600)}%`;
        document.querySelector(".meter")!.classList.toggle("live", active);
      };
      document.querySelector<HTMLElement>(".meter")!.hidden = false;
      $<HTMLInputElement>("vad").addEventListener("change", (e) => {
        mic!.mode = (e.target as HTMLInputElement).checked ? "vad" : "ptt";
      });
      voiceStatus("Ready. Hold Space and speak.");
      setupNote("Ready. Hold Space and speak once the game starts.");
    } catch {
      voiceStatus("Models ready, but the microphone is unavailable. You can still type commands.");
      setupNote("Models are ready, but the microphone is unavailable. You can still type commands.");
    }
  } catch (e) {
    stepEnd(step, "failed", "Failed");
    setupNote(`Failed: ${(e as Error).message}`);
    loadBtn.disabled = false;
    loadBtn.textContent = "Try again";
  } finally {
    startBtn.disabled = false;
    renderSetupButtons();
    if (voiceReady) startBtn.focus();
  }
});

// --- the hero's own voice: pre-recorded lines, switched on by the first click or key press -------

const wantVoice = $<HTMLInputElement>("want-voice");
const heroToggle = $<HTMLButtonElement>("heroVoice");
const showHeroVoice = () => {
  wantVoice.checked = hero.enabled;
  heroToggle.textContent = hero.enabled ? "🔊 Hero voice" : "🔇 Hero voice";
  heroToggle.classList.toggle("on", hero.enabled);
};
const setHeroVoice = (on: boolean) => {
  hero.setEnabled(on);
  showHeroVoice();
  if (on) {
    hero.unlock();
    hero.say("Standing by.", 2);
  }
};
wantVoice.addEventListener("change", () => setHeroVoice(wantVoice.checked));
heroToggle.addEventListener("click", () => setHeroVoice(!hero.enabled));
showHeroVoice();
const unlockAudio = () => {
  hero.unlock();
  hero.prefetch(warmLines(game));
};
addEventListener("pointerdown", unlockAudio, { once: true });
addEventListener("keydown", unlockAudio, { once: true });

// --- hero buttons, map clicks, keyboard ---------------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>("#controls [data-cmd]")) {
  b.addEventListener("click", () => press(JSON.parse(b.dataset.cmd!)));
}
$("pause").addEventListener("click", () => press({ kind: game.paused ? "resume" : "pause" }));
$("speed").addEventListener("click", () => press({ kind: "speed", fast: game.speed === 1 }));

const menu = $("menu");
const closeMenu = () => (menu.hidden = true);

function openPadMenu(padName: string, px: number, py: number) {
  const pad = game.padByName(padName)!;
  const t = game.towerAt(padName);
  const items: { label: string; cmd: Command }[] = [];
  if (!t) items.push({ label: "Build tower", cmd: { kind: "build", pad: padName } });
  else {
    const up = game.upgradeCost(t);
    items.push({ label: up === null ? "Upgrade (max level)" : `Upgrade to level ${t.level + 1}`, cmd: { kind: "upgrade", pad: padName } });
    items.push({ label: `Sell / remove tower`, cmd: { kind: "sell", pad: padName } });
  }
  items.push({ label: "Send hero here", cmd: { kind: "move", to: { type: "pad", name: padName } } });

  menu.innerHTML = `<div class="menu-title">Pad ${pad.number} ${pad.name}${t ? ` · tower ${t.id}, level ${t.level}` : ""}</div>`;
  for (const it of items) {
    const b = document.createElement("button");
    const no = game.refusal(it.cmd);
    const price = it.cmd.kind === "build" ? "50" : it.cmd.kind === "upgrade" && t && game.upgradeCost(t) !== null ? String(game.upgradeCost(t)) : it.cmd.kind === "sell" && t ? `+${game.sellValue(t)}` : "";
    b.innerHTML = `<span>${it.label}</span><em>${price}</em>`;
    b.disabled = !!no;
    b.title = no ?? "";
    b.addEventListener("click", () => { closeMenu(); press(it.cmd); });
    menu.append(b);
  }
  menu.style.left = `${Math.min(px, canvas.clientWidth - 210)}px`;
  menu.style.top = `${Math.min(py + 8, canvas.clientHeight - 40 - items.length * 34)}px`;
  menu.hidden = false;
}

canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * game.map.w;
  const y = ((e.clientY - r.top) / r.height) * game.map.h;
  const enemy = game.enemies.find((en) => { const p = game.enemyPos(en); return Math.hypot(p.x - x, p.y - y) < 0.5; });
  if (enemy) {
    closeMenu();
    press({ kind: "attack", mode: "number", n: enemy.num });
    return;
  }
  const pad = game.map.pads.find((p) => Math.hypot(p.pos.x - x, p.pos.y - y) < 0.6);
  if (pad) {
    openPadMenu(pad.name, e.clientX - r.left, e.clientY - r.top);
    return;
  }
  if (!menu.hidden) return closeMenu();
  press({ kind: "move", to: { type: "point", x: Math.min(game.map.w - 0.5, Math.max(0.5, x)), y: Math.min(game.map.h - 0.5, Math.max(0.5, y)) } });
});

addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).tagName === "INPUT";
  if (e.code === "Space" && !e.repeat && !typing && !setupOpen) { e.preventDefault(); mic?.press(); }
  else if (e.key === "Escape") { closeMenu(); if (setupOpen && gameStarted) closeSetup(); }
  else if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); press({ kind: "undo" }); }
  else if (!typing && e.key.toLowerCase() === "p" && !e.metaKey && !e.ctrlKey) press({ kind: game.paused ? "resume" : "pause" });
});
addEventListener("keyup", (e) => { if (e.code === "Space") mic?.release(); });

$<HTMLFormElement>("typed").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("text");
  const text = input.value;
  input.value = "";
  void handleText(text, performance.now());
});
$("newmap").addEventListener("click", () => newGame());

// --- the loop -----------------------------------------------------------------------------------

function hud() {
  $("wave").textContent = String(game.wave);
  $("gold").textContent = String(game.gold);
  $("hp").textContent = String(game.baseHp);
  $("order").textContent = game.orderText();
  $("flags").textContent = [game.paused ? "paused" : "", game.speed === 2 ? "×2" : ""].filter(Boolean).join(" · ");
  $("pause").textContent = game.paused ? "▶ Resume" : "⏸ Pause";
  $("speed").classList.toggle("on", game.speed === 2);
  for (; shownLog < game.log.length; shownLog++) log(game.log[shownLog]);
  if (game.state === "lost") {
    $("banner").hidden = false;
    $("banner").textContent = `Base fell on wave ${game.wave}`;
  }
}

const stage = document.querySelector<HTMLElement>(".stage")!;
const board = document.querySelector<HTMLElement>(".board")!;
const fit = () => {
  const aspect = game.map.w / game.map.h;
  const stacked = matchMedia("(max-width: 900px)").matches;
  const rest = $("tip").offsetHeight + document.querySelector<HTMLElement>(".hud")!.offsetHeight + 24;
  const w = stacked ? stage.clientWidth : Math.max(240, Math.min(stage.clientWidth, (stage.clientHeight - rest) * aspect));
  const h = Math.floor(w / aspect);
  for (const el of [canvas, board, $("banner")]) {
    el.style.width = `${Math.floor(w)}px`;
    el.style.height = `${h}px`;
  }
};
new ResizeObserver(fit).observe(stage);
const wide = matchMedia("(min-width: 901px)");
const syncExamples = () => ($<HTMLDetailsElement>("try").open = wide.matches);
wide.addEventListener("change", syncExamples);
syncExamples();

newGame(params.get("seed") ? Number(params.get("seed")) : undefined);
setup.hidden = !setupOpen;
if (setupOpen) void openSetup();
let last = performance.now();
let acc = 0;
function frame(now: number) {
  if (!setupOpen) acc += Math.min(0.25, (now - last) / 1000) * game.speed;
  last = now;
  while (acc >= 1 / 30) { game.step(1 / 30); acc -= 1 / 30; }
  render(ctx, game);
  hud();
  void advanceQueue();
  requestAnimationFrame(frame);
}
fit();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  Object.assign(window, {
    walker: { get game() { return game; }, get hero() { return hero; }, get stt() { return stt; }, get decider() { return decider; }, get queue() { return queue; }, say: (t: string) => handleText(t, performance.now()) },
  });
}
