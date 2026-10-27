/**
 * The fixed-timestep step: one 1/60 s tick of simulation, driven only by the
 * World and one InputFrame (TECH.md "Simulation and rendering").
 *
 * System order is fixed and listed below; it is the order ARCHITECTURE.md pins,
 * and determinism depends on it, so later tasks fill the gaps in place instead
 * of reordering. Everything mutates the pooled arrays in place — no closures, no
 * temporary objects, no allocation per tick.
 */

import type { InputFrame } from './input';
import { updateFx } from './fx';
import { queryRadius, rebuild } from './spatialHash';
import { canTravel } from './systems/obstacles';
import { updateBoss } from './systems/boss';
import { updateDrone } from './systems/drone';
import { markFindable, resolveBlasts, updateEnemies } from './systems/enemies';
import { updateEnemyProjectiles } from './systems/enemyProjectiles';
import { updateHazards } from './systems/levels';
import { choosePick, updateChests, updatePickups } from './systems/pickups';
import { tickPowerTimers } from './systems/powerups';
import { updateWeapons } from './systems/weapons';
import { updateWaves } from './systems/waves';
import { DT, Ev, TUNE, pushEvent, type World } from './world';

/** Below this length an input or direction vector counts as zero. */
const EPS = 1e-6;

/**
 * Advance the world by one tick.
 *
 * Order: timers -> player travel -> the chapter's floor hazards -> the chapter arc and the
 * encounter it opens -> broad-phase rebuild -> enemy behaviours and contact damage -> the
 * drone companion, if the run owns one -> weapon fire, projectile movement and damage
 * (a kill is resolved where the damage lands) -> the blasts those deaths queued ->
 * the enemy rounds and lobs -> the level-up pick -> pickups and XP -> wave spawns.
 * The grid is built before the passes that query it rather than after, so the
 * collision and separation tests read a grid that matches the positions they are
 * about to test, minus at most one tick of travel — which their query radius pads
 * for.
 *
 * The chapter's two passes run before the rebuild rather than with the other late passes
 * because the arc is the one pass that *adds* bodies to the floor mid-tick — the encounter's
 * bosses — and a boss that is not in the grid the tick it arrives is a boss nothing can shoot
 * for a step. Its hazards want the same half of the tick: a crusher that fires here has its
 * burst paid out by the blast pass below, in the tick the tell ended, which is what the 0.45 s
 * of warning was bought for. Running them before the enemy pass also keeps a chapter's last
 * batch and its boss off the same tick, so the encounter reads as a change in what the
 * chapter is doing rather than as one more, larger pack. See `systems/levels.ts` (the floor)
 * and `systems/boss.ts` (the encounter).
 *
 * The enemy projectiles get their own pass after the blasts, not inside the enemy
 * pass, for the same reason the blasts do: a bolt or a lob is a second damage
 * query on the tick, and every query in the tick shares `world.query`. Triggering
 * a shot stays in the behaviour (that is where the telegraph and the cooldown
 * live) and spending it lives in `systems/enemyProjectiles.ts`, which mirrors how
 * the player's weapons hand their rounds to `systems/projectiles.ts`.
 *
 * The blasts get their own pass after the shots for one reason: a burst is a second
 * damage query, and every query in the tick shares `world.query`. Spending them where
 * they happen would rewrite the candidate list the shot that made them is still
 * standing in, and a burst that kills another bomber would recurse instead of queueing.
 *
 * Once the run is over nothing simulates: the tick that killed the player still
 * resolves its shots, and after that the world waits for the summary screen.
 */
export function step(world: World, frame: InputFrame): void {
  world.tick++;
  world.time = world.tick * DT;

  updateTimers(world);
  updatePlayer(world, frame);
  updateHazards(world);
  updateBoss(world);
  // Who may be found, then who is where. Both are rebuilt every tick from the phase slot
  // rather than kept up to date, so the two halves of the broad phase cannot drift: the mask
  // is what `rebuild` indexes and what every `queryRadius` below filters on, and a body under
  // the floor is in neither. Filled *after* the chapter pass because that pass is the one
  // that adds bodies, and a boss missing the grid for a tick is a boss nothing can shoot.
  markFindable(world);
  rebuild(world.hash, world.enemies.x, world.enemies.y, world.hash.findable, world.enemies.cap);

  if (world.over) return;

  updateEnemies(world);
  // The drone goes between the enemy pass and the weapon pass on purpose: the enemy
  // pass is what works out `nearest` and leaves the tick's query buffer filled, and
  // the weapon pass is what moves and resolves the rounds it looses, so a drone round
  // spends the same tick it was fired in rather than arriving a step late.
  updateDrone(world);
  updateWeapons(world, frame);
  resolveBlasts(world);
  updateEnemyProjectiles(world);
  if (frame.pick > 0) choosePick(world, frame.pick - 1);
  updatePickups(world);
  updateChests(world);
  updateWaves(world);
  // Last, and only while the run is alive: the particle field is built from the events
  // this tick produced, so it has to run after every pass that writes one, and a frozen
  // world freezes its sparks with it (DESIGN.md "the game freezes").
  updateFx(world);
}

/** Tick down every cooldown and timer, before anything reads them. */
function updateTimers(world: World): void {
  const p = world.player;
  if (p.dashCd > 0) {
    p.dashCd -= DT;
    if (p.dashCd < 0) p.dashCd = 0;
  }
  if (p.iframes > 0) {
    p.iframes -= DT;
    if (p.iframes < 0) p.iframes = 0;
  }

  // The timed power-ups' clocks, and the mend that runs while they are up. Both live
  // before movement so a dose that expires this tick is already off the stat block when
  // the speed and the fire-cooldown reads below consult it, rather than off next tick.
  tickPowerTimers(world);

  const regen = world.stats.regen;
  if (regen > 0 && p.hp > 0 && p.hp < p.maxHp) {
    p.hp = p.hp + regen * DT > p.maxHp ? p.maxHp : p.hp + regen * DT;
  }
}

