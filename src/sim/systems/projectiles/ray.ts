/**
 * The three delivery paths that resolve instantly by marching through the tick's spatial
 * hash: the hitscan ray, the beam that re-runs the same march every tick it is held, and
 * the chain bolt that jumps body to body.
 *
 * They share `march` because they share the problem: a hit has to be attributed to the one
 * probe window that owns it, or a body straddling a window edge gets shot twice and a
 * piercing weapon spends its budget on the same flesh. The chain bolt shares the geometry
 * only loosely — it walks bodies rather than a line — but it reads the same query buffer,
 * so it lives with the two that do.
 *
 * Split out of `systems/projectiles.ts` with no behaviour change.
 */

import { ENEMIES } from '../../../content/enemies';
import { type WeaponDef } from '../../../content/weapons';
import { DT, TUNE, type World } from '../../world';
import { queryRadius } from '../../spatialHash';
import { blocked } from '../obstacles';
import { EPS, HIT_PAD, damage, falloff } from './shared';

/** Length of one probe window in metres, for the ray's march. */
const PROBE_STEP = 2;

/**
 * The bodies one chain bolt has already spent a jump on, reset by the bolt that uses
 * it. Longest chain in content is five jumps plus the first body, and the bolt stops
 * at the end of this array if content ever asks for more.
 */
const chainHits = new Int32Array(16);

/**
 * March a ray through the hash and let it hit.
 *
 * The ray advances in probe windows and queries the hash around each window centre
 * for everything that could possibly be touched inside it, then tests exactly: a
 * body counts only if the ray's *first entry point* into its disc falls inside the
 * window being examined. Ownership by entry point is what makes the march both
 * complete and single-counting — a body straddling a window edge is owned by the
 * window it entered, so the neighbouring window's overlapping query cannot spend a
 * second pierce on it — and the query radius is padded past the window's own length
 * plus the widest body so a body owned by a window is always inside that window's
 * query.
 *
 * Bodies wholly behind the ray's start are ignored (that is not what the gun was
 * pointed at), and the march stops the moment the pierce budget is gone, which is
 * the "no more" half of a piercing shot.
 *
 * `scale` is the time base of the charge (see `throughArmor` in `systems/status.ts`):
 * 1 for one instant ray, DT for a beam running this same march again every tick, where
 * `def.dmg` is damage per second. Both report their hits; only the burn stays quiet.
 */
function march(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
  scale: number,
): void {
  const enemies = w.enemies;
  const query = w.query;
  const reach = PROBE_STEP * 0.5 + HIT_PAD + 0.5;
  const base = def.dmg * w.stats.dmg;
  let budget = def.pierce + 1;
  // How far downrange the ray has already been cleared, so each window is tested against
  // the cover between it and the last one rather than against its own length only.
  let cleared = 0;

  for (let travelled = PROBE_STEP * 0.5; travelled < def.range && budget > 0; travelled += PROBE_STEP) {
    // The ray stops at the first wall it crosses. A sniper's sight line and a sniper's
    // shot have to agree or the cover in the layouts is scenery, and a hit two rooms
    // away is not a shot the player could have read.
    if (blocked(w.props, ox + dirx * cleared, oy + diry * cleared, ox + dirx * travelled, oy + diry * travelled, TUNE.shotRadius))
      break;
    cleared = travelled;

    const win = Math.floor(travelled / PROBE_STEP);
    const found = queryRadius(
      w.hash,
      enemies.x,
      enemies.y,
      w.hash.findable,
      ox + dirx * travelled,
      oy + diry * travelled,
      reach,
      query,
    );

    for (let k = 0; k < found && budget > 0; k++) {
      const j = query[k];
      if (enemies.hp[j] <= 0) continue;

      const enemy = ENEMIES[enemies.kind[j]];
      const hitR = TUNE.shotRadius + enemy.radius;

      const ex = enemies.x[j] - ox;
      const ey = enemies.y[j] - oy;
      const along = ex * dirx + ey * diry;
      if (along <= 0) continue;

      const d2 = ex * ex + ey * ey;
      // disc is the squared half-chord the ray cuts through the body's disc: no
      // chord, no hit. Written without a square root because that is the common case.
      const disc = hitR * hitR - (d2 - along * along);
      if (!(disc > 0)) continue;

      const raw = along - Math.sqrt(disc);
      const entry = raw > 0 ? raw : 0;
      if (entry > def.range) continue;
      if (Math.floor(entry / PROBE_STEP) !== win) continue;

      damage(w, def, j, base * falloff(def, entry), dirx, diry, -1, scale);
      budget--;
    }
  }
}

