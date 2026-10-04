import { generateMap } from "./game/map";
import { Game } from "./game/sim";
import { render } from "./game/render";
import { describeCommand } from "./game/commands";
import { Mic } from "./voice/mic";
import { Parakeet } from "./voice/asr";
import { loadPicker } from "./voice/llm";
import { Decider, PickDecider } from "./voice/decide";
import { RuleDecider } from "./voice/rules";
import { examplesFor, plain } from "./voice/examples";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

const canvas = $<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
let game: Game;
let decider: Decider = new RuleDecider();
let parakeet: Parakeet | null = null;
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

async function handleText(text: string, t0: number, asrMs?: number) {
  $("heard").textContent = text ? `“${text}”` : "(nothing heard)";
  if (!text.trim()) return;
  const d = await decider.decide(text, game);
  $("decision").textContent = d.command ? `${describeCommand(d.command)}  ·  ${d.trace}` : `Not understood  ·  ${d.trace}`;
  const reply = d.command ? game.command(d.command) : "Say again?";
  log(reply);
  const rows: [string, string][] = [];
  if (asrMs !== undefined) rows.push(["Speech to text", `${asrMs.toFixed(0)} ms`]);
  rows.push([`Decision (${decider.name})`, `${d.ms.toFixed(0)} ms`]);
  rows.push(["Release to action", `${(performance.now() - t0).toFixed(0)} ms`]);
  setTiming(rows);
}

async function onUtterance(pcm: Float32Array, endedAt: number) {
  if (!parakeet) return;
  const r = await parakeet.transcribe(pcm);
  await handleText(r.text, endedAt, r.ms.total);
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
    status("Loading Parakeet Redux…");
    parakeet = await Parakeet.load(progress, log);
    status(`Parakeet ready (encoder on ${parakeet.encoderDevice}). Loading Tev1 decision model…`);
    const pick = await loadPicker(progress);
    decider = new PickDecider("Tev1 0.8B", pick);
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
