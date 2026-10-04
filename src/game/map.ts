import { mulberry32, randInt, shuffle } from "./rng";

export interface Vec { x: number; y: number }
export interface Pad { name: string; number: number; pos: Vec; where: string }
export interface GameMap {
  seed: number;
  w: number;
  h: number;
  path: Vec[];
  pathCells: Set<string>;
  pads: Pad[];
  scenery: { pos: Vec; kind: "tree" | "rock" }[];
  spawn: Vec;
  base: Vec;
}

export const PAD_NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
export const cellKey = (x: number, y: number) => `${x},${y}`;

export function generateMap(seed: number, w = 18, h = 11): GameMap {
  const r = mulberry32(seed);
  const turns = randInt(r, 3, 4);
  const xs = [0];
  const span = (w - 1) / (turns + 1);
  for (let i = 1; i <= turns; i++) xs.push(Math.round(i * span + randInt(r, -1, 1)));
  xs.push(w - 1);

  const ys: number[] = [randInt(r, 1, h - 2)];
  for (let i = 1; i < xs.length; i++) {
    let y: number;
    do y = randInt(r, 1, h - 2); while (Math.abs(y - ys[i - 1]) < 3);
    ys.push(y);
  }

  const path: Vec[] = [];
  const pathCells = new Set<string>();
  const addCell = (x: number, y: number) => {
    const k = cellKey(x, y);
    if (!pathCells.has(k)) pathCells.add(k);
  };
  path.push({ x: xs[0] + 0.5, y: ys[0] + 0.5 });
  for (let i = 1; i < xs.length; i++) {
    path.push({ x: xs[i] + 0.5, y: ys[i - 1] + 0.5 });
    path.push({ x: xs[i] + 0.5, y: ys[i] + 0.5 });
  }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    let cx = Math.floor(a.x), cy = Math.floor(a.y);
    addCell(cx, cy);
    while (cx !== Math.floor(b.x) || cy !== Math.floor(b.y)) {
      cx += dx; cy += dy;
      addCell(cx, cy);
    }
  }

  const candidates: Vec[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (pathCells.has(cellKey(x, y))) continue;
      const near = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => pathCells.has(cellKey(x + dx, y + dy)));
      if (near) candidates.push({ x, y });
    }
  }
  const pads: Pad[] = [];
  const count = randInt(r, 5, 7);
  for (const c of shuffle(r, candidates)) {
    if (pads.length >= count) break;
    if (pads.some((p) => Math.abs(p.pos.x - (c.x + 0.5)) + Math.abs(p.pos.y - (c.y + 0.5)) < 3)) continue;
    pads.push({ name: "", number: 0, pos: { x: c.x + 0.5, y: c.y + 0.5 }, where: describe(c.x + 0.5, c.y + 0.5, w, h) });
  }
  pads.sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y);
  pads.forEach((p, i) => {
    p.name = PAD_NAMES[i];
    p.number = i + 1;
  });

  const taken = new Set([...pathCells, ...pads.map((p) => cellKey(Math.floor(p.pos.x), Math.floor(p.pos.y)))]);
  const scenery: GameMap["scenery"] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (taken.has(cellKey(x, y)) || r() > 0.12) continue;
      scenery.push({ pos: { x: x + 0.5, y: y + 0.5 }, kind: r() < 0.7 ? "tree" : "rock" });
    }
  }

  return { seed, w, h, path, pathCells, pads, scenery, spawn: path[0], base: path[path.length - 1] };
}

export function describe(x: number, y: number, w: number, h: number): string {
  const col = x < w / 3 ? "left" : x > (2 * w) / 3 ? "right" : "middle";
  const row = y < h / 3 ? "top" : y > (2 * h) / 3 ? "bottom" : "center";
  return row === "center" && col === "middle" ? "center" : row === "center" ? col : col === "middle" ? row : `${row} ${col}`;
}

export function pathLength(path: Vec[]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) n += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return n;
}

export function pointAt(path: Vec[], d: number): Vec {
  for (let i = 1; i < path.length; i++) {
    const len = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (d <= len) {
      const t = len === 0 ? 0 : d / len;
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * t, y: path[i - 1].y + (path[i].y - path[i - 1].y) * t };
    }
    d -= len;
  }
  return path[path.length - 1];
}
