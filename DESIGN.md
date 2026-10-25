# DESIGN.md: Neon Horde (style brief)

The engine choice and the reasons for it go in TECH.md. Checked on the registry: `three@0.186.1` (WebGPURenderer, which falls back to WebGL2 automatically, plus TSL node post-processing), `@fontsource/chakra-petch@5.3.0` and `@fontsource/ibm-plex-mono@5.3.0`. Every visual and UI decision below must work on both the WebGPU and WebGL2 paths.

## Feel
**Neon synthwave industrial.** The setting is a night-time factory floor at the end of the world: wet concrete, steel gantries and hazard paint, all lit by the player's own gunfire. The threat comes from numbers. A sea of dim enemy bodies closes in, and the player cuts glowing lanes through it. Each kill is a short, bright, satisfying pop. The screen is dark but never murky: the floor is mid-value, and everything that matters glows.
Three adjectives: **kinetic, luminous, oppressive**.

## References
No reference images were given ("forge picks"). These are the reference points, described in words:
- **Vampire Survivors / Brotato (loop, not look):** a pick-of-3 level-up card screen that is readable in under 2 seconds, and XP shards that stream toward the player.
- **Nex Machina / Resogun (assumed):** voxel-crisp shapes that break into bright particles, heavy bloom on projectiles only, and a playfield that stays readable while hundreds of things are moving.
- **Synthwave poster art (assumed):** magenta-to-cyan horizon gradients, used only in UI accents and menu backdrops, never on the playfield floor.

## Palette
The game is dark-mode only. Emissive colours are pushed above 1.0 into HDR so the bloom pass picks them up; the hex values below are the base hue.
| Name | Hex | Use |
|---|---|---|
| Void | `#0B0D14` | sky and fog colour, UI panel base (at 72% alpha) |
| Concrete | `#2A2E38` | ground albedo (mid-value; keep it lighter than enemy bodies) |
| Gunmetal | `#4A505C` | props, walls, cover |
| Hazard | `#F2B233` | hazard stripes, chest beacons, chokepoint markers |
| Gun Orange | `#FF7A1A` | guns family: muzzle flash, tracers, card border |
| Brass | `#C9A26B` | guns family: casings and metal trim |
| Ember | `#FF4D2E` | medieval family: arrow trails, flail sparks, burning DoT |
| Oak | `#8A5A36` | medieval family: wood models and card fill accent |
| Alien Cyan | `#2EF2FF` | alien family: plasma and beams; also player shield and UI hairlines |
| Alien Violet | `#9B5CFF` | alien family: singularity and disruptor; also XP shards |
| Synth Magenta | `#FF2E97` | UI accent, level-up highlight, boss name plates |
| Threat Red | `#FF2A3D` | **telegraphs only**: wind-up flash, charge lines, AoE warning rings, damage taken |
| Heal Green | `#3DFF8A` | healer aura, HP pickups, life steal |
| Text | `#E8ECF5` / dim `#8C93A6` | UI text |

Rules:
- Enemy bodies are dark matte (`#1A1C24`–`#3A2F3F`). Each faction has one emissive accent (eyes or core) so enemies read by silhouette and accent colour, not by full glow.
- Threat Red is reserved: no weapon or UI decoration may use it.
- Each chapter tints the fog and key light (for example teal docks, amber foundry, violet reactor), but the palette roles above never change.

## Typography
At most two families, both self-hosted with `forge-fetch font "Chakra Petch"` and `forge-fetch font "IBM Plex Mono"`.
- **Chakra Petch** for headings and labels. Title: 64px/700, uppercase, letter-spacing 0.08em. Screen headings: 32px/600. Card titles: 20px/600. Buttons and labels: 14px/600 uppercase, letter-spacing 0.1em.
- **IBM Plex Mono** for numbers and data. HUD counters: 18px/500. Stat tables: 13px/400. Damage numbers: 14px/600, and 20px/700 for crits. Body and help text: 14px/400.
- Use tabular numerals everywhere; numbers must not jitter as they change.

## Layout and composition
- **HUD (neon glass):** dark translucent panels with 1px Alien Cyan hairline borders (or Synth Magenta) and 2px cut corners. No CSS glow or box-shadow blur; glow comes only from the renderer's bloom.
  - **Top-left:** radar, a 160px circle.
  - **Top-centre:** chapter, wave timer and a thin wave-progress bar.
  - **Top-right:** score and kill count.
  - **Bottom-left:** an HP bar (240×10, slim and never centred), the shield overlaid on it, the dash cooldown pip, and the XP bar running full width along the very bottom edge (4px, Alien Violet).
  - **Bottom-right:** two weapon slots, each showing an icon, family-coloured border, ammo/heat/energy gauge and reload arc. The active slot is brighter.
  - **Right edge:** a column of power-up icons with tier pips (1–5) and timers.
- **Safe area:** keep 24px of margin and leave the centre 60% of the screen free of UI.
- **Level-up:** the game freezes, the playfield dims to 40% and the music ducks. Three cards (280×380) sit centred, each with the family colour along its top edge, the name, the tier pips, and stat deltas in mono (green ↑, red ↓). A single Reroll button sits below the cards, and keys 1/2/3 select a card. Curse cards get a magenta–red diagonal hatch.
- **Menus:** left-aligned vertical button stacks over a slow, blurred live 3D scene. Covers title, chapter select (a grid of 10 tiles; locked tiles are desaturated and show a padlock), settings (tabs: Audio, Video, Controls, Gameplay), run history (a mono table) and the pause screen (full freeze, panel on the left).
- **Off-screen indicators:** chests show as Hazard arrows at the screen edge, bosses as Threat Red chevrons at the screen edge.

