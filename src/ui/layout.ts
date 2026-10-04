export interface BoardFit {
  stageW: number;
  stageH: number;
  /** Height taken by everything else in the stage: the status strip, the tip and the gaps. */
  chrome: number;
  aspect: number;
  /** One column on a narrow screen: the width rules and the page scrolls. */
  stacked: boolean;
}

/** The biggest map that fits the stage, in whole pixels. */
export function boardSize({ stageW, stageH, chrome, aspect, stacked }: BoardFit) {
  const w = stacked ? stageW : Math.max(240, Math.min(stageW, (stageH - chrome) * aspect));
  return { w: Math.floor(w), h: Math.floor(w / aspect) };
}

export interface Point { x: number; y: number }

/** The item closest to `to`, if one lies within `radius`. */
export function nearestWithin<T>(items: T[], at: (item: T) => Point, to: Point, radius: number): T | undefined {
  let best: T | undefined;
  let bestDistance = radius;
  for (const item of items) {
    const p = at(item);
    const d = Math.hypot(p.x - to.x, p.y - to.y);
    if (d < bestDistance) { best = item; bestDistance = d; }
  }
  return best;
}
