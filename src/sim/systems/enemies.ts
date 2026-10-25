/**
 * Enemy pass: behaviours, contact damage, deaths and what a death leaves behind.
 *
 * `AI` is the dispatch table: one small function per behaviour, keyed by the ai id the
 * content names, so an archetype stays data and a behaviour nobody wrote is a
 * typecheck error rather than an enemy that quietly stands still. A behaviour writes
 * only through the pooled arrays and keeps its state machine in the pool's `phase` and
 * `timer` slots, so nothing here allocates.
 *
 * Three rules hold the file together, because eight behaviours written eight ways
 * read as eight bugs rather than as a horde:
 *
 * - **Movement is a velocity plus `advance`,** never a jump. Separation, the speed cap,
 *   the facing and the arena clamp all hang off that one path, and the interpolation the
 *   renderer does between steps only means something if a body travelled through the
 *   space between its old position and its new one.
 * - **A tell is an event.** Anything the player is asked to answer — a charge line, a
 *   filling ring — announces itself the tick it starts and leaves a `timer` behind for as
 *   long as it lasts, so presentation never has to guess what a body is about to do.
 * - **Nothing detonates inside the kill.** A blast is queued where the death happens and
 *   paid out later in the tick by `resolveBlasts`, because the kill happens in the middle
 *   of a shot that is still walking the tick's one shared query buffer, and because a
 *   blast that kills a second bomber wants a stack to land on rather than recursion.
 *
 * The ranged trio also owes one rule of its own: a shot is *triggered* here and *delivered*
 * by `systems/enemyProjectiles.ts`, mirroring how the player's weapons hand their rounds to
 * `systems/projectiles.ts`. A behaviour that wants to shoot spends a pool slot and an event
 * and gets on with its movement; everything that happens after the trigger — the flight,
 * the hit test against the player, the burst — lives one file away.
 */

import { ENEMIES, enemyIndex, type AiId, type EnemyDef } from '../../content/enemies';
import { ELITES, type EliteDef } from '../../content/levels';
import { range } from '../rng';
import { queryRadius } from '../spatialHash';
import { DT, Ev, Tele, TUNE, alloc, pushEvent, release, type World } from '../world';
import { hurtPlayer, launchBolt, lobGrenade } from './enemyProjectiles';
import { eliteRoster, rollElite, travelScale } from './powerups';

/** One tick of one enemy's behaviour. */
type AiFn = (w: World, i: number) => void;

/**
 * Keys are the ai ids in content/enemies.ts and the record has to cover all of them,
 * which is what makes adding an id without adding a behaviour fail the typecheck.
 *
 * The swarmling and the splitter share the stepper on purpose: what makes them different
 * is how fast they go and how wide they swing, and that is data. The ranged trio each get
 * their own because what they do between shots is genuinely different: hold a band, plant
 * and lob, or escort and mend.
 */
const AI: Record<AiId, AiFn> = {
  chaser: seekChaser,
  swarmling: swaySeek,
  splitter: swaySeek,
  charger: chargeRunner,
  exploder: fuseRunner,
  armored: standoffOrbit,
  shooter: standoffShoot,
  grenadier: lobRunner,
  healer: supportRunner,
};

/** Separation stops paying for itself past this many neighbours examined. */
const SEP_CAP = 24;

/**
 * Behaviour phases, in the pool's `phase` slot.
 *
 * Kept beside `state` rather than inside it because a behaviour's phase and the stagger a
 * hit gives it are two facts that have to survive each other: a charger knocked out of its
 * wind-up is still a charger in a wind-up, it is just reeling.
 */
const Phase = { Seek: 0, Windup: 1, Dash: 2, Recover: 3, Fuse: 4, Orbit: 5 } as const;

/**
 * How many blasts deep one detonation may chain.
 *
 * Four is enough to empty a chamber of bombers and still finite, which is the point: with
 * no depth in it, a run can end on the tick a grenadier is shot, because every bomb that
 * died went off inside every other one's radius, in one tick, forever.
 */
const MAX_BLAST_CHAIN = 4;

/** The golden angle, in radians. See `spawnEnemy` and `killEnemy` for what it does. */
const GOLDEN_ANGLE = 2.399_963_229_728_653;

/**
 * How far the body being stepped through is allowed to travel this tick, as a fraction
 * of its own velocity.
 *
 * One module-scratch scalar rather than an argument, for the same reason `w.blasts.depth`
 * and `chainHits` are scratch: it is a fact about the body currently being handled, it
 * never outlives the tick, and threading it through `drive` and `face` and the four
 * behaviours that call `advance` would put a number about *slowness* in six signatures
 * that have nothing to do with slowness. Written once per body at the top of the loop in
 * `updateEnemies`, read once per travel step in `advance`.
 */
