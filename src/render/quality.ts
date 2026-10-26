/**
 * The quality tiers, in one file (TECH.md "Quality tiers").
 *
 * A tier is a set of numbers, not a mood: shadows on or off, how big the shadow map is, how
 * many lamps a scene may light, how many particles a palette may draw, whether the bloom pass
 * exists and how hard the chromatic punch hits. They live here because four modules used to
 * each keep their own copy of "what High means" — `renderer.ts` for the air and the shadow
 * map, `lights.ts` for the lamps, `instancing.ts` for the body batches, `fxView.ts` for the
 * particles — and a knob written down four times is four knobs that drift apart.
 *
 * It is also the one render file with no engine import, which is what lets
 * `tests/unit/quality.test.ts` pin the tier choice and the shake maths in plain Node.
 *
 * Two kinds of knob are kept apart on purpose:
 *
 * - `tier` answers "what did the machine pick", from the backend, the GPU's own name, the kind
 *   of device and how much memory it says it has — plus the tier the player asked for, which
 *   outranks all four;
 * - `profile` answers "what does that cost", and is the only thing the draw path reads.
 *
 * The player's settings (`resolutionScale`, `shake`) arrive as arguments to the two functions
 * that need them rather than being stored here, so this file has no state to reset between
 * runs.
 */

/** The four tiers, named as `persistence.ts` writes them into the settings file. */
export type Quality = 'low' | 'medium' | 'high' | 'ultra';

/** Which backend came up, which is half of the tier decision. */
export type Backend = 'webgpu' | 'webgl2' | 'none';

/**
 * What kind of machine this is, as far as a browser will say.
 *
 * Handhelds share a driver family with desktops (a phone's Adreno names itself as
 * `ANGLE (Adreno ...)`), so the GPU name alone cannot tell a phone from a laptop, and a phone
 * given the desktop tier gets a 2 GB shadow map and a thermal throttle. `unknown` is what
 * `navigator.userAgentData` leaves behind when it is missing, and it is treated as a desktop:
 * a machine that cannot say is not assumed to be the weaker one, only denied the top tier.
 */
export type DeviceKind = 'desktop' | 'mobile' | 'unknown';

/**
 * Everything the tier choice reads, in one argument.
 *
 * The shape exists so `renderer.ts` can fill it in from the browser and a test can write it by
 * hand: this file has no access to `navigator`, `window` or `three`, which is what keeps the
 * decision a table of numbers rather than a probe.
 */
export interface MachineInfo {
  readonly backend: Backend;
  /** The adapter's own words, or '' when the driver says nothing. */
  readonly gpuName: string;
  /** `navigator.deviceMemory` in GiB; 0, negative or missing means "it did not say". */
  readonly memory?: number;
  readonly deviceKind?: DeviceKind;
  /**
   * What the player picked in the settings menu. `undefined` is `auto`: ask the machine.
   * A named tier is an instruction, so it wins over every rule below.
   */
  readonly setting?: Quality;
}

/**
 * What a software rasteriser calls itself.
 *
 * SwiftShader names itself in both the WebGPU adapter description and the WebGL
 * `UNMASKED_RENDERER_WEBGL` string, and this box runs on it, so the pattern is the difference
 * between a tier chosen for real hardware and one chosen for an emulator.
 */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

function isSoftware(name: string): boolean {
  return SOFTWARE.test(name);
}

/** The four tiers, cheapest first. `clamp` walks this list, so the order is the ranking. */
const ORDER: readonly Quality[] = ['low', 'medium', 'high', 'ultra'];

function atOrBelow(tier: Quality, ceiling: Quality): Quality {
  return ORDER.indexOf(tier) <= ORDER.indexOf(ceiling) ? tier : ceiling;
}

