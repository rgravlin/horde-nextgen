/**
 * Listening for the next key or pointer button, for the rebind rows.
 *
 * Its own file because it is the one piece of the menus that touches the window at all:
 * capture phase and `stopImmediatePropagation`, because the input sampler listens on the same
 * window and a key pressed to *name* a binding must not also be spent *as* that binding.
 * Returning a cancel matches the sampler's `InputHost` rule that a listener is handed back
 * rather than leaked.
 */

export function listenForSource(onSource: (source: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const key = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code) onSource(e.code);
  };
  const down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopImmediatePropagation();
    onSource(`Mouse${e.button}`);
  };

  window.addEventListener('keydown', key, true);
  window.addEventListener('pointerdown', down, true);
  return () => {
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('pointerdown', down, true);
  };
}