let travel = 1;

/** The variant a body came in as, or undefined for a plain one. */
function eliteOf(w: World, i: number): EliteDef | undefined {
  const at = w.enemies.elite[i];
  return at === 0 ? undefined : ELITES[at - 1];
}

/**
 * Put an enemy of `def` at (x, y), healthy and with its archetype's HP.
 *
 * Shared by the wave spawner, the debug spawn hook and the tests, so a spawned enemy
 * always starts the way content says it does. The position is pulled inside the arena by
 * its own radius, because those three callers each have their own idea of where a body may
 * go and only the clamp has to be the same answer in all of them. Returns the slot, or -1
 * when the pool is full.
 */
export function spawnEnemy(w: World, def: number, x: number, y: number): number {
  const i = alloc(w.enemies);
  if (i < 0) return -1;
  const enemy = w.enemies;
  const shape = ENEMIES[def];
  const px = Math.min(Math.max(x, w.minX + shape.radius), w.maxX - shape.radius);
  const py = Math.min(Math.max(y, w.minY + shape.radius), w.maxY - shape.radius);
  enemy.x[i] = px;
  enemy.y[i] = py;
  enemy.kind[i] = def;

  // The variant is rolled here rather than in the spawner because three doors put bodies
  // down (the wave clock, the debug hook and a splitter's children) and only the last one
  // would remember to ask. `rollElite` draws nothing on a chapter that declares no
  // variants, so the seeded runs that predate them are untouched.
  const variant = rollElite(w, eliteRoster(w));
  const elite = variant >= 0 ? ELITES[variant] : undefined;
  if (elite !== undefined) enemy.elite[i] = variant + 1;

  enemy.hp[i] = elite === undefined ? shape.hp : shape.hp * elite.hp;

  // A body arrives looking at the player, which is the honest default — it is what it
  // will be walking toward — and it means directional armour has something to read on the
  // tick a body appears. A zero facing reads as unarmoured in `armorAgainst`, so leaving
  // the facing to be derived would make the first shot at every armored a free one.
  const dx = w.player.x - px;
  const dy = w.player.y - py;
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    enemy.fx[i] = dx / d;
    enemy.fy[i] = dy / d;
  } else {
    enemy.fx[i] = 1;
    enemy.fy[i] = 0;
  }

  // The weave offset for the bodies that weave, taken from the slot rather than from
  // world.rng: a stride of the golden angle puts consecutive slots as far apart in phase as
  // they can be, so a cloud of forty arrives spread across its own approach instead of
  // swinging as one. Cheaper than a draw, and it does not shift the random stream that
  // every seeded test downstream of here reads.
  if ((shape.params.swayAmp ?? 0) > 0) enemy.timer[i] = (i * GOLDEN_ANGLE) % (Math.PI * 2);

  pushEvent(w, Ev.Spawn, i, def, px, py);
  return i;
}

/**
 * Run every live enemy's behaviour, then let it hit the player.
 *
 * Also leaves `enemyNear` and `nearest` behind: the closest enemy measured before anything
 * moved, which is what the auto-fire decision reads and where it points. Enemies already
 * at 0 HP are skipped — the damage pass that killed them has already dropped their shard
 * and given the slot back.
 *
 * A staggering body skips its behaviour and rides the shove it was given, which is what
 * makes knockback a positioning tool as well as a number: three ticks of not-steering is
 * enough to spoil a charger's line and to turn an armored's shield aside.
 */
export function updateEnemies(w: World): void {
  const enemies = w.enemies;
  const player = w.player;
  let nearest2 = Infinity;
  let nearestSlot = -1;

  for (let i = 0; i < enemies.cap; i++) {
    if (enemies.alive[i] === 0) continue;
    if (enemies.hp[i] <= 0) continue;

    const dx = player.x - enemies.x[i];
    const dy = player.y - enemies.y[i];
    const d2 = dx * dx + dy * dy;
    if (d2 < nearest2) {
      nearest2 = d2;
      nearestSlot = i;
    }

    const def = ENEMIES[enemies.kind[i]];
    // The body's own clock, which is what the weave swings on: a body that arrives late is
    // already mid-swing rather than starting its sway from zero like a clone.
    enemies.age[i] += DT;

    // How far this body may get this tick, written once here for every travel step it
    // takes (a staggering body takes one, a behaviour that steers and drives takes one, a
    // charger's dash takes one and its follow-up walk another). Measured before anything
    // moved, for the same reason `d2` above is: the stasis field asks where the body *was*
    // relative to the player, and answering it after the walk is a field that reaches half
    // a metre short of where it looks like it does.
    travel = travelScale(w, enemies.x[i], enemies.y[i], eliteOf(w, i)?.gait ?? 1);

    if (enemies.state[i] > 0) {
      enemies.state[i]--;
      advance(w, i, def);
    } else {
      AI[def.ai](w, i);
      // A behaviour may spend its own body: an exploder that finishes its fuse takes
      // itself with it, and a slot already back in the free list has no contact to make.
      // Tested on `alive` rather than `hp` because the question is the slot, not the health.
      if (enemies.alive[i] === 0) continue;
    }

    contact(w, def, d2);
  }

  if (nearestSlot === -1) {
    w.enemyNear = Infinity;
    w.nearest = -1;
  } else {
    w.enemyNear = Math.sqrt(nearest2);
    w.nearest = nearestSlot;
  }
}

