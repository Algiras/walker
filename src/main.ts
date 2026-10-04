import { generateMap } from "./game/map";
import { Game, Order } from "./game/sim";
import { render, sizeCanvas } from "./game/render";
import { Command, describeCommand } from "./game/commands";
import { Mic } from "./voice/mic";
import type { Stt } from "./voice/stt";
import type { Decider } from "./voice/decide";
import { RuleDecider } from "./voice/rules";
import { examplesFor, plain } from "./voice/examples";
import { splitCommands } from "./voice/verbs";
import { HeroVoice } from "./voice/hero-voice";
import { calloutFor, CONFIRM, eventLine, refusalCallout, warmLines } from "./voice/callouts";
import { $, announce, setText } from "./ui/dom";
import { boardSize } from "./ui/layout";
import { PadMenu } from "./ui/pad-menu";
import { Setup } from "./ui/setup";

const params = new URLSearchParams(location.search);

const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
let game: Game;
let decider: Decider = new RuleDecider();
let stt: Stt | null = null;
let mic: Mic | null = null;
const hero = new HeroVoice();
hero.holdWhile = () => mic?.listening === true;
const sayLine = (line: string | null) => { if (line) hero.say(line, 2); };

function newGame(seed = Math.floor(Math.random() * 1e6)) {
  game = new Game(generateMap(seed));
  const say = game.say.bind(game);
  game.say = (message) => { say(message); log(message); };
  $("seed").textContent = String(seed);
  params.set("seed", String(seed));
  history.replaceState(null, "", `?${params}`);
  logBox.replaceChildren();
  $("banner").hidden = true;
  menu.close();
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

const logBox = $("log");

function log(message: string) {
  const d = document.createElement("div");
  d.textContent = message;
  logBox.prepend(d);
  while (logBox.childElementCount > 100) logBox.lastElementChild!.remove();
}

function setTiming(rows: [string, string][]) {
  $("timing").querySelector("tbody")!.innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join("");
}

// --- skeleton while the command is being worked out ---------------------------------------------

let thinkingTimer: number | undefined;

/** Shows skeleton lines in place of the result, but only if the work takes long enough to notice. */
function thinking(on: boolean) {
  clearTimeout(thinkingTimer);
  if (!on) {
    $("thinking").hidden = true;
    return;
  }
  thinkingTimer = window.setTimeout(() => {
    $("empty").hidden = true;
    $("result").hidden = true;
    $("thinking").hidden = false;
    announce("Working out the command.");
  }, 140);
}

function showResult() {
  $("empty").hidden = true;
  $("thinking").hidden = true;
  $("result").hidden = false;
}

/** Shows what the hero decided and reads the result out to screen readers; the trace is for the screen only. */
function setDecision(message: string, trace?: string) {
  $("decision").textContent = trace ? `${message}  ·  ${trace}` : message;
  const heard = $("heard").textContent;
  const advice = $("advice").textContent;
  announce([heard ? `Heard ${heard}.` : "", message, advice].filter(Boolean).join(" "));
}

function fail(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  log(`Error: ${message}`);
  showResult();
  $("heard").textContent = "";
  $("advice").textContent = "";
  setDecision(`Something went wrong: ${message}`);
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
  return out;
}

/** Commands from the buttons and the map skip the speech and decision steps. */
function press(c: Command) {
  pending = null;
  clearQueue();
  showResult();
  $("heard").textContent = "";
  const out = run(c);
  setDecision(out.ok ? describeCommand(c) : out.message);
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
  } catch (e) {
    clearQueue();
    fail(e);
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
      const out = run(d.command);
      acted = out.ok;
      if (acted) issuedAt = performance.now();
      setDecision(acted ? describeCommand(d.command) : out.message, acted ? d.trace : undefined);
    } else if (d.status === "confirm" && d.command && game.refusal(d.command)) {
      // No point asking "did you mean…?" about something the game would refuse anyway.
      const no = game.refusal(d.command)!;
      game.hero.shake = 0.6;
      setDecision(no);
      log(no);
      sayLine(refusalCallout(no));
    } else if (d.status === "confirm" && d.command) {
      pending = { command: d.command, until: Date.now() + 10_000 };
      game.hero.shake = 0.35;
      advise(d.command);
      setDecision(`${d.note} Did you mean “${describeCommand(d.command)}”? Say yes to confirm.`);
      log(`Not sure (${pct}): ${describeCommand(d.command)}?`);
      sayLine(CONFIRM);
    } else {
      game.hero.shake = 0.6;
      setDecision(d.note ?? "Not understood.", d.trace);
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
    $("decision").textContent = "";
    $("advice").textContent = "";
    announce("Nothing heard.");
    return;
  }

  if (pending && Date.now() < pending.until) {
    if (YES.test(text)) {
      const c = pending.command;
      pending = null;
      showResult();
      $("heard").textContent = `“${text}”`;
      const out = run(c);
      if (out.ok) issuedAt = performance.now();
      setDecision(out.ok ? `Confirmed: ${describeCommand(c)}` : out.message);
      return;
    }
    if (NO.test(text)) {
      pending = null;
      showResult();
      $("heard").textContent = `“${text}”`;
      $("advice").textContent = "";
      setDecision("Cancelled.");
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
  } catch (e) {
    fail(e);
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
  } catch (e) {
    fail(e);
  } finally {
    thinking(false);
  }
}

// --- setting up the voice stack before the game starts ------------------------------------------

async function startMic() {
  const m = await Mic.start();
  const vad = $<HTMLInputElement>("vad");
  const meter = document.querySelector<HTMLElement>(".meter")!;
  const level = $("level");
  let shown = -1, live = false;
  m.onUtterance = (u) => void onUtterance(u.pcm, u.endedAt);
  m.ignoreInput = () => hero.speaking;
  m.onLevel = (rms, active) => {
    const pct = Math.min(100, Math.round(rms * 600));
    if (pct !== shown) { shown = pct; level.style.width = `${pct}%`; }
    if (active !== live) { live = active; meter.classList.toggle("live", active); }
  };
  m.mode = vad.checked ? "vad" : "ptt";
  vad.disabled = false;
  vad.addEventListener("change", () => { m.mode = vad.checked ? "vad" : "ptt"; });
  // A checkbox clicked with the mouse would keep focus, and Space would then toggle it instead of talking.
  vad.addEventListener("click", (e) => { if (e.detail > 0) vad.blur(); });
  meter.hidden = false;
  mic = m;
}

const setup = new Setup(
  {
    log,
    onModels: (s, d) => {
      stt = s;
      decider = d;
      $("decider").textContent = `Decision engine: ${d.name}`;
    },
    startMic,
  },
  !params.has("start"),
);

// --- the hero's own voice: pre-recorded lines, switched on by the first click or key press -------

const wantVoice = $<HTMLInputElement>("want-voice");
const heroToggle = $<HTMLButtonElement>("heroVoice");
const showHeroVoice = () => {
  wantVoice.checked = hero.enabled;
  $("heroVoiceIcon").textContent = hero.enabled ? "🔊" : "🔇";
  heroToggle.setAttribute("aria-pressed", String(hero.enabled));
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
// A touch only counts as a gesture when it ends, so pointerup rather than pointerdown.
addEventListener("pointerup", unlockAudio, { once: true });
addEventListener("keydown", unlockAudio, { once: true });

// --- hero buttons, map clicks, keyboard ---------------------------------------------------------

for (const b of document.querySelectorAll<HTMLButtonElement>("#controls [data-cmd]")) {
  b.addEventListener("click", () => press(JSON.parse(b.dataset.cmd!)));
}
$("pause").addEventListener("click", () => press({ kind: game.paused ? "resume" : "pause" }));
$("speed").addEventListener("click", () => press({ kind: "speed", fast: game.speed === 1 }));

const menu = new PadMenu($("menu"), canvas, () => game, press);

canvas.addEventListener("click", (e) => {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * game.map.w;
  const y = ((e.clientY - r.top) / r.height) * game.map.h;
  const enemy = game.enemies.find((en) => { const p = game.enemyPos(en); return Math.hypot(p.x - x, p.y - y) < 0.5; });
  if (enemy) {
    menu.close();
    press({ kind: "attack", mode: "number", n: enemy.num });
    return;
  }
  const pad = game.map.pads.find((p) => Math.hypot(p.pos.x - x, p.pos.y - y) < 0.6);
  if (pad) {
    menu.open(pad.name);
    return;
  }
  if (menu.isOpen) return menu.close();
  press({ kind: "move", to: { type: "point", x: Math.min(game.map.w - 0.5, Math.max(0.5, x)), y: Math.min(game.map.h - 0.5, Math.max(0.5, y)) } });
});

// With the map focused, a pad's number opens its menu.
canvas.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const pad = game.map.pads.find((p) => String(p.number) === e.key);
  if (!pad) return;
  e.preventDefault();
  menu.open(pad.name, true);
});

