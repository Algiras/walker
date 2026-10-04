import { generateMap } from "./game/map";
import { Game } from "./game/sim";
import { render } from "./game/render";
import { Command, describeCommand } from "./game/commands";
import { Mic } from "./voice/mic";
import { loadStt, Stt, STT_OPTIONS, SttId } from "./voice/stt";
import { loadPicker } from "./voice/llm";
import { Decider, PickDecider } from "./voice/decide";
import { RuleDecider } from "./voice/rules";
import { examplesFor, plain } from "./voice/examples";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const sttSelect = $<HTMLSelectElement>("stt");
for (const o of STT_OPTIONS) sttSelect.add(new Option(`${o.label} (${o.size})`, o.id));
const wanted = params.get("stt") as SttId | null;
if (wanted && STT_OPTIONS.some((o) => o.id === wanted)) sttSelect.value = wanted;

const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
let game: Game;
let decider: Decider = new RuleDecider();
let stt: Stt | null = null;
let mic: Mic | null = null;
let shownLog = 0;

function newGame(seed = Math.floor(Math.random() * 1e6)) {
  game = new Game(generateMap(seed));
  $("seed").textContent = String(seed);
  history.replaceState(null, "", `?seed=${seed}`);
  shownLog = 0;
  $("log").innerHTML = "";
  $("banner").hidden = true;
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
  const out = game.command(c);
  log(out.message);
  if (!out.ok) $("decision").textContent = out.message;
  return out;
}

async function handleText(text: string, t0: number, asrMs?: number) {
  $("heard").textContent = text ? `“${text}”` : "(nothing heard)";
  $("advice").textContent = "";
  if (!text.trim()) return;

  if (pending && Date.now() < pending.until) {
    if (YES.test(text)) {
      const c = pending.command;
      pending = null;
      $("decision").textContent = `Confirmed: ${describeCommand(c)}`;
      run(c);
      return;
    }
    if (NO.test(text)) {
      pending = null;
      $("decision").textContent = "Cancelled.";
      return;
    }
  }
  pending = null;

  const d = await decider.decide(text, game);
  const pct = `${Math.round(d.confidence * 100)}%`;
  if (d.status === "act" && d.command) {
    $("decision").textContent = `${describeCommand(d.command)}  ·  ${d.trace}`;
    run(d.command);
  } else if (d.status === "confirm" && d.command) {
    pending = { command: d.command, until: Date.now() + 10_000 };
    game.hero.shake = 0.35;
    $("decision").textContent = `${d.note} Did you mean “${describeCommand(d.command)}”? Say yes to confirm.`;
    log(`Not sure (${pct}): ${describeCommand(d.command)}?`);
    advise(d.command);
  } else {
    game.hero.shake = 0.6;
    $("decision").textContent = `${d.note ?? "Not understood."}  ·  ${d.trace}`;
    log(d.note ?? "Not understood.");
  }
  const rows: [string, string][] = [];
  if (asrMs !== undefined) rows.push(["Speech to text", `${asrMs.toFixed(0)} ms`]);
  rows.push([`Decision (${decider.name})`, `${d.ms.toFixed(0)} ms`]);
  rows.push(["Release to action", `${(performance.now() - t0).toFixed(0)} ms`]);
  setTiming(rows);
}

async function onUtterance(pcm: Float32Array, endedAt: number) {
  if (!stt) return;
  const r = await stt.transcribe(pcm);
  await handleText(r.text, endedAt, r.ms);
}

function progressBars() {
  const bars = $("bars");
  const rows = new Map<string, HTMLProgressElement>();
  return (file: string, got: number, total: number) => {
    let p = rows.get(file);
    if (!p) {
      const row = document.createElement("div");
      row.textContent = file;
      p = document.createElement("progress");
      row.append(p);
      bars.append(row);
      rows.set(file, p);
    }
    p.max = total || got || 1;
    p.value = got;
  };
}

$("load").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("load");
  btn.disabled = true;
  const status = (m: string) => ($("status").textContent = m);
  const progress = progressBars();
  try {
    status("Requesting microphone…");
    mic = await Mic.start();
    const pick = STT_OPTIONS.find((o) => o.id === sttSelect.value)!;
    sttSelect.disabled = true;
    status(`Loading ${pick.label}…`);
    stt = await loadStt(pick.id, progress, log);
    status(`${stt.name} ready (${stt.device}). Loading Tev1 decision model…`);
    const picker = await loadPicker(progress);
    decider = new PickDecider("Tev1 0.8B", picker);
    $("decider").textContent = `Decision engine: ${decider.name}`;
    status("Ready. Hold Space and speak.");
    mic.onUtterance = (u) => onUtterance(u.pcm, u.endedAt);
    mic.onLevel = (rms, active) => {
      $("level").style.width = `${Math.min(100, rms * 600)}%`;
      document.querySelector(".meter")!.classList.toggle("live", active);
    };
    $<HTMLInputElement>("vad").addEventListener("change", (e) => {
      mic!.mode = (e.target as HTMLInputElement).checked ? "vad" : "ptt";
    });
  } catch (e) {
    status(`Failed: ${(e as Error).message}`);
    btn.disabled = false;
  }
});

addEventListener("keydown", (e) => {
  if (e.code === "Space" && !e.repeat && (e.target as HTMLElement).tagName !== "INPUT") { e.preventDefault(); mic?.press(); }
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

function hud() {
  $("wave").textContent = String(game.wave);
  $("gold").textContent = String(game.gold);
  $("hp").textContent = String(game.baseHp);
  $("order").textContent = game.orderText();
  for (; shownLog < game.log.length; shownLog++) log(game.log[shownLog]);
  if (game.state === "lost") {
    $("banner").hidden = false;
    $("banner").textContent = `Base fell on wave ${game.wave}`;
  }
}

const board = document.querySelector<HTMLElement>(".board")!;
const fit = () => {
  const aspect = game.map.w / game.map.h;
  const stacked = matchMedia("(max-width: 900px)").matches;
  const w = stacked ? board.clientWidth : Math.min(board.clientWidth, board.clientHeight * aspect);
  canvas.style.width = `${Math.floor(w)}px`;
  canvas.style.height = `${Math.floor(w / aspect)}px`;
};
new ResizeObserver(fit).observe(board);
const wide = matchMedia("(min-width: 901px)");
const syncExamples = () => ($<HTMLDetailsElement>("try").open = wide.matches);
wide.addEventListener("change", syncExamples);
syncExamples();

newGame(params.get("seed") ? Number(params.get("seed")) : undefined);
let last = performance.now();
let acc = 0;
function frame(now: number) {
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  while (acc >= 1 / 30) { game.step(1 / 30); acc -= 1 / 30; }
  render(ctx, game);
  hud();
  requestAnimationFrame(frame);
}
fit();
requestAnimationFrame(frame);