/**
 * Seek the player through the crowd.
 *
 * The plain case: no wind-up, no fuse, nothing to read before it reaches you. It steers
 * at the player and shoves neighbours out of its personal space, so the pack presses as a
 * crowd with gaps instead of one overlapping blob (DESIGN.md: the horde has to stay
 * readable), and that is the whole behaviour — which is why the four bodies added beside it
 * did not need four copies of this.
 */
function seekChaser(w: World, i: number): void {
  seekDrive(w, i, ENEMIES[w.enemies.kind[i]]);
}

/**
 * Straight-line seek at the archetype's cruise speed, through the crowd.
 *
 * Kept to one call so the separation, the speed cap and the facing are the same answer for
 * every body that simply walks at you, and so a new archetype that only needs to walk is
 * one data entry rather than one function.
 */
function seekDrive(w: World, i: number, def: EnemyDef): void {
  const enemies = w.enemies;
  const player = w.player;
  let vx = 0;
  let vy = 0;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    vx = (dx / d) * def.speed;
    vy = (dy / d) * def.speed;
  }
  drive(w, i, def, vx, vy);
}

/**
 * Seek with a weave across the line of approach: the swarmling's jittered seek, and the
 * splitter's slower and wider lurch.
 *
 * The swing is a sine on the body's own clock, offset by an angle its slot gave it, and it
 * is a rotation of the aim rather than noise added to it: a body still steers at the player
 * and drifts across that line, so it keeps closing instead of wandering off, and it costs
 * one `Math.sin` a tick with no random number and no state to age. That is the whole reason
 * a cloud of forty of them cannot be deleted by one shot fired down the middle.
 */
function swaySeek(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  let vx = 0;
  let vy = 0;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;

  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;
    const amp = def.params.swayAmp ?? 0;
    const hz = def.params.swayHz ?? 0;
    let swing = 0;
    if (amp > 0 && hz > 0) {
      swing = Math.sin(enemies.age[i] * hz * Math.PI * 2 + enemies.timer[i]) * amp;
    }
    const c = Math.cos(swing);
    const s = Math.sin(swing);
    vx = (nx * c - ny * s) * def.speed;
    vy = (nx * s + ny * c) * def.speed;
  }

  drive(w, i, def, vx, vy);
}

/**
 * Charger: stalk, lock a line, stop, dash it, recover. Four phases on one timer.
 *
 * The line is decided the tick it commits and does not move after that, so the answer to a
 * charger is to *move*, not to shoot faster — which is the difference between a telegraph
 * and a decoration. Half a second of wind-up is thirty ticks of it, past the 0.4 s
 * DESIGN.md sets as the floor for anything a player is asked to read and answer, and the
 * tell goes into the event ring the tick it starts, thirty ticks before the velocity does.
 *
 * `nearRange` is why a charge cannot be wasted on a body already in contact: a dash from
 * arm's length has no room to be read, and a charger that never stops is only a faster
 * chaser with a bigger number on it.
 */
function chargeRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const phase = enemies.phase[i];

  if (phase === Phase.Windup) {
    // Feet off the throttle, line drawn: this is the window the player has in it.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Dash;
      enemies.timer[i] = def.params.dashTime;
    }
    return;
  }

  if (phase === Phase.Dash) {
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Recover;
      enemies.timer[i] = def.params.recover;
      enemies.vx[i] = 0;
      enemies.vy[i] = 0;
      return;
    }
    // Straight down the locked line at thirteen metres a second — four times its cruise —
    // and deliberately without separation: a charge that steers around the crowd in front
    // of it is a homing missile, and that is a different monster.
    const speed = def.params.dashSpeed;
    enemies.vx[i] = enemies.fx[i] * speed;
    enemies.vy[i] = enemies.fy[i] * speed;
    advance(w, i, def);
    return;
  }

  if (phase === Phase.Recover) {
    // The punish for a missed charge: it stands where it overshot for two thirds of a
    // second, side on, with its line empty.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.stalk;
    }
    return;
  }

  // Stalk. The timer here is the cooldown before it will commit again, so a charger that
  // has just finished a cycle walks for `stalk` seconds before it locks another line.
  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;

  if (d2 > 1e-12 && enemies.timer[i] <= 0) {
    const d = Math.sqrt(d2);
    if (d <= def.params.armRange && d >= def.params.nearRange) {
      enemies.fx[i] = dx / d;
      enemies.fy[i] = dy / d;
      enemies.vx[i] = 0;
      enemies.vy[i] = 0;
      enemies.phase[i] = Phase.Windup;
      enemies.timer[i] = def.params.windup;
      // `b` says which shape to draw; the body's `fx`/`fy` say where it points and its
      // `timer` says how much of the wind-up is left, which is everything a charge line
      // needs and none of it needs a per-event object.
      pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
      return;
    }
  }

  seekDrive(w, i, def);
}

/**
 * Exploder: walk, and cook once it is close enough to matter.
 *
 * It keeps walking through the fuse, because a bomb you can walk around is fine and one
 * that follows you for half a second at three metres a second is a threat you step out of.
 * The half second is measured from three point six metres and the burst reaches 3.2, so a
 * player who stands still eats it and a player who keeps moving does not — and the fuse
 * runs out before contact range does, which is deliberate: its damage is the burst, not the
 * hug, and a burst spent inside the i-frames a hug already spent is damage that silently
 * does not exist.
 *
 * Both of its endings go through one call. Shot or fused, it pays out exactly one blast at
 * the place it died, which is also why that blast is queued here and spent later.
 */
function fuseRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.phase[i] === Phase.Fuse) {
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      killEnemy(w, i);
      return;
    }
    seekDrive(w, i, def);
    return;
  }

  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  const arm = def.params.armRange;

  if (d2 > 1e-12 && d2 <= arm * arm) {
    enemies.phase[i] = Phase.Fuse;
    enemies.timer[i] = def.params.fuseTime;
    pushEvent(w, Ev.Telegraph, i, Tele.Ring, enemies.x[i], enemies.y[i]);
  }

  seekDrive(w, i, def);
}

/**
 * Armored: close, then circle at arm's length.
 *
 * It stops at a four metre ring rather than pressing into the player, and spends most of
 * its speed going sideways — which is what makes its plate a positioning puzzle instead of
 * a tax. Its facing follows where it is going and lags that by a quarter of a second, so a
 * body walking in a circle presents its flank to the middle of it. Running past one, or
 * knocking it sideways and shooting the flat side, is the answer to it; standing in front
 * of it and holding the trigger is not.
 */
function standoffOrbit(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;
  const dx = player.x - enemies.x[i];
  const dy = player.y - enemies.y[i];
  const d2 = dx * dx + dy * dy;
  const ring = def.params.standoff;

  if (d2 > ring * ring) {
    const d = Math.sqrt(d2);
    enemies.phase[i] = Phase.Seek;
    drive(w, i, def, (dx / d) * def.speed, (dy / d) * def.speed);
    return;
  }
  if (d2 <= 1e-12) {
    drive(w, i, def, 0, 0);
    return;
  }

  enemies.phase[i] = Phase.Orbit;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  // Half the pack circles one way and half the other, by slot parity: no extra state to
  // carry, and a pair that arrives together does not march in single file.
  const spin = (i & 1) === 0 ? 1 : -1;
  const orbit = def.params.orbit;
  // Sideways travel plus a spring on the ring, so it holds the distance instead of sliding
  // past it, and so a player who runs away is followed rather than watched.
  const drift = (d - ring) * 2;
  const speed = def.speed;
  const vx = (-ny * orbit * spin + nx * drift) * speed;
  const vy = (nx * orbit * spin + ny * drift) * speed;
  drive(w, i, def, vx, vy);
}

/**
 * Shooter: hold a band, plant, flash, fire.
 *
 * The armored's ranged cousin: it also refuses to press in, but where the armored
 * circles to present a plate the shooter stops to deliver a bolt. `standMin` and
 * `standMax` are the band it works at — past `standMax` it closes, inside `standMin`
 * it gives ground, in between it plants; `windup` is the seconds of red flash before
 * the bolt leaves, at DESIGN.md's 400 ms floor and read across a crowd because the
 * bolt is slow; `shotGap` is the seconds of cooldown between volleys; and the bolt
 * itself carries `boltSpeed`, `boltDamage` and `boltLife`.
 *
 * The line is locked the tick the flash starts and does not steer after it, which is
 * what makes the telegraph worth answering: a bolt that curved to follow you would
 * punish exactly the players who read it. The shot itself is spent one file away in
 * `enemyProjectiles.ts` — this function only decides when to pull the trigger, and
 * keeps its feet busy in between.
 */
