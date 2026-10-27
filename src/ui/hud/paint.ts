/**
 * Paint: how the HUD writes to the DOM without writing to it every frame.
 *
 * The two rules DESIGN.md's overlay is arranged around live here. Every node is built before
 * the first frame — `make` is only ever called while the overlay is built, never during a
 * tick — and nothing gets written twice: text is compared, bar widths are quantised to half a
 * percent and a reload arc to whole percents, so a steady frame costs a handful of compares.
 * That is why the values already written live on the two records at the bottom rather than
 * being read back out of the DOM, which is the slower direction.
 */

export function make(tag: string, className: string, parent: HTMLElement): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

/** Write text only when it changed: the DOM is slow and most frames change little. */
export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

/** Quantised width write, for the bars. */
export function setFill(node: HTMLElement, fraction: number): void {
  const steps = Math.max(0, Math.min(200, Math.round(fraction * 200)));
  const width = `${steps / 2}%`;
  if (node.style.width !== width) node.style.width = width;
}

/**
 * Quantised start-and-length write, for a track that carries two segments.
 *
 * Same half-percent grid as `setFill`, and the length is clamped to what is left of the
 * track so a full shield plus full health still fits inside the bar.
 */
export function setSpan(node: HTMLElement, from: number, fraction: number): void {
  const start = Math.max(0, Math.min(200, Math.round(from * 200)));
  const steps = Math.max(0, Math.min(200 - start, Math.round(fraction * 200)));
  const left = `${start / 2}%`;
  const width = `${steps / 2}%`;
  if (node.style.left !== left) node.style.left = left;
  if (node.style.width !== width) node.style.width = width;
}

/**
 * How far round the reload dial to paint, in whole percents.
 *
 * A reload lasts between half a second and two, so a full one is a few dozen writes rather
 * than a hundred and twenty; the arc is 14px and reads at 2% granularity.
 */
export function setArc(node: SlotNodes, fraction: number): void {
  const steps = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  if (node.arcValue === steps) return;
  node.arcValue = steps;
  node.arc.style.setProperty('--arc', String(steps));
}

/**
 * Show or hide one pooled marker.
 *
 * The last answer is remembered on the node itself, so a steady frame is one string compare
 * and touching `classList` is reserved for the frames that actually change the picture.
 */
export function setHidden(marker: Marker, hidden: boolean): void {
  const wanted = hidden ? '0' : '1';
  if (marker.shown === wanted) return;
  marker.shown = wanted;
  marker.node.classList.toggle('on', !hidden);
}

/** One edge marker: a node, the transform last written to it, and whether it is up. */
export interface Marker {
  node: HTMLElement;
  last: string;
  shown: string;
}

/** One weapon hand, with the two values already written to it. */
export interface SlotNodes {
  slot: HTMLElement;
  arc: HTMLElement;
  name: HTMLElement;
  tag: HTMLElement;
  ammo: HTMLElement;
  gaugeFill: HTMLElement;
  /** The arc percentage already written; -1 so the first frame always writes. */
  arcValue: number;
  /**
   * The weapon already drawn here, or `null` before the first frame.
   *
   * `null` and not `''`: an empty hand's key is the empty string, and a fresh slot must
   * still be told it is empty. The name and the tag start out blank in the markup, so a
   * sentinel that could never be a weapon id is what makes the first frame write them.
   */
  drawn: string | null;
}