## 3D and scenes
- **Camera (owner choice, overrides eye height):** a high three-quarter view. Perspective FOV 40°, pitched 55° down, about 22 m from the player. It follows the player with critically damped smoothing and a lead of about 2 m toward the aim direction. The visible area at 16:9 is roughly 30×18 m of floor.
- **Scale:**
  - player: 1.8 m tall, 0.4 m collision radius
  - swarmling: 0.5 m
  - grunt: 1.2–1.6 m
  - brute or shielded: 2.2 m
  - boss: 5–8 m
  - chapter arenas: 120×120 m up to 200×200 m
  - wall height: 2–4 m, low enough that the camera never loses the player
- **Asset style:**
  - **Horde:** procedural low-poly forms (capsules, faceted shards, crab-like tripods), each with 40–300 triangles, one InstancedMesh per archetype, and per-instance colour, hit-flash and dissolve attributes.
  - **Player and weapons:** procedural kit-bash in the family materials.
  - **Set dressing:** one CC0 kit (crates, barrels, pillars, pipes, barriers) with flat PBR materials and emissive strips added.
- **Lighting mood:** low ambient. The environment map is used only for reflections and IBL and is never shown as a backdrop; the background is Void with height fog. There is one cool moonlit directional light that casts the shadows. Dynamic point lights from muzzle flashes, explosions and glowing projectiles are pooled with a cap of 16 at High, 8 at Medium and 0 at Low (emissive only). The floor is wet: roughness about 0.35 with some puddle variation, so the neon reflects in it.
- **Post-processing:** ACES (or AgX) tone mapping, bloom with threshold about 1.0 so only emissives bloom, a subtle vignette, and a chromatic aberration punch of about 120 ms on big hits and boss slams. Every effect can be turned off per quality tier.
- **Quality tiers:**
  - **Low:** no shadows, 0.75× resolution, no bloom, 30% of particles.
  - **Medium:** 1024px shadow map, bloom on.
  - **High:** 2048px shadows, full particles, chromatic aberration.

## Assets
- **Set dressing:** Kenney "Space Kit" or "City Kit (Industrial)", or Quaternius sci-fi or modular industrial (all CC0), fetched with `forge-fetch url <zip> --license CC0 --source <page>`. Use one pack only, so the look stays cohesive.
- **Ground:** Poly Haven CC0 textures (concrete or asphalt, 1k) and one night or industrial HDRI at 1k, used for lighting only.
- **Fonts:** Fontsource, as above.
- **Not sourced:** enemies, projectiles, FX and audio are all procedural or code-authored.
- Every file is recorded in ASSETS.md with its source and licence.

## Motion
- **Sim and render:** the sim runs at 60 Hz and rendering interpolates between steps. UI transitions are 120–180 ms ease-out. Nothing bounces.
- **Hits:** a white hit flash of 60 ms on enemies, knockback, death as a dissolve plus a shard burst, and XP shards that arc and then accelerate into the magnet.
- **Screen shake:** trauma-based (shake = trauma²), capped and adjustable in settings, defaulting to 70%. Small for gunfire, large for explosions and boss slams.
- **Telegraphs:** at least 400 ms of wind-up before every charge, shot or lob. The enemy flashes Threat Red, then a charge line or landing ring appears on the ground and fills up until impact. Snipers draw a thin laser sight.
- **Dash:** a short afterimage trail in Alien Cyan, and the player is semi-transparent during the i-frames.
- **Damage numbers:** they float up 0.6 m and fade over 600 ms. Crits are larger and Hazard yellow. Numbers merge under a heavy horde so they never pile up into clutter.

## Avoid
- pixel art
- tiny sprites on a dark screen
- giant centred HP bars
- tutorial popups (use one-line hints on the pause screen at most)
- more than two font families
- CSS glow, blur stacks or animated scanlines over the playfield
- bloom on enemy bodies or the floor
- Threat Red used for anything that isn't a threat
- an HDRI shown as the background
- an all-black floor
- mixing asset packs with clashing styles
- full-screen flashes longer than 100 ms
- reliance on colour alone: telegraph shapes must also differ (line vs ring vs cone)

## Done looks like
- **Title:** a slow orbit over a dimly lit arena under neon fog. "NEON HORDE" in Chakra Petch 64 with a magenta-to-cyan underline, and the menu stacked on the left.
- **Gameplay:** a wet concrete arena with 1,000 dark bodies, each with an accent glow, closing in. Orange tracers and cyan plasma carve through them with bloom and shadows. The HUD stays in the corners and the centre is clear.
- **Telegraphs:** a charger glows red with a red line along the floor, a grenadier's lob shows a filling ring at the landing point, and both can be read even in a crowd.
- **Level-up:** the playfield is frozen and dimmed, music ducked, with three family-coloured glass cards and a Reroll button.
- **Chest hot drop:** a Hazard beacon column is visible from off-screen through its edge arrow.
- **Boss:** a 6 m silhouette with a magenta name plate and a top-centre HP bar (thin, 50% of the screen width).
- **Pause, settings and history:** a frozen scene behind a left panel and clean mono tables.
- **Death summary and victory:** a desaturated freeze-frame with the stats in mono, plus Restart Level, Restart Run and Menu. Victory uses a magenta-cyan sweep and offers Arena.
- **Low tier on WebGL2:** the same composition and readability without shadows or bloom. Emissives stay saturated.