function standoffShoot(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  if (enemies.phase[i] === Phase.Windup) {
    // Feet off the throttle for the whole flash, same bargain as the charger's
    // wind-up: a thirty-tick window to step off a line that will not steer.
    enemies.vx[i] = 0;
    enemies.vy[i] = 0;
    enemies.timer[i] -= DT;
    if (enemies.timer[i] <= 0) {
      // Fired down the locked facing, starting clear of the body so the first step
      // of its sweep cannot start inside anything.
      const fx = enemies.fx[i];
      const fy = enemies.fy[i];
      const start = def.radius + TUNE.shotRadius + 0.1;
      launchBolt(
        w,
        enemies.x[i] + fx * start,
        enemies.y[i] + fy * start,
        fx,
        fy,
        def.params.boltSpeed,
        def.params.boltDamage,
        def.params.boltLife,
      );
      enemies.phase[i] = Phase.Seek;
      enemies.timer[i] = def.params.shotGap;
    }
    return;
  }

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

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
    // The `Line` shape is the sniper's thin sight (DESIGN.md): drawn from the
    // locked facing for as long as the body's timer says wind-up is left.
    pushEvent(w, Ev.Telegraph, i, Tele.Line, enemies.x[i], enemies.y[i]);
  }
}

/**
 * Grenadier: walk to lob range, plant, and ring the player's feet.
 *
 * `lobRange` is how far it will throw and `lobMin` how close it will throw from;
 * outside the band it walks (closing, or backing away when the player has inside
 * itself on it — the same reasoning as the charger's `nearRange`: a threat with no
 * room to be read is not a telegraph, it is just damage). Inside, it plants and
 * lobs on `lobGap` seconds.
 *
 * The lob lands where the player was when it went up. The flight is the throw
 * distance over `arcSpeed`, and the band's floor is four metres against a bomb that
 * travels ten, so a ring only ever opens with at least 0.4 s of fill in it — read
 * the ring, walk out of it, and the lob spent itself on empty floor. The ring
 * announces itself at the landing point (`Tele.RingAt`, whose centre is the event's
 * x/y) the tick the grenade leaves the body, and the grenade carries the fill.
 */
function lobRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];
  const player = w.player;

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

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

  if (d > def.params.lobRange) {
    drive(w, i, def, nx * def.speed, ny * def.speed);
    return;
  }
  if (d < def.params.lobMin) {
    drive(w, i, def, -nx * def.speed, -ny * def.speed);
    return;
  }

  // In the band: plant, and lob on the beat. The ring and the grenade go out on the
  // same tick, at the player's feet as read now — the point the dodge test walks
  // out of, and the point the standing player is still on when the ring fills.
  drive(w, i, def, 0, 0);

  if (enemies.timer[i] <= 0) {
    enemies.timer[i] = def.params.lobGap;
    pushEvent(w, Ev.Telegraph, i, Tele.RingAt, player.x, player.y);
    lobGrenade(
      w,
      enemies.x[i],
      enemies.y[i],
      nx,
      ny,
      def.params.arcSpeed,
      d / def.params.arcSpeed,
      def.params.blastDamage,
      def.params.blastRadius,
    );
  }
}

/** Neighbours one heal pulse examines, the same kind of cap `SEP_CAP` is. */
const HEAL_SCAN_CAP = 64;

/** Seconds a healer re-reads for wounded allies when the last read found none. */
const HEAL_RETRY = 0.5;

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
 *
 * The pulse reads the tick's shared query buffer before the movement below can
 * refill it, same one-buffer rule as everything else in this file.
 */
function supportRunner(w: World, i: number): void {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[i]];

  if (enemies.timer[i] > 0) enemies.timer[i] -= DT;

  if (enemies.timer[i] <= 0) {
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
      // One event per pulse, not per mended body: the aura is one thing on screen
      // even when it catches six bodies, and `b` carries its radius for the ring.
      pushEvent(w, Ev.Heal, i, Math.round(def.params.healRange * 10), enemies.x[i], enemies.y[i]);
      enemies.timer[i] = def.params.healGap;
    } else {
      enemies.timer[i] = HEAL_RETRY;
    }
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

