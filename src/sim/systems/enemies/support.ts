/**
 * The healer's mending aura, and the healer's own escort behaviour.
 *
 * `mendAura` is shared with the matron because both bodies mend the pack that arrived
 * beside them at the same cap and with one event per pulse; what differs is only the clock
 * that starts a pulse — the healer runs it on a cooldown, the matron on the tick its own age
 * turns over.
 */

import { ENEMIES, type EnemyDef } from '../../../content/enemies';
import { DT, Ev, pushEvent, type World } from '../../world';
import { queryRadius } from '../../spatialHash';
import { drive } from './shared';

/** Neighbours one heal pulse examines, the same kind of cap `SEP_CAP` is. */
const HEAL_SCAN_CAP = 64;

/** Seconds a healer re-reads for wounded allies when the last read found none. */
const HEAL_RETRY = 0.5;

/**
 * Mend every wounded ally inside the aura, and say whether anything was mended.
 *
 * One event per pulse, not per mended body: the aura is one thing on screen even when it
 * catches six bodies, and `b` carries its radius for the ring. Mending stops at what the
 * ally's archetype started with, so a pack cannot be healed past its own content.
 *
 * It reads the tick's shared query buffer, so it is written to be called where the buffer is
 * free — the same one-buffer rule every query in the pass keeps.
 */
export function mendAura(w: World, i: number, def: EnemyDef): boolean {
  const enemies = w.enemies;
  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    enemies.alive,
    enemies.x[i],
    enemies.y[i],
    def.params.healRange,
    w.query,
  );
  const seen = found < HEAL_SCAN_CAP ? found : HEAL_SCAN_CAP;
  let mended = false;
  for (let k = 0; k < seen; k++) {
    const j = w.query[k];
    if (j === i || enemies.hp[j] <= 0) continue;
    const cap = ENEMIES[enemies.kind[j]].hp;
    if (enemies.hp[j] >= cap) continue;
    const next = enemies.hp[j] + def.params.healAmount;
    enemies.hp[j] = next > cap ? cap : next;
    mended = true;
  }

  if (mended) {
    pushEvent(w, Ev.Heal, i, Math.round(def.params.healRange * 10), enemies.x[i], enemies.y[i]);
  }

  return mended;
}

/**
 * Healer: escort, mend, and give ground.
 *
 * It does not attack the player — its whole job is the two seconds it takes a
 * pack's wounds to knit back up. `healRange` metres of allies get `healAmount`
 * back every `healGap` seconds — one pulse, one `Heal` event, whoever is standing
 * inside it, capped at what their archetype starts with; when nothing in range is
 * wounded it re-reads cheaply on `HEAL_RETRY` seconds rather than querying every
 * tick. `fleeRadius` is the leash: inside it the healer runs straight away at full
 * cruise, outside it walks back toward the fight, so it kites at the edge of the
 * pack instead of either charging you or fleeing the arena.
 */
export function supportRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  if (enemies.timer[i] <= 0) {
    if (mendAura(w, i, def)) enemies.timer[i] = def.params.healGap;
    else enemies.timer[i] = HEAL_RETRY;
  }

  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1e-12) {
    drive(w, i, def, 0, 0);
    return;
  }

  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const sign = d < def.params.fleeRadius ? -1 : 1;
  drive(w, i, def, nx * def.speed * sign, ny * def.speed * sign);
}