/** One instant ray: the sniper's shot, resolved the tick the trigger went down. */
export function castRay(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
): void {
  march(w, def, ox, oy, dirx, diry, 1);
}

/**
 * One tick of a beam: the same march, on the tick's time base.
 *
 * Called again every tick the trigger is held, which is what "continuous" means
 * here: the pierce budget renews each tick, so a beam cuts through its four bodies
 * sixty times a second until the barrel vents. It writes a `Hit` for each body each
 * tick — 240 events a second at the very most, four a frame, which is what the ring
 * is for — because a hit flash and a damage number have nothing else to read.
 */
export function castBeam(
  w: World,
  def: WeaponDef,
  ox: number,
  oy: number,
  dirx: number,
  diry: number,
): void {
  march(w, def, ox, oy, dirx, diry, DT);
}

/**
 * One chain bolt: take a body, then jump.
 *
 * The bolt starts at the muzzle and needs a body to start with — a bolt that finds
 * nobody is not fired and spends nothing — and then walks to the closest body it has
 * not already hurt within `chainRadius` of where it stands, up to `chain` jumps. Bodies
 * at 0 HP are skipped, so a bolt cannot spend a jump on a corpse, and the list of
 * bodies it has used lives in one module-scratch array rather than in a set it would
 * have to allocate per shot.
 *
 * A jump starts from the *body's* position even when the previous link died, because
 * arcing through a corpse is what the weapon looks like doing. Distance — and so the
 * falloff — is measured along the bolt's path, not as the crow flies, so a bolt that
 * zigzags through a pack pays for it.
 *
 * Returns the number of bodies it hurt, which is 0 when there was nothing to hit.
 */
export function castChain(w: World, def: WeaponDef, x: number, y: number): number {
  const enemies = w.enemies;
  const query = w.query;
  const jump = def.chainRadius || 0;
  const budget = (def.chain || 0) + 1;
  const base = def.dmg * w.stats.dmg;
  if (jump <= 0) return 0;

  let cx = x;
  let cy = y;
  let travelled = 0;
  let links = 0;

  for (let hop = 0; hop < budget && links < chainHits.length; hop++) {
    // The first hop reaches the whole acquisition radius from the muzzle; after that
    // the bolt only has to find a body within one jump of the last one.
    const r = hop === 0 ? def.range : jump;
    const found = queryRadius(w.hash, enemies.x, enemies.y, w.hash.findable, cx, cy, r, query);

    let next = -1;
    let best2 = Infinity;
    for (let k = 0; k < found; k++) {
      const j = query[k];
      if (enemies.hp[j] <= 0) continue;

      let used = false;
      for (let u = 0; u < links; u++) {
        if (chainHits[u] === j) {
          used = true;
          break;
        }
      }
      if (used) continue;

      const jx = enemies.x[j] - cx;
      const jy = enemies.y[j] - cy;
      const d2 = jx * jx + jy * jy;
      if (d2 >= best2) continue;
      best2 = d2;
      next = j;
    }
    if (next < 0) break;

    const dx = enemies.x[next] - cx;
    const dy = enemies.y[next] - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    travelled += d;
    // A jump of no length (two bodies on one point) has no direction to shove along,
    // so it takes the +x pair, as a sweep on a body dead centre does.
    let shx = 1;
    let shy = 0;
    if (d > EPS) {
      shx = dx / d;
      shy = dy / d;
    }
    damage(w, def, next, base * falloff(def, travelled), shx, shy, -1, 1);

    chainHits[links++] = next;
    cx = enemies.x[next];
    cy = enemies.y[next];
  }

  return links;
}