/**
 * Steer `vx`/`vy` through the crowd, then move.
 *
 * The shared half of every behaviour: personal space, a cap so a shove cannot make a body
 * faster than its own gait, the facing that directional armour and the shield quad are read
 * from, and one travel step that keeps the whole body inside the arena.
 */
function drive(w: World, i: number, def: EnemyDef, vx: number, vy: number): void {
  const enemies = w.enemies;
  const sepRadius = def.params.sepRadius;
  const push = def.params.sepPush;
  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    enemies.alive,
    enemies.x[i],
    enemies.y[i],
    sepRadius,
    w.query,
  );
  const seen = found < SEP_CAP ? found : SEP_CAP;
  for (let k = 0; k < seen; k++) {
    const j = w.query[k];
    if (j === i || enemies.hp[j] <= 0) continue;
    const ox = enemies.x[i] - enemies.x[j];
    const oy = enemies.y[i] - enemies.y[j];
    const o2 = ox * ox + oy * oy;
    if (o2 >= sepRadius * sepRadius || o2 <= 1e-12) continue;
    const od = Math.sqrt(o2);
    const weight = (1 - od / sepRadius) * push;
    vx += (ox / od) * weight;
    vy += (oy / od) * weight;
  }

  // Cap the sum so a shove cannot make a walker faster than its own dash. The charger's
  // dash sets its velocity directly and never comes through here, which is the point: a
  // charge is supposed to be faster than a walk.
  const cap = def.speed * 1.35;
  const speed2 = vx * vx + vy * vy;
  if (speed2 > cap * cap) {
    const k = cap / Math.sqrt(speed2);
    vx *= k;
    vy *= k;
  }

  enemies.vx[i] = vx;
  enemies.vy[i] = vy;
  face(w, i, def, vx, vy);
  advance(w, i, def);
}

/**
 * Turn the body's front toward where it is actually going.
 *
 * A lag rather than a snap, and a renormalise after it: lerping a unit vector toward
 * another shortens it, and `armorAgainst` reads a dot product, so a facing allowed to
 * shrink would quietly make armour weaker the harder a body turned. The low-`faceLag` cases
 * are the interesting ones — the armored turns slowly enough that flanking it is something
 * a player does on purpose.
 */
function face(w: World, i: number, def: EnemyDef, vx: number, vy: number): void {
  const enemies = w.enemies;
  const speed2 = vx * vx + vy * vy;
  if (speed2 <= 1e-12) return;

  const speed = Math.sqrt(speed2);
  const tx = vx / speed;
  const ty = vy / speed;
  let fx = enemies.fx[i];
  let fy = enemies.fy[i];

  if (fx === 0 && fy === 0) {
    enemies.fx[i] = tx;
    enemies.fy[i] = ty;
    return;
  }

  // A body that declares no `faceLag` turns instantly: the number is a lag, so a big one
  // means no lag, and the clamp keeps a big one from overshooting the heading it wants.
  const lag = def.params.faceLag ?? 64;
  const k = Math.min(1, lag * DT);
  fx += (tx - fx) * k;
  fy += (ty - fy) * k;
  const n2 = fx * fx + fy * fy;
  if (n2 > 1e-12) {
    const n = 1 / Math.sqrt(n2);
    enemies.fx[i] = fx * n;
    enemies.fy[i] = fy * n;
  } else {
    enemies.fx[i] = tx;
    enemies.fy[i] = ty;
  }
}

/** One tick of travel, kept inside the arena so a pack cannot flank through a wall. */
function advance(w: World, i: number, def: EnemyDef): void {
  const enemies = w.enemies;
  // `travel` is this body's fraction, set once per body in `updateEnemies` — see there
  // for why it is a module slot rather than an argument. At 1 it costs one multiply.
  enemies.x[i] += enemies.vx[i] * DT * travel;
  enemies.y[i] += enemies.vy[i] * DT * travel;
  enemies.x[i] = Math.min(Math.max(enemies.x[i], w.minX + def.radius), w.maxX - def.radius);
  enemies.y[i] = Math.min(Math.max(enemies.y[i], w.minY + def.radius), w.maxY - def.radius);
}

/**
 * The armour one hit has to get through, given the direction it travelled.
 *
 * Directional only for a body that declares `armorArc` and `armorSide`. A body that
 * declares neither reads as "no arc, full plate all round" — the two defaults fold back to
 * the flat number, which is every archetype except the armored, and is why the reads below
 * use `??` instead of an existence test: `params` is a record of numbers, so a missing key
 * is a number-shaped hole and the neutral value has to be named.
 *
 * Inside the arc — a hit arriving from within `armorArc`'s cosine of the body's front — it
 * pays its full plate; anywhere else it pays `armorSide` of it, which the armored sets to
 * nothing.
 *
 * `dirx`/`diry` point *along* the damage, from its source toward the body, so a hit that
 * came from the front runs against the facing and the dot product goes negative. That is why
 * the plate test is one comparison and not an angle.
 */