addEventListener("keydown", (e) => {
  const typing = (e.target as HTMLElement).tagName === "INPUT";
  if (e.key === "Escape") {
    menu.close();
    if (setup.open) setup.dismiss();
    else if (typing) (e.target as HTMLElement).blur();
    return;
  }
  if (setup.open || typing) return;
  // Space is claimed even when it repeats: an unclaimed repeat would click a focused button when the key is released.
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) mic?.press(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); press({ kind: "undo" }); }
  else if (e.key.toLowerCase() === "p" && !e.repeat && !e.metaKey && !e.ctrlKey) press({ kind: game.paused ? "resume" : "pause" });
});
addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  if (!setup.open && (e.target as HTMLElement).tagName !== "INPUT") e.preventDefault();
  mic?.release();
});
// Without these a key released after the window lost focus never arrives, and the microphone keeps recording.
addEventListener("blur", () => mic?.release());
document.addEventListener("visibilitychange", () => { if (document.hidden) mic?.release(); });

$<HTMLFormElement>("typed").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("text");
  const text = input.value;
  if (!text.trim()) return;
  input.value = "";
  void handleText(text, performance.now());
});
$("newmap").addEventListener("click", () => newGame());

// --- the loop -----------------------------------------------------------------------------------

const hudText = { wave: $("wave"), gold: $("gold"), hp: $("hp"), order: $("order"), flags: $("flags"), pauseIcon: $("pause-icon"), pauseLabel: $("pause-text") };
const speedBtn = $("speed");
const banner = $("banner");

