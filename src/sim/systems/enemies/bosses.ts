/**
 * The three end-of-level encounters: the atlas's slam ring, the broodmother's broods and
 * the matron's volley-plus-aura.
 *
 * They are behaviours rather than reskinned bodies because each one asks for an answer the
 * trash already taught, turned up. Each one also keeps the answer inside the same rules the
 * trash used — a telegraph before the damage, travel through `drive`, a burst paid out by
 * the blast stack — so a boss is harder, not a different game.
 */

import { ENEMIES, enemyIndex } from '../../../content/enemies';
import { DT, Ev, Tele, TUNE, pushEvent, type World } from '../../world';
import { launchBolt } from '../enemyProjectiles';
import { queueBlast } from './deaths';
import { GOLDEN_ANGLE, Phase, drive, onBeat, seekDrive } from './shared';
import { spawnEnemy } from './spawn';
import { mendAura } from './support';

/**
 * Atlas: press to a ring, walk it, and slam whoever is standing inside the ring.
 *
 * The armored's ranged-orbit cousin, and the chapter's last word on the same lesson: the
 * way through a wall is round it. Its plate covers 57° either side of its facing and keeps
 * a quarter of itself on the flank, and its facing lags a third of a second behind where it
 * is going while it circles a 5.5 m ring at near cruise — so the gap in the shield is real,
 * widening, and has to be *walked* into rather than reached by one step sideways.
 *
 * The slam is centred on the body, which is the half of it that makes it a decision and not
 * a tax. It is spent only when the player is inside the burst's own reach, so it never
 * fires into empty floor the way a telegraphed weapon has to in order to look like one, and
 * its reach stops short of the ring it walks: standing out at band range is safe, crowding
 * it is not, and the 450 ms flash is long enough to walk from the middle of the circle to
 * outside it at the player's own speed. It also pays out through the blast stack, so the
 * escort walking alongside it catches the burst too.
 */
export function slamRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.phase[i] === Phase.Windup) {
    // Feet off the throttle for the whole flash — the charger's bargain, and the reason a
    // 4.6 m ring is answerable: a body that draws a circle does not move while it fills.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      queueBlast(w, enemies.x[i], enemies.y[i], def.params.blastRadius, def.params.blastDamage, 0);
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.slamGap;
    }
    return;
  }

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

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
  const ring = def.params.standoff;
  // Sideways drift plus a spring on the ring, the armored's own formula: it holds the
  // distance rather than sliding past it, so a player who runs is followed and a player who
  // stands still gets walked round.
  const orbit = def.params.orbit;
  const spin = (i & 1) === 0 ? 1 : -1;
  const drift = (d - ring) * 2;
  const speed = def.speed;
  drive(
    w,
    i,
    def,
    (-ny * orbit * spin + nx * drift) * speed,
    (nx * orbit * spin + ny * drift) * speed,
  );

  const reach = def.params.blastRadius + TUNE.playerRadius;
  if (d2 <= reach * reach && enemies.timer[i] <= 0) {
    enemies.phase[i] = Phase.Windup;
    enemies.timer[i] = def.params.slamWindup;
    // `Ring` at the body: the shape's radius is the burst's, which is the exact thing the
    // player has to leave, drawn for exactly as long as they have to leave it in.
    pushEvent(w, Ev.Telegraph, i, Tele.Ring, enemies.x[i], enemies.y[i]);
  }
}

/**
 * Broodmother: walk, and put broods of splinters down around itself until it runs out.
 *
 * It has no ranged attack and no burst aimed at the player, on purpose: its damage is the
 * crowd, so the lesson it teaches is the splitter's — kill it away from the pack — spent on
 * a body that repacks the room every three seconds. Dying in the middle of a ring of its
 * own children is the trap, and it is the same trap the player already met at wave three,
 * priced higher. By the fifth brood there is nothing behind it but 220 HP and a slow walk,
 * which is the right ending for a first boss: the answer never changes, only the company.
 *
 * `phase` counts the broods already loosed against the def's `spawnBroods`, because this
 * behaviour wants a countdown *and* a counter and the pool gives one clock per body. The
 * children land on a ring clear of the body (`spawnSpread` beyond the two radii), turned by
 * a stride of the slot so a brood does not drop in the same orientation every time, and at
 * full health: the cost of the mechanic is that the crowd already being shot gets bigger.
 */