export function armorAgainst(w: World, j: number, dirx: number, diry: number): number {
  const enemies = w.enemies;
  const def = ENEMIES[enemies.kind[j]];
  if (def.armor <= 0) return 0;

  const arc = def.params.armorArc ?? 0;
  const side = def.params.armorSide ?? 1;
  if (arc <= 0 || side >= 1) return def.armor;

  const fx = enemies.fx[j];
  const fy = enemies.fy[j];
  if (fx === 0 && fy === 0) return def.armor;

  return dirx * fx + diry * fy < -arc ? def.armor : def.armor * side;
}

/** Metres a Hot Plate pulse reaches around the player. */
const THORNS_REACH = 2.4;

/**
 * Contact damage, gated by i-frames, and the Hot Plate's answer to it.
 *
 * The pulse is gated on the same i-frame window as the hug rather than on the body that
 * triggered it: a crowd that piles in costs one thorns pulse, not one per body, because
 * the gate at the top returns for everyone after the first touch. `d2` is the squared
 * distance from before either of them moved.
 */
function contact(w: World, def: EnemyDef, d2: number): void {
  const player = w.player;
  if (!player.alive || player.iframes > 0) return;

  const reach = TUNE.playerRadius + def.radius + def.params.touchRange;
  if (d2 > reach * reach) return;

  // The hug goes through the one player-damage gate, so armour, the barrier and a
  // curse's fragility read the same for a body's touch as for a bolt's.
  hurtPlayer(w, def.params.touchDamage, 3);

  const thorns = w.stats.thorns;
  if (thorns > 0) thornsPulse(w, thorns);
}

/**
 * Hot Plate: every body inside a short ring around the player pays when the player is
 * hit — the explosion a thorns power-up is meant to read as. It goes through armour and
 * finishes bodies with `killEnemy`, so a pulse spent in a crowd actually thins it rather
 * than only bruising it.
 *
 * It spends the tick's query buffer, which is free here: contact runs after the body's
 * own steering has finished querying it, and the next body refills the buffer before it
 * reads anything.
 */
function thornsPulse(w: World, thorns: number): void {
  const enemies = w.enemies;
  const found = queryRadius(
    w.hash,
    enemies.x,
    enemies.y,
    enemies.alive,
    w.player.x,
    w.player.y,
    THORNS_REACH,
    w.query,
  );

  for (let k = 0; k < found; k++) {
    const j = w.query[k];
    if (enemies.hp[j] <= 0) continue;

    const def = ENEMIES[enemies.kind[j]];
    let dealt = thorns - def.armor;
    if (dealt < 1) dealt = 1;
    enemies.hp[j] -= dealt;
    pushEvent(w, Ev.Hit, -1, j, enemies.x[j], enemies.y[j]);
    if (enemies.hp[j] <= 0) killEnemy(w, j);
  }
}

/**
 * Put a burst on the stack instead of resolving it.
 *
 * Returns false and counts the loss when the stack is full, which at thirty-two waiting
 * bursts means the floor is already on fire and one more would not be the thing that decides
 * the run. Counting it is the point: a burst that vanished silently is a bug nobody sees.
 */
function queueBlast(w: World, x: number, y: number, r: number, dmg: number, depth: number): boolean {
  const stack = w.blasts;
  if (stack.count >= stack.cap) {
    stack.dropped++;
    return false;
  }
  const at = stack.count++;
  stack.x[at] = x;
  stack.y[at] = y;
  stack.r[at] = r;
  stack.dmg[at] = dmg;
  stack.chain[at] = depth;
  return true;
}

/**
 * Kill a dead enemy: score, the kill event, the XP shard the body drops, and whatever it
 * takes with it.
 *
 * Called from the damage pass the moment a hit takes an enemy to 0 HP rather than from a
 * sweep at the end of the tick, because a corpse left in the pool for a tick still blocks
 * the crowd and still takes shots. Releasing the slot here is also what keeps a second shot
 * in the same tick from spending a pierce on it: the hash query skips dead slots.
 *
 * Shard `kind` carries the archetype, which is where its XP value comes from.
 *
 * The two legacies a death can leave are both read from the body while it is still in its
 * slot, which is why they sit above the release: a blast is queued for `resolveBlasts` to
 * spend later in the tick, and the children a splitter comes apart into are put down around
 * where it stood, so a splitter killed in the middle of the room is a different situation
 * from one killed with its back to a wall.
 */