/**
 * Movement, dash and the arena clamp.
 *
 * Input is read here and nowhere else: key and mouse handlers only fill the
 * frame (AGENTS.md), so the same frame replayed gives the same positions.
 */
function updatePlayer(world: World, frame: InputFrame): void {
  const p = world.player;
  if (!p.alive) {
    p.vx = 0;
    p.vy = 0;
    return;
  }

  // Aim keeps unit length; the sampler projects the pointer onto the ground
  // plane, so a magnitude below 1 only arrives from an analogue stick.
  const aimLen = Math.sqrt(frame.aimX * frame.aimX + frame.aimY * frame.aimY);
  if (aimLen > EPS) {
    const k = aimLen > 1 ? 1 / aimLen : 1;
    p.aimX = frame.aimX * k;
    p.aimY = frame.aimY * k;
  }

  // Cap the move vector to unit length, so a diagonal is not sqrt2 faster than a
  // single key, while a half-pushed stick stays half as fast.
  let moveX = frame.moveX;
  let moveY = frame.moveY;
  let moveLen2 = moveX * moveX + moveY * moveY;
  if (moveLen2 > 1) {
    const k = 1 / Math.sqrt(moveLen2);
    moveX *= k;
    moveY *= k;
    moveLen2 = 1;
  }
  const moveLen = Math.sqrt(moveLen2);

  let dashed = false;
  if (p.dashTime > 0) {
    // Mid-burst: the locked direction owns the velocity until the burst ends.
    p.dashTime -= DT;
    if (p.dashTime < 0) p.dashTime = 0;
    p.vx = p.dashDirX * TUNE.dashSpeed;
    p.vy = p.dashDirY * TUNE.dashSpeed;
    dashed = true;
  } else if (frame.dash && p.dashCd <= 0) {
    dashed = startDash(world, moveLen, moveX, moveY);
  }

  if (!dashed) {
    if (moveLen > EPS) {
      const speed = TUNE.moveSpeed * world.stats.speed;
      p.vx = moveX * speed;
      p.vy = moveY * speed;
    } else {
      p.vx = 0;
      p.vy = 0;
    }
  }

  // Travel, then the arena clamp.
  //
  // Cover is resolved one axis at a time and each axis is a sweep of the tick's whole step,
  // not a check on the destination: a dash crosses 0.37 m in a tick and a wall is 1.2 m
  // thick, so an endpoint test would put a dash on the far side of it. An axis that hits is
  // dropped rather than shortened, which is what lets a body slide along a wall instead of
  // sticking to it, and it is the same rule `advance` applies to every enemy, so the player
  // and the horde are stopped by the same geometry in the same way.
  const r = TUNE.playerRadius;
  const stepX = p.vx * DT;
  const stepY = p.vy * DT;

  if (stepX !== 0) {
    let nx = p.x + stepX;
    if (nx < world.minX + r) nx = world.minX + r;
    else if (nx > world.maxX - r) nx = world.maxX - r;
    if (canTravel(world.props, p.x, p.y, nx - p.x, 0, r)) p.x = nx;
    else p.vx = 0;
  }
  if (stepY !== 0) {
    let ny = p.y + stepY;
    if (ny < world.minY + r) ny = world.minY + r;
    else if (ny > world.maxY - r) ny = world.maxY - r;
    if (canTravel(world.props, p.x, p.y, 0, ny - p.y, r)) p.y = ny;
    else p.vy = 0;
  }
}

/**
 * Launch a dash burst; returns false when there is no direction to spend it on,
 * which leaves the cooldown unspent so the next tick can try again.
 *
 * Direction comes from the movement input and falls back to the aim direction,
 * so a stationary player dashes where they are pointing.
 */
function startDash(world: World, moveLen: number, moveX: number, moveY: number): boolean {
  const p = world.player;
  let dx: number;
  let dy: number;

  if (moveLen > EPS) {
    dx = moveX / moveLen;
    dy = moveY / moveLen;
  } else {
    const aimLen = Math.sqrt(p.aimX * p.aimX + p.aimY * p.aimY);
    if (aimLen > EPS) {
      dx = p.aimX / aimLen;
      dy = p.aimY / aimLen;
    } else {
      return false;
    }
  }

  p.dashDirX = dx;
  p.dashDirY = dy;
  p.dashTime = TUNE.dashTime;
  // `dashCd` is a multiplier under one, so Second Wind shortens the gap instead of
  // subtracting a flat slice of it: a flat slice on a 1.5 s cooldown is either nothing
  // or the whole cooldown, depending on the number, and the card reads differently on
  // every dash length the game might later grow.
  p.dashCd = TUNE.dashCooldown * world.stats.dashCd;
  p.iframes = TUNE.dashIframes;
  p.vx = dx * TUNE.dashSpeed;
  p.vy = dy * TUNE.dashSpeed;
  pushEvent(world, Ev.Dash, 0, 0, p.x, p.y);
  return true;
}

/**
 * Broad-phase helper for the later systems: fill `world.query` with enemy slot
 * indices near (px, py) and return how many. Callers must finish using the
 * result before the next query in the same tick, since they share one buffer.
 *
 * Filtered by the tick's findability mask rather than by `alive`, so a helper asked
 * about a body that is under the floor answers "nobody", like every weapon does.
 */
export function queryEnemies(world: World, px: number, py: number, r: number): number {
  return queryRadius(
    world.hash,
    world.enemies.x,
    world.enemies.y,
    world.hash.findable,
    px,
    py,
    r,
    world.query,
  );
}