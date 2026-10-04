const TABBABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

function tabbable(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

/** Makes the dialog the only part of the page that exists: what is behind it goes inert and Tab wraps inside it. The returned function undoes that and gives focus back. */
export function trapFocus(dialog: HTMLElement, behind: HTMLElement[]): () => void {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  for (const el of behind) el.inert = true;

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = tabbable(dialog);
    if (!items.length) return;
    const edge = e.shiftKey ? items[0] : items[items.length - 1];
    if (document.activeElement === edge) {
      e.preventDefault();
      (e.shiftKey ? items[items.length - 1] : items[0]).focus();
    }
  };
  dialog.addEventListener("keydown", onKey);

  return () => {
    dialog.removeEventListener("keydown", onKey);
    for (const el of behind) el.inert = false;
    if (opener?.isConnected) opener.focus();
  };
}
