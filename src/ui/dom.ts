export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Writes only when the text differs, so something updated every frame leaves the DOM alone. */
export function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

let announcing: ReturnType<typeof setTimeout> | undefined;

/** Reads a short message out to screen readers through the visually hidden status region. */
export function announce(text: string) {
  const region = $("sr-status");
  clearTimeout(announcing);
  region.textContent = "";
  // Clearing first makes a repeated message count as a change and be read again.
  announcing = setTimeout(() => { region.textContent = text; }, 40);
}