/**
 * Pick a tier from what the machine reports, or Medium when it reports nothing.
 *
 * Four rules, in this order, each of which can only hold the choice down except the first:
 *
 * 1. A tier the player named in the settings is the answer, whatever the hardware says. They
 *    may be on a phone and want the shadows, and it is their machine.
 * 2. A software rasteriser goes to Low, including when it hides behind the word "Vulkan" —
 *    that is how SwiftShader arrives here, on this box and on every CI box without a GPU.
 * 3. The starting point comes from the backend: WebGPU with an adapter naming real silicon has
 *    both the API and the hardware and starts at High; a driver that will not identify itself
 *    is the unsure case, which TECH.md sends to Medium; and WebGL2 is the fallback path where
 *    the older machines live, so it starts one notch down whatever it reports.
 * 4. The machine's shape then clamps that: a handheld never starts above Medium, and the two
 *    memory cuts are the ones that catch a 4 GiB laptop running a desktop driver.
 *
 * Ultra is not reachable by the starting point at all. It needs the top backend, a named
 * adapter, a machine that says it is a desktop and at least 16 GiB of RAM: four pieces of
 * evidence rather than an assumption, because it is the tier that spends the most and the one
 * nothing downstream second-guesses.
 */
export function pickTier(info: MachineInfo): Quality {
  const chosen = info.setting;
  if (chosen !== undefined) return chosen;

  const name = (info.gpuName ?? '').trim();
  if (info.backend === 'none') return 'low';
  if (isSoftware(name)) return 'low';

  const kind = info.deviceKind ?? 'unknown';
  const memory = typeof info.memory === 'number' && info.memory > 0 ? info.memory : 0;

  let tier: Quality =
    info.backend === 'webgpu' && name !== '' ? 'high' : 'medium';

  if (kind === 'mobile') tier = atOrBelow(tier, 'medium');
  if (memory > 0 && memory <= 4) tier = 'low';
  else if (memory > 0 && memory <= 8) tier = atOrBelow(tier, 'medium');

  if (
    tier === 'high' &&
    info.backend === 'webgpu' &&
    kind === 'desktop' &&
    memory >= 16
  ) {
    tier = 'ultra';
  }

  return tier;
}

/** What one tier spends. Read once at boot; nothing here changes mid-run. */
export interface TierProfile {
  readonly tier: Quality;
  /** Whether the key light casts shadows and whether the horde falls them. */
  readonly shadows: boolean;
  /** Shadow-map edge in pixels; 0 when `shadows` is false. */
  readonly shadowMapSize: number;
  /** Multiplier under `devicePixelRatio`, before the settings' own scale. */
  readonly pixelScale: number;
  /** Exponential fog density: thick enough to hide the arena's edge, not the fight. */
  readonly fogDensity: number;
  /** Whether the bloom pass exists at all. */
  readonly bloom: boolean;
  readonly bloomStrength: number;
  readonly bloomRadius: number;
  /**
   * Luminance at which a pixel starts to bloom.
   *
   * At 1.0 only the values the materials are pushed past bloom — the glow materials in
   * `meshes.ts` are built above 1.0 for exactly this reason — so the floor and a thousand dark
   * bodies stay out of the blur. At 0.72 (what this file used to hard-code) the mid-value
   * concrete blooms too and the whole screen goes soft.
   */
  readonly bloomThreshold: number;
  /** Whether the chromatic pass exists at all. */
  readonly chroma: boolean;
  /** Its resting strength, which is nearly nothing: a hint of purple at the corners. */
  readonly chromaBase: number;
  /** What a big hit adds to it, for as long as the punch lasts. */
  readonly chromaPunch: number;
  /** Pooled point lights, which is the other half of the tier's frame budget. */
  readonly lamps: number;
  /** Instances each particle palette may draw, times four palettes. */
  readonly particles: number;
}