export function killEnemy(w: World, i: number): void {
  const enemies = w.enemies;
  const shards = w.shards;
  const def = ENEMIES[enemies.kind[i]];

  w.kills++;
  w.score += def.xp * 10;
  pushEvent(w, Ev.Kill, i, enemies.kind[i], enemies.x[i], enemies.y[i]);

  const s = alloc(shards);
  if (s >= 0) {
    shards.x[s] = enemies.x[i];
    shards.y[s] = enemies.y[i];
    // A small arc off the body, so a death burst scatters instead of stacking
    // every shard on one point.
    shards.vx[s] = range(w.rng, -1.2, 1.2);
    shards.vy[s] = range(w.rng, -1.2, 1.2);
    shards.kind[s] = enemies.kind[i];
    shards.life[s] = TUNE.shardLife;
  }

  const radius = def.params.blastRadius;
  if (radius !== undefined && radius > 0) {
    queueBlast(w, enemies.x[i], enemies.y[i], radius, def.params.blastDamage, w.blasts.depth);
  }

  const split = def.splits;
  if (split !== undefined) {
    const child = enemyIndex(split.def);
    if (child >= 0) {
      const childDef = ENEMIES[child];
      const gap = def.radius + childDef.radius + 0.18;
      // Evenly spaced, turned by a stride of the slot so a splitter does not always put its
      // children down in the same orientation. They arrive at full health, which is the cost
      // of the mechanic: three bodies that run most of the speed of the gun that just killed
      // their parent.
      for (let k = 0; k < split.count; k++) {
        const a = k * ((Math.PI * 2) / split.count) + i * GOLDEN_ANGLE;
        spawnEnemy(w, child, enemies.x[i] + Math.cos(a) * gap, enemies.y[i] + Math.sin(a) * gap);
      }
    }
  }

  release(enemies, i);
}

/**
 * Pay out the bursts the tick has built up, once per tick, after the weapons have run.
 *
 * Later than the kills that queued them for two reasons, and they are the reason blasts are
 * a stack at all: a shot resolving a pierce is still walking the tick's one shared query
 * buffer, and a blast that queried it there would rewrite the list the shot is standing in;
 * and a burst that kills a second bomber queues another burst, which wants a place to land
 * rather than a second copy of this function underneath the first.
 *
 * A burst takes damage off the player through the same i-frame gate a hug uses — it neither
 * bypasses it nor ignores it — and off other bodies through their armour, which is how a
 * chamber of exploders becomes a chain reaction you set off somewhere you would rather not
 * be standing. The depth cap and the guard both exist so no arrangement of bodies can make
 * one tick outlast the tick after it.
 */
export function resolveBlasts(w: World): void {
  const stack = w.blasts;
  if (stack.count === 0) return;

  const enemies = w.enemies;
  const player = w.player;
  let guard = stack.cap * 4;

  while (stack.count > 0 && guard-- > 0) {
    const at = --stack.count;
    const x = stack.x[at];
    const y = stack.y[at];
    const r = stack.r[at];
    const dmg = stack.dmg[at];
    const depth = stack.chain[at];
    if (depth >= MAX_BLAST_CHAIN) continue;
    stack.depth = depth + 1;

    const px = player.x - x;
    const py = player.y - y;
    const reach = r + TUNE.playerRadius;
    if (px * px + py * py <= reach * reach) hurtPlayer(w, dmg, 8);

    const found = queryRadius(
      w.hash,
      enemies.x,
      enemies.y,
      enemies.alive,
      x,
      y,
      r + TUNE.shotRadius,
      w.query,
    );

    for (let k = 0; k < found; k++) {
      const j = w.query[k];
      if (enemies.hp[j] <= 0) continue;

      const def = ENEMIES[enemies.kind[j]];
      const dx = enemies.x[j] - x;
      const dy = enemies.y[j] - y;
      const d2 = dx * dx + dy * dy;
      const bodyReach = r + def.radius;
      if (d2 > bodyReach * bodyReach) continue;

      // A burst is omnidirectional, so it pays the flat plate: directional armour is about
      // where damage came from, and a blast comes from everywhere at once.
      let dealt = dmg - def.armor;
      if (dealt < 1) dealt = 1;
      enemies.hp[j] -= dealt;
      pushEvent(w, Ev.Hit, -1, j, enemies.x[j], enemies.y[j]);
      if (enemies.hp[j] <= 0) killEnemy(w, j);
    }

    pushEvent(w, Ev.Explosion, -1, Math.round(r * 10), x, y);
  }

  stack.depth = 0;
  stack.count = 0;
}