function hud() {
  setText(hudText.wave, String(game.wave));
  setText(hudText.gold, String(game.gold));
  setText(hudText.hp, String(game.baseHp));
  setText(hudText.order, game.orderText());
  setText(hudText.flags, [game.paused ? "paused" : "", game.speed === 2 ? "×2" : ""].filter(Boolean).join(" · "));
  setText(hudText.pauseIcon, game.paused ? "▶" : "⏸");
  setText(hudText.pauseLabel, game.paused ? "Resume" : "Pause");
  const fast = String(game.speed === 2);
  if (speedBtn.getAttribute("aria-pressed") !== fast) speedBtn.setAttribute("aria-pressed", fast);
  if (game.state === "lost") {
    banner.hidden = false;
    setText(banner, `Base fell on wave ${game.wave}`);
  }
}

const stage = document.querySelector<HTMLElement>(".stage")!;
const board = document.querySelector<HTMLElement>(".board")!;
const hudBar = document.querySelector<HTMLElement>(".hud")!;
const tip = $("tip");
const stacked = matchMedia("(max-width: 900px)");
let lastSize = "";
const fit = () => {
  const { w, h } = boardSize({
    stageW: stage.clientWidth,
    stageH: stage.clientHeight,
    chrome: tip.offsetHeight + hudBar.offsetHeight + 24,
    aspect: game.map.w / game.map.h,
    stacked: stacked.matches,
  });
  for (const el of [canvas, board, banner]) {
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }
  sizeCanvas(canvas);
  render(ctx, game);
  if (lastSize !== `${w}x${h}`) menu.close();
  lastSize = `${w}x${h}`;
};
// Fitting inside the observer callback resizes what is being observed when the page is one column, which the browser reports as an error.
let refitting = false;
const resized = new ResizeObserver(() => {
  if (refitting) return;
  refitting = true;
  requestAnimationFrame(() => {
    refitting = false;
    fit();
  });
});
for (const el of [stage, hudBar, tip]) resized.observe(el);
const wide = matchMedia("(min-width: 901px)");
const syncExamples = () => ($<HTMLDetailsElement>("try").open = wide.matches);
wide.addEventListener("change", syncExamples);
syncExamples();

const seed = params.get("seed");
newGame(seed !== null && /^\d+$/.test(seed) ? Number(seed) : undefined);
let last = performance.now();
let acc = 0;
function frame(now: number) {
  if (!setup.open) acc += Math.min(0.25, (now - last) / 1000) * game.speed;
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
    walker: {
      get game() { return game; },
      get hero() { return hero; },
      get stt() { return stt; },
      get decider() { return decider; },
      get queue() { return queue; },
      get mic() { return mic; },
      set mic(m: Mic | null) { mic = m; },
      say: (t: string) => handleText(t, performance.now()),
    },
  });
}