export function broodRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.timer[i] > 0) {
    enemies.timer[i] -= DT;
  } else {
    enemies.timer[i] = def.params.spawnGap;
    if (enemies.phase[i] < def.params.spawnBroods) {
      enemies.phase[i]++;
      const split = def.splits;
      const child = split === undefined ? -1 : enemyIndex(split.def);
      if (child >= 0) {
        const childDef = ENEMIES[child];
        const count = def.params.spawnCount;
        const gap = def.radius + childDef.radius + def.params.spawnSpread;
        for (let k = 0; k < count; k++) {
          const a = k * ((Math.PI * 2) / count) + i * GOLDEN_ANGLE;
          spawnEnemy(w, child, enemies.x[i] + Math.cos(a) * gap, enemies.y[i] + Math.sin(a) * gap);
        }
      }
    }
  }

  seekDrive(w, i, def);
}

/**
 * Matron: hold the shooter's band, fan three bolts across it, and mend the pack.
 *
 * Two mechanics on one body, which is what a mid-run boss is for. The band is the shooter's
 * and wider — it will not work inside six metres, so the ground it stands on has to be
 * taken from it rather than given — and the pack that arrives beside it gets mended at
 * seven metres, so standing in the open trading shots with it is the losing side of the
 * trade. The three answers are the ones the trash taught: break the band, step off the
 * line, kill the support before the pack stops dying.
 *
 * Two clocks, deliberately unaligned: the volley runs on the pool's `timer` and the aura on
 * the body's own age, so the two mechanics do not land on the same beat and the player
 * cannot learn one rhythm and ignore the other. The fan is turned about the facing locked at
 * the flash, three bolts 7.5° apart, which is wide enough that a late step sideways still
 * walks into an outer bolt's line — and the i-frame gate then collapses what arrives into
 * one hit rather than three.
 */
export function matronRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  // The healer's aura, unaltered, on a clock of its own: the volley runs on the pool's
  // `timer` and this on the body's age, so the two mechanics never land on one beat.
  if (onBeat(enemies.age[i], def.params.healGap)) mendAura(w, i, def);

  if (enemies.phase[i] === Phase.Windup) {
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      const fx = enemies.fx[i];
      const fy = enemies.fy[i];
      const start = def.radius + TUNE.shotRadius + 0.1;
      const ox = enemies.x[i] + fx * start;
      const oy = enemies.y[i] + fy * start;
      const count = def.params.bolts;
      const fan = def.params.fan;
      // Turned about the locked facing, centre bolt first: the fan's width is what denies
      // the late dodge, and it costs no extra aim decision because the line was fixed when
      // the flash started, same bargain as the shooter's single bolt.
      for (let k = 0; k < count; k++) {
        const turn = (k - (count - 1) / 2) * fan;
        const c = Math.cos(turn);
        const s = Math.sin(turn);
        launchBolt(
          w,
          ox,
          oy,
          fx * c - fy * s,
          fx * s + fy * c,
          def.params.boltSpeed,
          def.params.boltDamage,
          def.params.boltLife,
        );
      }
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.shotGap;
    }
    return;
  }

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

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

  let vx = 0;
  let vy = 0;
  if (d > def.params.standMax) {
    vx = nx * def.speed;
    vy = ny * def.speed;
  } else if (d < def.params.standMin) {
    vx = -nx * def.speed;
    vy = -ny * def.speed;
  }
  drive(w, i, def, vx, vy);

  if (d >= def.params.standMin && d <= def.params.standMax && enemies.timer[i] <= 0) {
    enemies.fx[i] = nx;
    enemies.fy[i] = ny;
    enemies.phase[i] = Phase.Windup;
    enemies.timer[i] = def.params.windup;
    pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
  }
}