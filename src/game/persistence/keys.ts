/**
 * The three localStorage keys, written down once.
 *
 * TECH.md names these keys and this folder is the only place that knows what lives under
 * them. Each spells its own version inside its own key rather than reaching for
 * `SAVE_VERSION`: a new snapshot format has no business resetting everyone's volumes.
 * `SAVE_VERSION` stays where it belongs, in `serialize`'s payload, which `loadRun` checks.
 */

/** The resumable run. The name is the one TECH.md and ARCHITECTURE.md pin. */
export const SAVE_KEY = 'neonhorde.save.v1';

/** Volume, quality, resolution scale, auto-fire, shake. */
export const SETTINGS_KEY = 'neonhorde.settings.v1';

/** Unlocked chapters, best time per chapter, run history. */
export const META_KEY = 'neonhorde.meta.v1';
