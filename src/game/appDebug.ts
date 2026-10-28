/**
 * `window.__forgeDebug`: the doors a scenario and the bench use to set a scene up.
 *
 * These are the only writes into a run that do not come from a player, so they live apart from
 * the scene machine and go through the sim's own entry points (`spawnEnemy`, `awardXp`,
 * `loadSlot`) rather than by editing values — the same rule `app.ts` states for itself, and the
 * reason a scripted scene is still reproducible from its seed. Each one takes the live `World`
 * from its host rather than closing over a variable: a bench arms a *new* run, so the world it
 * must prime is not the one that was under the page when the call started.
 *
 * Headless by construction — no `window` here either, only the shape `main.ts` publishes.
 */

import { ENEMIES } from '../content/enemies';
import { LEVELS } from '../content/levels';
import { POWERUPS } from '../content/powerups';
import { WEAPONS } from '../content/weapons';
import type { InputFrame } from '../sim/input';
import { createRng, next } from '../sim/rng';
import { spawnEnemy } from '../sim/systems/enemies';
import { awardXp, grantPowerup } from '../sim/systems/pickups';
import { loadSlot, type World } from '../sim/world';
import { createBenchRig, type BenchRig } from './bench';
import type { ForgeDebug } from './appTypes';

/** The clamp the ring and the bench window both need; local, like every other `clamp` here. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * What the debug hooks read, and the two doors that change the run.
 *
 * `world` is a function, not a field: `restart` replaces the World, and a host field read once
 * would leave a bench window priming the run it had just thrown away.
 */
export interface DebugHost {
  /** The live world — a fresh one straight after `restart`. */
  world(): World;
  /** The app's one persistent `InputFrame`, which is what a rig pins its load into. */
  readonly frame: InputFrame;
  /** Throw the run away and start a fresh one on chapter `chapter`, playing. */
  restart(chapter: number): void;
  /** Throw the run away and start a fresh Endless Arena run, playing. */
  arenaRun(): void;
  /** Install the bench window the rest of the frame is measured by; null clears it. */
  arm(rig: BenchRig | null): void;
  readonly backend: 'webgpu' | 'webgl2' | 'none';
  readonly now?: () => number;
}

/** Build the object `main.ts` hands to `window.__forgeDebug`. */
export function createDebug(host: DebugHost): ForgeDebug {
  return {
    setSeed(seed) {
      host.world().rng = createRng(seed);
    },

    // Put `n` bodies of archetype `type` on a ring around the player, close enough
    // that auto-fire engages, for a scenario or the bench to shoot at.
    spawn(type, n) {
      const w = host.world();
      const kind = type >= 0 && type < ENEMIES.length ? type : 0;
      const def = ENEMIES[kind];
      let made = 0;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + next(w.rng) * 0.5;
        const r = 8 + next(w.rng) * 6;
        const x = clamp(w.player.x + Math.cos(a) * r, w.minX + def.radius, w.maxX - def.radius);
        const y = clamp(w.player.y + Math.sin(a) * r, w.minY + def.radius, w.maxY - def.radius);
        if (spawnEnemy(w, kind, x, y) >= 0) made++;
      }
      return made;
    },

    grantXp(n) {
      awardXp(host.world(), n);
    },

    giveWeapon(id) {
      const w = host.world();
      const index = WEAPONS.findIndex((def) => def.id === id);
      if (index < 0) return false;
      // Fill the empty hand if there is one, else the active hand, and make a hand
      // that was empty the one in play, so a granted weapon is the one being fired.
      let slot = w.slots.findIndex((s) => s.weapon < 0);
      let switched = false;
      if (slot < 0) slot = w.activeSlot;
      else switched = true;
      const hand = w.slots[slot];
      // One call owns "this hand now holds that gun", including what the gun starts
      // its magazine, its heat and its charge with — a granted weapon that arrived
      // half empty would read as a broken grant, not as a spent one.
      loadSlot(hand, index);
      if (switched) w.activeSlot = slot;
      return true;
    },

    // Put a card on the run the way the level-up table would, through the sim's own grant, so the
    // stat the rig and the HUD read rises with it. The door exists because the three cards on
    // offer are dealt at random: a scenario that wants the ward drone cannot bet on being handed
    // it, and a step list can only press keys. An unknown id, or a card already at its ceiling,
    // answers false rather than pretending.
    givePowerup(id) {
      const w = host.world();
      const index = POWERUPS.findIndex((def) => def.id === id);
      return grantPowerup(w, index);
    },

    /**
     * Arm a bench window at horde size `n`.
     *
     * It starts a run rather than arming over the screen it was called from: a window measures a
     * fight, so it needs a playing scene and a floor under it — cover and hazards are part of the
     * load, not scenery (a horde on open floor is a fight no chapter actually has). The chapter
     * defaults to the floor the page is on, so a mid-run `bench(300)` benches where the player
     * actually is.
     */
    bench(n, options) {
      const asked = options?.chapter;
      const chapter = clamp(
        Math.floor(Number.isFinite(asked) ? (asked as number) : host.world().chapter),
        0,
        LEVELS.length - 1,
      );
      host.restart(chapter);
      const rig = createBenchRig({
        ...options,
        enemies: Math.max(1, Math.floor(n)),
        chapter,
        backend: host.backend,
        now: host.now,
      });
      host.arm(rig);
      // Prime it after the restart and before the first frame: the fill is setup rather than
      // measurement, and the expensive frame of a bench is the one that puts a thousand bodies
      // down, so a window whose first sampled frame started from an empty arena would be timing
      // the wrong thing twice.
      const w = host.world();
      rig.hold(w, host.frame);
      return w.enemies.count;
    },

    /**
     * Start an Endless Arena run.
     *
     * It clears the rig first for the same reason `bench` replaces the run: a rig pins its held
     * load into whatever run it armed, so a window that survived this would top the arena's floor
     * back up to its own target and the run would measure instead of play. The mode's own rules
     * (no script, no encounter, no victory) come from `startArena` in `sim/systems/levels.ts`,
     * which is also the door the unit tests use, so the scenario and the tests enter through one
     * door rather than two.
     */
    arena() {
      host.arm(null);
      host.arenaRun();
    },
  };
}
