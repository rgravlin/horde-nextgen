/**
 * The player's own body, and the gun in its hand.
 *
 * Kit-bash rather than a capsule so the player is built from the same part-based idiom as the
 * horde (DESIGN.md "Player and weapons"), and three gun shapes exist so the weapon *family*
 * reads from the camera without checking the HUD: Gun Orange for the guns, Ember for the
 * medieval rack, Alien Cyan for anything with a coil in it. Only the one being held is drawn,
 * and the switch is one comparison per frame because the shape only changes when a weapon is
 * picked up.
 *
 * The yaw comes from the line the gun is shooting along, not from the velocity and not
 * straight off the aim either: this is a twin-stick, so the body points where the gun points,
 * and under auto-fire the gun points at a body rather than at the cursor. `facing.ts` owns
 * that line and `yawToFace` owns the turn, so the rig and the tracers agree by construction.
 *
 * Read-only and cosmetic, like the rest of `render`: it takes what the simulation says the
 * player looks like and draws that.
 */

import { Group, Mesh, MeshStandardNodeMaterial, type Scene } from 'three/webgpu';

import { WEAPONS, type WeaponFamily } from '../content/weapons';

import { flipToRender } from './instancing';
import { glowMaterial, playerBody, playerTrim, weaponKit } from './meshes';
import type { TierProfile } from './quality';

/** Colour roles from DESIGN.md, one per weapon family, plus the player's own metal. */
const GUNMETAL = 0x4a505c;
const GUN_ORANGE = 0xff7a1a;
const EMBER = 0xff4d2e;
const ALIEN_CYAN = 0x2ef2ff;

/** The three gun shapes the player can be holding, in `weaponKit`'s order. */
const FAMILIES: readonly WeaponFamily[] = ['guns', 'medieval', 'alien'];

/** How hard the trim and the rounds glow, for the bloom pass (DESIGN.md "Palette"). */
const GLOW = 2.2;

export interface PlayerRig {
  readonly group: Group;
  /**
   * Stand the rig at a world point, turned to `yaw`, hidden when the player is dead.
   *
   * `yaw` comes from `yawToFace`, which already knows that the rig's forward is local +z;
   * a yaw handed in from `atan2(aimY, aimX)` would be a quarter turn off.
   */
  place(x: number, y: number, yaw: number, visible: boolean): void;
  /** Show the gun of the family this weapon index belongs to; -1 shows none. */
  hold(weaponIndex: number): void;
}

/**
 * Bring the rig up and add it to the scene.
 *
 * One per view: the shapes are built once from `meshes/` and afterwards only the visibility
 * flags move, which is what keeps a restart cheaper than the frame before it.
 */
export function createPlayerRig(scene: Scene, profile: TierProfile): PlayerRig {
  const group = new Group();
  const body = new Mesh(
    playerBody(),
    new MeshStandardNodeMaterial({ color: GUNMETAL, roughness: 0.45, metalness: 0.2 }),
  );
  body.castShadow = profile.shadows;
  const trim = new Mesh(playerTrim(), glowMaterial(ALIEN_CYAN, GLOW));
  const kits = weaponKit();
  const guns = [
    new Mesh(kits.guns, glowMaterial(GUN_ORANGE, GLOW)),
    new Mesh(kits.medieval, glowMaterial(EMBER, GLOW)),
    new Mesh(kits.alien, glowMaterial(ALIEN_CYAN, GLOW)),
  ];
  group.add(body, trim, ...guns);
  scene.add(group);

  /** Which gun is on show; -1 until the first frame picks one. */
  let shownGun = -1;

  return {
    group,

    place(x, y, yaw, visible) {
      group.position.set(x, 0, flipToRender(y));
      group.rotation.y = yaw;
      group.visible = visible;
    },

    hold(weaponIndex) {
      const family =
        weaponIndex >= 0 && weaponIndex < WEAPONS.length ? WEAPONS[weaponIndex].family : 'guns';
      const at = FAMILIES.indexOf(family);
      if (at === shownGun) return;
      for (let i = 0; i < guns.length; i++) guns[i].visible = i === at;
      shownGun = at;
    },
  };
}
