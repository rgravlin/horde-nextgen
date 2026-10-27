/**
 * The dispatch table: one small function per behaviour, keyed by the ai id the content
 * names, so an archetype stays data and a behaviour nobody wrote is a typecheck error
 * rather than an enemy that quietly stands still.
 *
 * `swarmling` and `splitter` share the stepper on purpose: what makes them different is how
 * fast they go and how wide they swing, and that is data. The ranged bodies mostly get their
 * own file because what they do between shots is genuinely different: hold a band, plant and
 * lob, or escort and mend. The two marks share one file because they share one bargain: a line
 * is painted, held, then spent along it.
 *
 * The last two break the walking default instead of the shooting one. The teleporter spends a
 * line the way the marks do but crosses it in a tick rather than along it (`phaser.ts`), and
 * the spawner never aims at the player at all — everything it does arrives as another body
 * (`nursery.ts`). Each needed its own file because neither is a variation on a number: one
 * moves without travelling, the other damages without touching.
 */

import { type AiId } from '../../../content/enemies';
import { type World } from '../../world';
import { slamRunner, broodRunner, matronRunner } from './bosses';
import { burrowRunner } from './burrowers';
import { sniperRunner, orbiterRunner } from './marksmen';
import { spawnerRunner } from './nursery';
import { teleporterRunner } from './phaser';
import { chargeRunner, fuseRunner } from './rushers';
import { seekChaser, swaySeek } from './seekers';
import { standoffOrbit, standoffShoot, lobRunner } from './standoff';
import { supportRunner } from './support';

/** One tick of one enemy's behaviour. */
type AiFn = (w: World, i: number) => void;

export const AI: Record<AiId, AiFn> = {
  chaser: seekChaser,
  swarmling: swaySeek,
  splitter: swaySeek,
  charger: chargeRunner,
  exploder: fuseRunner,
  armored: standoffOrbit,
  shooter: standoffShoot,
  grenadier: lobRunner,
  healer: supportRunner,
  // The two marks: a sniper that plants at range and an orbiter that circles at it. One file
  // because one bargain — the line is decided the tick the tell starts and nothing steers it
  // afterwards, which is what makes *moving* the answer to both.
  sniper: sniperRunner,
  orbiter: orbiterRunner,
  // The two that break the walking default: a body that crosses its painted line in one tick
  // and a body whose damage is other bodies.
  teleporter: teleporterRunner,
  spawner: spawnerRunner,
  // The third that stops travelling over the floor: it crosses its last few metres underneath
  // it, which is the one behaviour whose body has to leave the broad phase while it does.
  burrower: burrowRunner,
  // The three end-of-level encounters, beside the trash they turn up rather than apart from
  // it: the same `AiFn` shape, the same pooled `phase` and `timer`, no boss class of their own.
  brute: slamRunner,
  brooder: broodRunner,
  matron: matronRunner,
};
