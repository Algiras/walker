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
