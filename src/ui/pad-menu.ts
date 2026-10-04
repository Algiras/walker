import { Command } from "../game/commands";
import { COSTS, Game } from "../game/sim";
import { announce } from "./dom";
import type { Point } from "./layout";

export interface MenuItem { label: string; price: string; command: Command; blocked: string | null }
export interface Size { w: number; h: number }

/** What can be done at a pad right now, with the price and, when it cannot be done, why. */
export function menuItems(game: Game, padName: string): MenuItem[] {
  const tower = game.towerAt(padName);
  const items: Omit<MenuItem, "blocked">[] = [];
  if (!tower) items.push({ label: "Build tower", price: String(COSTS.build), command: { kind: "build", pad: padName } });
  else {
    const cost = game.upgradeCost(tower);
    items.push({
      label: cost === null ? "Upgrade (max level)" : `Upgrade to level ${tower.level + 1}`,
      price: cost === null ? "" : String(cost),
      command: { kind: "upgrade", pad: padName },
    });
    items.push({ label: "Sell / remove tower", price: `+${game.sellValue(tower)}`, command: { kind: "sell", pad: padName } });
  }
  items.push({ label: "Send hero here", price: "", command: { kind: "move", to: { type: "pad", name: padName } } });
  return items.map((item) => ({ ...item, blocked: game.refusal(item.command) }));
}

/** Puts the menu beside the pad, on its left when there is no room on its right, and keeps it inside the board. */
export function placeMenu(pad: Point, menu: Size, board: Size, gap: number) {
  const right = pad.x + gap;
  const left = right + menu.w <= board.w ? right : pad.x - gap - menu.w;
  const within = (v: number, room: number) => Math.max(0, Math.min(v, room));
  return { left: within(left, board.w - menu.w), top: within(pad.y - menu.h / 2, board.h - menu.h) };
}

export class PadMenu {
  constructor(
    private el: HTMLElement,
    private canvas: HTMLCanvasElement,
    private game: () => Game,
    private run: (command: Command) => void,
  ) {
    el.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("pointerdown", (e) => {
      const target = e.target as Node;
      if (this.isOpen && !el.contains(target) && target !== canvas) this.close();
    });
  }

  get isOpen() { return !this.el.hidden; }

  /** With the keyboard the first item takes focus; with the mouse focus stays put, so Space keeps meaning "talk". */
  open(padName: string, byKeyboard = false) {
    const game = this.game();
    const pad = game.padByName(padName)!;
    const tower = game.towerAt(padName);
    const title = document.createElement("div");
    title.id = "menu-title";
    title.className = "menu-title";
    title.textContent = `Pad ${pad.number} ${pad.name}${tower ? ` · tower ${tower.id}, level ${tower.level}` : ""}`;
    this.el.replaceChildren(title, ...menuItems(game, padName).map((item) => this.button(item)));
    this.el.hidden = false;

    const { canvas } = this;
    const tile = { x: canvas.clientWidth / game.map.w, y: canvas.clientHeight / game.map.h };
    const at = placeMenu(
      { x: canvas.clientLeft + pad.pos.x * tile.x, y: canvas.clientTop + pad.pos.y * tile.y },
      { w: this.el.offsetWidth, h: this.el.offsetHeight },
      { w: canvas.offsetWidth, h: canvas.offsetHeight },
      Math.max(18, tile.x * 0.62),
    );
    this.el.style.left = `${at.left}px`;
    this.el.style.top = `${at.top}px`;
    if (byKeyboard) {
      const items = this.items();
      (items.find((b) => b.getAttribute("aria-disabled") !== "true") ?? items[0])?.focus();
    }
  }

  close(refocus = false) {
    if (!this.isOpen) return;
    const hadFocus = this.el.contains(document.activeElement);
    this.el.hidden = true;
    if (hadFocus || refocus) this.canvas.focus({ preventScroll: true });
  }

  private items() { return [...this.el.querySelectorAll<HTMLButtonElement>("button")]; }

  private button(item: MenuItem) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    const label = document.createElement("span");
    label.textContent = item.label;
    const price = document.createElement("em");
    price.textContent = item.price;
    b.append(label, price);
    if (item.blocked) {
      const why = document.createElement("small");
      why.textContent = item.blocked;
      b.append(why);
      b.setAttribute("aria-disabled", "true");
    }
    b.addEventListener("click", () => {
      if (item.blocked) return announce(item.blocked);
      this.close(true);
      this.run(item.command);
    });
    return b;
  }

  private onKey(e: KeyboardEvent) {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (step || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : at + step;
      items[(to + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      this.close(true);
    }
  }
}
