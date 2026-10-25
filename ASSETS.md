# Assets

Fetched by forge-fetch. Keep this file in sync with the files it lists.

| file | source | license | author |
|---|---|---|---|
| public/models/kenney-industrial/ | https://kenney.nl/assets/city-kit-industrial | CC0 | see source |
| public/textures/concrete_floor_02/concrete_floor_02_diff_1k.jpg | https://polyhaven.com/a/concrete_floor_02 | CC0 | Rob Tuytel |
| public/textures/concrete_floor_02/concrete_floor_02_nor_gl_1k.jpg | https://polyhaven.com/a/concrete_floor_02 | CC0 | Rob Tuytel |
| public/textures/concrete_floor_02/concrete_floor_02_rough_1k.jpg | https://polyhaven.com/a/concrete_floor_02 | CC0 | Rob Tuytel |
| public/textures/concrete_floor_02/concrete_floor_02_arm_1k.jpg | https://polyhaven.com/a/concrete_floor_02 | CC0 | Rob Tuytel |
| public/textures/concrete_floor_02/concrete_floor_02_ao_1k.jpg | https://polyhaven.com/a/concrete_floor_02 | CC0 | Rob Tuytel |
| public/textures/concrete_floor_02/concrete_floor_02_disp_1k.jpg | https://polyhaven.com/a/concrete_floor_02 | CC0 | Rob Tuytel |
| public/hdri/autoshop_01_1k.hdr | https://polyhaven.com/a/autoshop_01 | CC0 | Oliksiy Yakovlyev |

## Kept Kenney City Kit Industrial model files

All under `public/models/kenney-industrial/Models/GLB format/` (served from the site root as
`/models/kenney-industrial/Models/GLB format/<file>`). Every `.glb` references its texture
relatively as `Textures/colormap.png`, so that file must stay beside the models. The kit's
duplicate formats (FBX, OBJ), all preview/variation PNGs and the source `Models/Textures/`
variations were deleted to keep the repo small; only the GLBs, their `colormap.png` and
`License.txt` are kept. This one industrial kit is the only set-dressing pack (DESIGN.md: one
pack for a cohesive look); it stands in for the crates/barrels/pipes/tanks/walls a set-dressing
kit supplies.

Roles for later tasks: cover and walls → the `building-*` GLBs; props/chokepoints →
`chimney-*`, `detail-tank*`, `water-tower`, `windmill*`, `solar-panel*`; crate-shaped cover →
`shipping-container-a/b/c`.

Kept filenames (37 GLBs + 1 texture):

```
building-a.glb building-b.glb building-c.glb building-d.glb building-e.glb building-f.glb
building-g.glb building-h.glb building-i.glb building-j.glb building-k.glb building-l.glb
building-m.glb building-n.glb building-o.glb building-p.glb building-q.glb building-r.glb
building-s.glb building-t.glb
chimney-basic.glb chimney-small.glb chimney-medium.glb chimney-large.glb
detail-tank.glb detail-tank-large.glb
shipping-container-a.glb shipping-container-b.glb shipping-container-c.glb
solar-panel-flat.glb solar-panel-landscape.glb solar-panel-landscape-group.glb
solar-panel-portrait.glb solar-panel-portrait-group.glb
water-tower.glb
windmill.glb windmill-low.glb
Textures/colormap.png
```

## Ground + environment textures (Poly Haven, CC0)

`public/textures/concrete_floor_02/` is the wet-concrete floor set: `diff` (albedo), `nor_gl`
(normal + roughness in alpha), `rough` (roughness), `arm` (AO/roughness/metallic), `ao`,
`disp` (height). `public/hdri/autoshop_01_1k.hdr` is the industrial night environment map, used
for reflections/IBL only, never as a visible backdrop (DESIGN.md).