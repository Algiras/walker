import { Game } from "./sim";

export const TILE = 52;
const C = {
  grass: "#7fb069", grass2: "#76a860", path: "#d9b98a", pathEdge: "#c19f6f", pad: "#8b93a6", padLine: "#4b5266",
  tower: "#3b4a6b", hero: "#2f7de1", base: "#c0392b", spawn: "#6c3483", text: "#1b1f2a",
};
const ENEMY = { grunt: "#e67e22", fast: "#f1c40f", tank: "#7f3b2b" };

export function render(ctx: CanvasRenderingContext2D, g: Game) {
  const { w, h } = g.map;
  ctx.canvas.width = w * TILE;
  ctx.canvas.height = h * TILE;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      ctx.fillStyle = (x + y) % 2 ? C.grass : C.grass2;
      ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    }
  for (const k of g.map.pathCells) {
    const [x, y] = k.split(",").map(Number);
    ctx.fillStyle = C.path;
    ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    ctx.strokeStyle = C.pathEdge;
    ctx.strokeRect(x * TILE + 0.5, y * TILE + 0.5, TILE - 1, TILE - 1);
  }
  for (const s of g.map.scenery) {
    const x = s.pos.x * TILE, y = s.pos.y * TILE;
    ctx.fillStyle = s.kind === "tree" ? "#2e6b34" : "#8d8d8d";
    ctx.beginPath();
    ctx.arc(x, y, s.kind === "tree" ? TILE * 0.28 : TILE * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  marker(ctx, g.map.spawn.x, g.map.spawn.y, C.spawn, "S");
  marker(ctx, g.map.base.x, g.map.base.y, C.base, "B");

  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  for (const p of g.map.pads) {
    const x = p.pos.x * TILE, y = p.pos.y * TILE;
    ctx.fillStyle = C.pad;
    ctx.strokeStyle = C.padLine;
    ctx.lineWidth = 2;
    ctx.fillRect(x - TILE * 0.4, y - TILE * 0.4, TILE * 0.8, TILE * 0.8);
    ctx.strokeRect(x - TILE * 0.4, y - TILE * 0.4, TILE * 0.8, TILE * 0.8);
    ctx.strokeStyle = "rgba(0,0,0,.7)";
    ctx.lineWidth = 3;
    ctx.strokeText(p.name, x, y + TILE * 0.74);
    ctx.fillStyle = "#fff";
    ctx.fillText(p.name, x, y + TILE * 0.74);
    badge(ctx, x + TILE * 0.3, y - TILE * 0.3, p.number, g.towerAt(p.name) ? "#ffd166" : "#c9ced9");
  }
  for (const t of g.towers) {
    const x = t.pos.x * TILE, y = t.pos.y * TILE;
    ctx.fillStyle = C.tower;
    ctx.fillRect(x - TILE * 0.3, y - TILE * 0.3, TILE * 0.6, TILE * 0.6);
    ctx.fillStyle = "#ffd166";
    for (let i = 0; i < t.level; i++) ctx.fillRect(x - TILE * 0.25 + i * 9, y + TILE * 0.2, 6, 6);
  }
  for (const e of g.enemies) {
    const p = g.enemyPos(e);
    const x = p.x * TILE, y = p.y * TILE;
    ctx.fillStyle = ENEMY[e.kind];
    ctx.beginPath();
    ctx.arc(x, y, e.kind === "tank" ? 13 : e.kind === "fast" ? 7 : 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.fillRect(x - 12, y - 18, 24, 4);
    ctx.fillStyle = "#2ecc71";
    ctx.fillRect(x - 12, y - 18, 24 * Math.max(0, e.hp / e.maxHp), 4);
  }
  for (const b of g.beams) {
    ctx.strokeStyle = b.hero ? "#4aa3ff" : "#ffd166";
    ctx.lineWidth = b.hero ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(b.from.x * TILE, b.from.y * TILE);
    ctx.lineTo(b.to.x * TILE, b.to.y * TILE);
    ctx.stroke();
  }
  const shake = g.hero.shake > 0 ? Math.sin(g.hero.shake * 70) * 6 * Math.min(1, g.hero.shake / 0.3) : 0;
  const hx = g.hero.pos.x * TILE + shake, hy = g.hero.pos.y * TILE;
  ctx.fillStyle = C.hero;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(hx, hy, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.fillText("H", hx, hy + 4);
}

function marker(ctx: CanvasRenderingContext2D, px: number, py: number, color: string, label: string) {
  const x = px * TILE, y = py * TILE;
  ctx.fillStyle = color;
  ctx.fillRect(x - TILE * 0.45, y - TILE * 0.45, TILE * 0.9, TILE * 0.9);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 16px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y + 6);
}

function badge(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#3b4a6b";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = "#1b1f2a";
  ctx.font = "bold 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(String(n), x, y + 4.5);
}