const PROFILES: Record<Quality, TierProfile> = {
  low: {
    tier: 'low',
    shadows: false,
    shadowMapSize: 0,
    pixelScale: 0.75,
    fogDensity: 0.02,
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0.6,
    bloomThreshold: 1,
    chroma: false,
    chromaBase: 0,
    chromaPunch: 0,
    lamps: 0,
    particles: 512,
  },
  medium: {
    tier: 'medium',
    shadows: true,
    shadowMapSize: 1024,
    pixelScale: 1,
    fogDensity: 0.016,
    bloom: true,
    bloomStrength: 0.4,
    bloomRadius: 0.6,
    bloomThreshold: 1,
    chroma: true,
    chromaBase: 0.0025,
    chromaPunch: 0.01,
    lamps: 8,
    particles: 1024,
  },
  high: {
    tier: 'high',
    shadows: true,
    shadowMapSize: 2048,
    pixelScale: 1,
    fogDensity: 0.016,
    bloom: true,
    bloomStrength: 0.62,
    bloomRadius: 0.6,
    bloomThreshold: 1,
    chroma: true,
    chromaBase: 0.004,
    chromaPunch: 0.016,
    lamps: 16,
    particles: 2048,
  },
  /**
   * Everything High has, turned up, and nothing switched on that High leaves off: four budgets
   * over one picture, not four pictures. The shadow map is where the money goes — 4096 is four
   * times High's pixels and it is re-rendered every frame — then the particle field, which at
   * 4096 a palette can hold a whole detonation's worth of smoke without dropping the tail of
   * it. The lamp count stops at High: sixteen is TECH.md's ceiling, and past that a second
   * light costs per lit fragment rather than per light, which is the cost that matters.
   */
  ultra: {
    tier: 'ultra',
    shadows: true,
    shadowMapSize: 4096,
    pixelScale: 1,
    fogDensity: 0.016,
    bloom: true,
    bloomStrength: 0.72,
    bloomRadius: 0.7,
    bloomThreshold: 1,
    chroma: true,
    chromaBase: 0.005,
    chromaPunch: 0.02,
    lamps: 16,
    particles: 4096,
  },
};

/**
 * What a player turned down from the tier the machine picked.
 *
 * The tier answers "what did the machine pick"; this answers "what did the player take away
 * from it", and the two are applied in that order — a `shadows: true` on Low does not buy
 * shadows, because the tier's answer is the ceiling and the settings only ever sit under it.
 * `undefined` on any of them means "no opinion", which is what a first launch has.
 */
export interface QualityOverrides {
  readonly shadows?: boolean;
  readonly bloom?: boolean;
  /** Fraction of the tier's particle budget, 0..1. 0 means the field is not built at all. */
  readonly particles?: number;
}

function under(v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** The profile for one tier, with the player's subtractions applied. */
export function profileFor(tier: Quality, overrides?: QualityOverrides): TierProfile {
  const base = PROFILES[tier];
  if (overrides === undefined) return base;

  const shadows = overrides.shadows ?? base.shadows;
  const bloom = overrides.bloom ?? base.bloom;
  const particles = Math.round(base.particles * under(overrides.particles, 1));
  if (shadows === base.shadows && bloom === base.bloom && particles === base.particles) return base;

  // The chromatic punch goes with the bloom pass rather than having its own row: one "post"
  // knob the player can find beats two he has to reason about, and a punch without a bloom is
  // the same two passes costing the same frame time for half the picture.
  return {
    ...base,
    shadows,
    shadowMapSize: shadows ? base.shadowMapSize : 0,
    bloom,
    bloomStrength: bloom ? base.bloomStrength : 0,
    chroma: bloom && base.chroma,
    particles,
  };
}

/**
 * The device pixel ratio to render at.
 *
 * The tier sets the ceiling and the settings file sets the wish, so a Low tier on a 2x display
 * renders at 1.5 and a High tier with the scale dialled to 0.6 renders at 0.6. Capped at 1:
 * above native the pixels are not on the screen, they are only more of them to shade.
 */
export function pixelRatioFor(profile: TierProfile, devicePixelRatio: number, scale: number): number {
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const want = scale > 0 ? scale : 1;
  return Math.min(1, dpr * profile.pixelScale * want);
}