/**
 * The dispatch table: one small function per behaviour, keyed by the ai id the content
 * names, so an archetype stays data and a behaviour nobody wrote is a typecheck error
 * rather than an enemy that quietly stands still.
 *
 * `swarmling` and `splitter` share the stepper on purpose: what makes them different is how
 * fast they go and how wide they swing, and that is data. The ranged trio each get their own
 * because what they do between shots is genuinely different: hold a band, plant and lob, or
 * escort and mend.
 */

import { type AiId } from '../../../content/enemies';
import { type World } from '../../world';
import { slamRunner, broodRunner, matronRunner } from './bosses';
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
  // The three end-of-level encounters, beside the trash they turn up rather than apart from
  // it: the same `AiFn` shape, the same pooled `phase` and `timer`, no boss class of their own.
  brute: slamRunner,
  brooder: broodRunner,
  matron: matronRunner,
};
