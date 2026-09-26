# STEELSEED — ARCHITECTURE

STEELSEED is the working name of Redline Wars: Fractured Order. It appears in paths, namespaces and
identifiers throughout the source.

**This file is the contract.** It is the binding technical specification for the codebase. Source
code cites its sections by number (for example `ARCHITECTURE.md §4.12`), so section numbers never
change. A change to a contract lands in the same commit as the code that implements it.

The game has five layers. Snapshots flow down; orders flow back up.

```
OpenRA simulation (C#, Red Alert rules, deterministic lockstep)   engine/openra/
  → .NET WebAssembly host, running in a Web Worker                engine/steelseed-host/
  → packed binary snapshot + events, once per simulation tick     §4
  → TypeScript client, one node per subsystem                     web/src/<node>/, §3
  → WebGPU renderer                                               web/src/render/, §12
```

Orders travel back as ordinary OpenRA orders (§4.11). The simulation is authoritative:
presentation reads snapshots and never changes game state.

## 0. Red Alert integration

### Simulation contract

The runtime is a pinned subset of OpenRA-Web (§1). Upstream bytes live only under `engine/openra/`.
All authored host code, the structural YAML transformation and the assetless presentation providers
live under `engine/steelseed-host/`. The OpenRA-Web worktree is a read-only source for the vendor
verifier and is never patched.

The build keeps the synchronized Red Alert rules, weapons, locomotors, factions, normal bots, lobby
options and the `map.yaml`/`map.bin` of 67 script-free skirmish maps. `assetless-policy.json` names
the presentation traits and fields that may be removed; an unknown removal or missing
gameplay-coupled sequence timing fails the build. Original sprites, tileset imagery, palettes, video,
audio, fonts, previews, installer paths and browser UI are excluded from source and output.

`GetSkirmishCatalog()` and `StartSkirmish(configJson)` form the cold, schema-v1 setup interface.
Realtime state uses the packed snapshot ABI, version 2 (§4). Local input uses OpenRA orders. ABI v2
carries the authoritative player table, actor-owner table indices, complete shroud RLE, map and
session lifecycle, and real lifecycle and production facts.

- Section 10 carries OpenRA `FrozenUnderFog` structures for explored, currently non-visible cells
  (§4.10d). Live moving actors never leak through it.
- Section 7 carries visibility-filtered fire, impact, damage, destruction and local
  production-complete events from OpenRA's trait interfaces (§4.9).
- Section 5 carries in-flight projectiles every tick, read from OpenRA's presentation-only
  `IProjectileFlight` surface (§4.7).
- The world section carries no environment facts, because Red Alert synchronizes no weather (§4.2).
  The view never fabricates them.
- Unavailable unsigned facts use all-ones sentinels instead of invented zero values.
- The host sends a complete shroud RLE every tick. A missing or zero-run update invalidates every
  prior visible cell. Missing shroud fails closed.

`simparitygate` builds a non-distributable, unstripped pinned Red Alert reference with only the
minimum headless presentation adapters, and compares its fixed-order sync hashes with two production
assetless runs.

**Resources (section 11, §4.10e).** The host publishes the live resources known to the render player.
It reads `IResourceLayer`, initializes fog memory from the starting resource layer as upstream
`ResourceRenderer` does, updates only visible cells, conceals unexplored cells and keeps the last
observed state under fog. The section changes no harvesting or regrowth rule. `resourcegate` tests decoder bounds and
live fog behaviour; `economygate` witnesses harvesting, depletion, delivery and production paid
entirely with ore.

**Credits.** Spendable credits are OpenRA `PlayerResources.Cash + Resources`. `Resources` already
stores ore's credit value and is spent first. The HUD total includes it, with a separate "Ore
included" breakdown.

**Floating text.** The host replaces only the compiled `FloatingText` presentation class, through
`engine/Directory.Build.targets`, and keeps the pinned vendor source and effect timing. The
replacement omits font access and 2D annotations because the host loads no fonts, so refinery, sell,
bounty and cash effects cannot stop the simulation on a missing font.

**Visual manifest.** The generated Red Alert visual manifest resolves every actor's gameplay traits,
locomotor, building terrain types, production types and build prerequisites. These facts choose
presentation roles only. Aircraft keep authoritative altitude over land and water. Naval and
landing-craft locomotors stay on OpenRA-permitted water and beach cells. Water structures use a low
slipway or quay at the rendered water level. Synchronized `Cloak` state lowers submarines beneath the
transparent water pass.

**Orders.** Contextual browser input sends only local actor ids plus a target. The host invokes the
same prioritized OpenRA `IIssueOrder` targeters that `UnitOrderGenerator` uses. `ActorMap`, locomotor
occupancy and `PathFinder` decide collision and reachability, never browser geometry. The
contextual-order result names the OpenRA orders it issued, for example
`ok: issued 1/1 OpenRA contextual orders (Attack)`, so gates can tell Attack from Move.

**Resource renderer.** OpenRA's `HarvestOrderTargeter` asks the world's `IResourceRenderer` which
resource a cell shows. The assetless mod removes `ResourceRenderer` with the rest of the sprite
presentation, so `AssetlessResourceRenderer` (`OpenRA.Mods.Steelseed`) answers from the
authoritative `ResourceLayer` and renders nothing. It is registered on `World` in
`assetless-presentation.yaml` and allowed by the assetless policy files.

**Transports and multiplayer.** `StartSkirmish` accepts only the local transport: a skirmish never
opens a socket, and a failed join never falls back to a local game. The network transport is
advertised by the catalog and driven through the `Join*` exports. It reuses the same catalog,
validation, order and snapshot boundaries without entering renderer state. Every client is a lockstep
viewer: it runs the same WASM simulation, renders its own snapshots and sends OpenRA orders, and the
bridge issues orders only for the local player. Relays and nodes move bytes and never parse orders;
each client's shroud comes from its own OpenRA host. The sim build id (the generated mod plus the
simulation sources) is stamped into the mod version, so OpenRA's handshake refuses a different build.

**Two presentation paths.** The Blender roster (below) is the default for every asset seed. The
procedural generators are the fallback when a pack is missing, invalid or disabled with `?noforge=1`.
§9 and §14.13 govern the procedural path.

### Simulation host in a Web Worker

The OpenRA runtime runs off the presentation main thread, in
`engine/steelseed-host/OpenRA.Browser/wwwroot/sim-worker.js` (§6). `moveperfgate.mjs` drives every
owned unit of the heavy starting roster back and forth across a map at low and high quality. The
worker must keep feeding at least 20 ticks per second, no main-thread stall may exceed 500 ms, and
presentation rAF p50 must stay at or below 33.4 ms.

Per-frame presentation work is bounded the same way. The environment placement scan runs on camera-cell
or world cadence, not every frame, and screen-space marks reproject only when the tick or the camera
moved.

Snapshot integrity rules:

- The per-world, one-shot `terrain.static` publication survives queue overflow. The proxy sheds
  buffers that a newer snapshot replaces, never the carrier of `terrain.static`.
- The worker copies only the payload length, not the whole snapshot slot.
- `units` type resolution leaves a type unresolved (not null-cached) while its actor-type table entry
  has not arrived.

### Snapshot emission cost

The emitter walks the playable cells, so caching bounds its per-tick cost:

- The shroud encoding is cached and re-emitted by block copy while `Shroud.Hash`, the render player
  and the fog setting are unchanged.
- Resource planes are rescanned only on a player or shroud change, or every five ticks
  (`ResourceSnapshot.RescanTicks`).
- Both walks index rectangular grids by `MPos` and skip the per-cell containment test that the render
  bounds already guarantee.

The shipped bundle is published with AOT (`dotnet publish -c Release`, which `ra:acceptance:full`
also uses). A bundle built without AOT runs the emitter under the .NET interpreter and is never
measured for frame rate (§11.1).

### Source art and material pipeline

Policy:

- Original authored assets and free CC0 sources are allowed. CC-BY 4.0 sources additionally require
  notices and in-game attribution.
- Paid or marketplace content, NC/ND/SA licences, unclear licences and all EA/Westwood content are
  excluded. These are project policy exclusions, not claims about any vendor's licence.
- Downloads happen only during builds. They are hash-pinned in `art/sources.lock.json` and stored
  under the ignored `art/.sources/`. The runtime receives baked local packs and makes no external art
  requests.
- No source-library import may bypass the provenance gate (`sourcelicensegate`). Every input a
  shipped pack rests on is recorded, with the rights it is used under, in
  `art/supplied-inputs.lock.json`; the gate refuses a release whose packs rest on an unrecorded input.
- The fetcher (`web/tools/art-fetch.mjs`) checks HTTPS and the denied-host policy at every redirect
  before it issues the next request. Extracted files are compared recursively with the pinned ZIP; an
  editable `.unpacked` marker cannot authorize changed or extra images. These failures stop the build
  and keep the edited files for inspection.

Material format:

- The mesh ABI is v1. UV0 carries authored UVs; UV1 carries the unique mask unwrap. Tangent frames
  come from the evaluated UV0 gradients, transformed and orthogonalized.
- Asset material tables and packed AO/cavity/dirt/wear mask references are optional. An actor without
  them uses the shared palette.
- Group 1, binding 6 carries a linear RGBA UV1 detail mask, or neutral `[1,0,0,0]`. Wear alpha never
  affects opacity.
- Actor aliases share the parent PBR arrays but own their mask texture and uniform buffer. Disposing
  an alias must not destroy the shared arrays.
- Mask mip chains are built before prewarm.
- Every material upload label uses the `steelseed/materials/` prefix, so the independent descriptor
  census (`vramgate`) sees all allocations. Material residency stays inside the §7 texture VRAM
  ceilings.

Ground:

- The ground material library references the pinned 2K Grass004, Ground054 and Ground037 inputs from
  `art/sources.lock.json`. No downloaded image is packed into the Blender source.
- Per-surface physical scale reaches the blended terrain shader through atlas binding 5: a 224-byte
  table of a vec4 header plus 13 vec4 scale entries. Ordinary per-set info is 32 bytes. The shared
  layout declares `minBindingSize` 0, which leaves the size check to WebGPU pipeline and draw
  validation; it does not suppress validation.

Foliage cards:

- The broadleaf foliage source renders unlit pigment, geometry normals and coverage into a pack. No
  lighting is baked.
- A manifest entry with `alphaCutout: true` opts an actor into prewarmed static and skinned cutout
  variants across the forward, depth/reflection and sun/moon shadow passes. Albedo alpha is coverage;
  UV1 detail alpha is wear. Opaque draws use their own pipelines.
- Mips preserve the nearest representable coverage, and tiny mips keep at least one pixel. Opaque
  palette zones are alpha 1.
- `foliagesourcegate` proves channel hashes, normal polarity, repeat identity and a saved-copy
  geometry edit. `cutoutgate` uses real GPU outputs and a receiver behind the holes, so the sky
  cannot hide an erroneous forward write.

Meadow:

- The `meadow-v1` pack carries saved whole-card grass LODs, and the runtime draws them through the
  same prewarmed cutout passes. Grass LODs are authored, because generic QEM deletes roots and tips.
- Preallocated grass pools are capped at 8k / 24k / 64k / 120k instances for low / medium / high /
  all higher tiers. These are allocation caps, not visible density.
- Placement uses independent seeded position, yaw and scale channels, and roots sample the whole
  cell. Roots follow the rendered relief. Sky wind shears the vertical axis, paused time preserves the
  pose and zero wind holds still. Grass height fades toward the ground at the end of its range, without
  alpha blending.
- Water, concrete, resources, steep slopes and unexplored cells exclude grass. Building exclusion uses
  only drawn live or frozen `Building` instances, as padded transformed mesh bounds in a preallocated
  2048-box buffer. Hidden actor state never clears grass. This is visual exclusion, not occupancy or
  collision.
- Parent and child hashes and material bindings are validated before any prop upload.
  `meadowdistributiongate` and the source gates cover these contracts.

Skinning extension:

- The exporter accepts explicit bind-pose vertex groups through the object JSON property
  `ss_skin_groups`, mapped to existing named rig bones. It normalizes at most four influences, keeps
  distinct-weight vertex seams and rejects unknown, empty or posed inputs. It never assigns weights by
  proximity. Rigid sources are one-hot.

### Blender presentation assets

The Blender roster covers all 283 manifest entries: 277 visible assets and six invisible gameplay
markers. The models are original Blender geometry; no original game art and no paid generation service
is an input. The Blender sources, the scripts that build them and the exported packs are separately
licensed creative files (`LICENSE`) and are not part of this repository (§14.9). `npm run forge`
exports the saved scenes, preserving hand edits and recording each source's SHA-256; it never
regenerates or overwrites a saved model. Identical recipes and Blender versions produce identical
mesh-pack bytes. `.blend` byte identity is not required.

Blender is Z-up. Export applies the rotation `(x,y,z) -> (x,z,-y)` into the Y-up, X-forward model
convention, for positions, normals, tangents and joint pivots alike. The pack uses the v1 `.ssmesh`
channel format, with explicit skeleton and animation metadata in the manifest. Object ownership
supplies skin weights; there is no spatial guessing. The shared 29-layer palette is a small
independent PBR surface set: layer 1 carries running-gear semantics and layer 12 is team paint. It
uses the existing material bindings and shader paths.

`units/blender-assets.ts` discovers generated output, downloads and decompresses it at boot, checks
SHA-256 and hands it to `blender-mesh.ts` for channel, index and rig validation. Models upload through
the normal renderer and LOD path. Turrets use authoritative snapshot facings, wheels and legs use
travelled distance, and rotor phase follows simulation tick time. Placement ghosts, frozen structures
and wreck captures reuse the loaded model handles. A missing, disabled or corrupt pack falls back to
the procedural generator with explicit diagnostics (`ctx.get('units').forgeStats`). Named environment
scenes and the saved material library export separately.

`blendergate` validates every entry, every moving joint, all checksums and the rejection of corrupt
input. `forgegate` requires 277 loaded meshes with no fallback, three GPU LODs, a rendered tank
witness and a visibly different fallback under `?noforge=1`.

### Authored LODs and human motion

`RenderApi.uploadLods(levels, label)` accepts exactly three validated, decreasing, source-authored
meshes and bypasses runtime QEM. `MeshStore` validates the whole chain before it allocates, keeps
caller-owned channels, unions the bounds of all levels and owns allocation, accounting, rollback and
disposal. `upload` builds the LOD chain at runtime (QEM). Asset consumers additionally validate range
and source hashes and identical rig, material and UV contracts, because the mesh store cannot
establish provenance. `authoredlodgate` covers CPU and upload invariants and failure rollback.
`humanlodgate` covers matching saved source and atlas hashes, production GPU skinning and
distance-based main and shadow LOD selection.

The motion exporter writes evaluated local translation deltas and quaternions from a separately saved,
editable Blender Action, bound by parent and model source hashes and identical 20-bone rest metadata.
Changed rest positions or axes are rejected unless the bound model is updated; normal exports never
rewrite sources. `units/human-motion.ts` validates and loads the bounded same-origin pack at boot, and
sampling does not allocate. `anim.interpolatedDistanceOf(id, alpha)` interpolates unwrapped travel with
the same snapshot alpha as placement, before conversion to model distance.

Two further actions ship as separate packs listed in the manifest's `clips`: `infantry-aim-v1`, from
the carried ready position to a shouldered aim, and `infantry-fire-v1`, a recoil pulse. Both are driven
by time, not distance, and both declare the bones they key. That mask is enforced on load: every bone
outside `upperBodyBones` must hold its bind pose in every frame, so the pelvis and legs stay on the walk
and an actor firing on the move keeps its gait.

`overlayHumanMotionClip(clip, pose, seconds, weight)` lays a clip over an already-sampled pose for
those bones only. It clamps a one-shot clip at both ends, wraps a looping one, allocates nothing and
reads no clock. `anim` owns the clock: it records each actor's last observed `weaponFire` against the
snapshot's own tick and ramps an aim weight per tick, exposed as `aimOf`, `interpolatedAimOf` and
`secondsSinceFire`. Callers keep no second clock. `units` plays both clips right after the walk
sample: the aim at `weight = interpolatedAimOf`, and the recoil at full weight for exactly its
duration after each shot.
`humanaimgate` issues a real shot through OpenRA's order path and compares the bone palette uploaded
to the GPU with the shipped clips: walk alone before the shot, walk plus overlay after it. Its
tolerances are measured from two consecutive captures of the same standing actor.

Anatomical infantry is the default. `?humanunits=0` restores the procedural figure and fetches none of
the packs. `?humanunits=1` makes a missing or invalid pack fatal, for gates; otherwise a missing pack
degrades to the procedural figure. Unique-UV surface sets expose `sourceSha256`, so consumers reject
mismatched mesh and atlas sources through the node API instead of importing another node's manifest.

### Environment, water and weather

The environment exporter writes the named scenery models and bakes the saved 13-surface Blender
material library. Both pack types carry source hashes and payload integrity checks. Materials upload
once, before terrain-atlas assembly, respect the quality budgets and keep a procedural fallback.
Continuous world-space UVs and seamless periodic noise avoid cell-sized colour changes. Surface type,
water coverage, movement and buildability always come from OpenRA.

`units/environment.ts` renders bounded, instanced grass, resources and precipitation through the
normal renderer. It clones borrowed terrain planes on map load and reads live resource density from
section 11. It never creates simulation actors or orders. Resource content respects the producer's fog
memory; foliage and precipitation respect the normal shroud. Branch rig metadata names the wind
joints, so wind reaches geometry, depth, shadows and motion transforms. Wind, water, rain and snow
share `sky`'s simulation-time clock. Red Alert provides no environment facts, so `sky` supplies a
view-only clear and shower cycle; query presets select clear, rain or snow for review. None of this
feeds the simulation.

The water shader lives in `render/shaders.ts` and draws through terrain's submitted draw items. Water
uses the baked normal map, wind-oriented wave scales, rain rings, refracted bed detail, depth
absorption, microfacet sun glints and Fresnel sky reflection. Water `uv1.x` carries a
presentation-only distance to dry land for animated, broken shore foam; `uv1.y` is physical water
depth, so flat deep beds keep their depth while the shoreline stays visible. The distance field never
changes cells, heights, water levels, navigation or shore geometry. Coarse wave normals are shared
with reflection metadata. Blender leaf layers receive restrained light wrap and transmission before
the shroud step. Frame uniforms carry `weather` (wind xz, strength, rain) and `surfaceWeather`
(wetness, snow, simulation seconds, reserved) at floats 244 and 248 (`render/frame.ts`). Rain lowers
the roughness of exposed surfaces.

### Relief reconstruction and the scenery ring

Red Alert tilesets store no cell height. When the height plane is uniformly zero, the view
reconstructs a landscape from the 2D cell grid: sea-level water, a coastal plain, rock masses as hills
with foothills, and beaches that ramp into the water. Aerial fog uses a compressed exponential
atmosphere, so it fills basins and thins on ridges. Reconstruction never changes passability, orders
or the snapshot. Authoritative OpenRA height is used unchanged when present, with literal cliffs and
per-cell corners.

The scale is pinned in metres in `terrain/grid.ts` (`RELIEF_*`) at the game's own unit scale: one cell
is one metre and a tank is about 2 m. Water beds sit 1.6 m below their shore, and hills are capped at
12 m. The tallest playable feature stays below the camera's lowest legal height. Terrace levels are
inferred from region adjacency across rock bands; this is a presentation inference.

Relief is one continuous surface. `connected()` is true everywhere under reconstruction, so no cell
opens a vertical face; the map's outer skirt is the only wall. A shared (w+1)×(h+1) corner grid is
built once per map. The chunk builder emits exactly those corners, and `heightAt()` interpolates
exactly the two triangles the builder emits per cell (the (0,0)–(1,1) diagonal), so a probe under a
wheel returns the drawn surface. `organicterraingate` asserts a 0.0 m difference over 4000 random
probes. The contour warp is disabled under relief for the same reason.

- Materials blend over a corner-centred gaussian window (`BLEND_REACH` = 2 cells), with the secondary
  surface chosen from a 5×5 tally. The window is symmetric across shared edges and chunk borders, so a
  boundary is a band rather than a cell edge.
- Passable ground rolls (`RELIEF_HILL_ROLL_*`), but a slope limiter lowers passable cells until no
  passable neighbour differs by more than `RELIEF_MAX_GRADE_M` = 0.6 m. Rock keeps its flanks, so
  mountains climb inside their own footprint.
- Water sits `RELIEF_BANK_M` = 0.12 m below its lowest bank, so the waterline crosses the bank slope.
- Shorelines are polylines at cell resolution on the bank slope. Rounder shores need a finer bed near
  water, never a vertex warp that the probes cannot follow.

`terrain/apron.ts` builds an out-of-bounds scenery ring as a second `TerrainGrid` around the
authoritative one. Its interior replicates the playable planes and its first ring replicates the
border cells, so the ordinary chunk builder produces identical seam corners. Beyond that it is
synthesized landscape (`APRON_TERRAIN`: `mountains` or `plains`). The ring is presentation only: the
camera stays clamped to the playable bounds, units never stand on it and `heightAt()` answers from the
authoritative grid. The ring is off by default on every preset (the lobby's distant-mountains switch).
When it is on, its width is the preset's `apronCells`. `?apron=N` overrides the width and `?apron=0`
removes the ring. Ground-following of the camera focus is damped like pan and zoom.

### Fog of war, selection and input

Fog of war is drawn as fog. Unexplored ground takes the aerial colour, desaturated and slightly
darkened, with a slow drift, so it reads as mist. Remembered ground is desaturated and half sunk into
the same mist. Beyond the playable bounds the scenery ring carries the border cell's state and then
fades into remembered mist, so the world ends in haze. The minimap keeps black for unexplored cells: it
is a map, not a view.

Under Red Alert rules the Radar Dome provides the minimap (`ProvidesRadar`) and the GPS Satellite
reveals the map. The shroud shown is OpenRA's own, so a reveal appears exactly when the simulation
grants it.

Selection rings are a thin, translucent grey-white mark (`snow` set, opacity 0.5, no player colour),
drawn only for selected actors. Right-click targeting uses a wider pick radius (44 px) than selection
(28 px); both grow to the actor's projected footprint and height, so a near miss on an enemy attacks
instead of moving.

Input follows OpenRA's counterclockwise `WAngle`: 0 = north, 256 = west, 512 = south, 768 = east.
`camera` owns orbit and pan; `ui` alone issues contextual gameplay orders. Q/E and middle-drag keep
their orbit pivot near map borders, and deliberate pan stays bounded. Picking follows the rendered
actor transform and altitude and fails closed for hidden actors. Right-click during placement only
cancels placement. Production clicks use OpenRA's append, Shift-five and Ctrl-priority semantics and
show the model portraits, progress, paused state and ready-to-place state.

### Rendering feature set

The WebGPU renderer runs a depth prepass, a clustered (froxel) light cull, forward+ shading and
post-processing (§12.2). It provides physically based shading, cascaded shadow maps, an ambient
irradiance probe volume (§13), temporal antialiasing with per-object motion vectors (§13), geometry
LOD, frustum and chunk culling, emissive-keyed bloom (§12.1) and an AgX display transform (§14.5).
Physical units are SI throughout (§12.4). One world wind field is shared by foliage, water, rain and
clouds (`sky`). Surface wetness and snow feed material response. Instanced foliage stays within a
camera radius under draw budgets. `dbgview.mjs` reads the debug views.

Screen-space reflections use visible scene depth and material metadata, with hit/miss, roughness and
screen-edge confidence. Geometry outside the image is unavailable to them. They are on in `turbo`,
`classic`, `ultra` and `ultra-max` (§7). Contact shading is a bounded, depth-based approximation, not
global illumination. It is off in every preset; `?contact=1` enables it for comparison.

Presentation-only motion (foliage, water, debris, wrecks) never feeds back into the simulation. A
frame-rate claim states its hardware, resolution, preset and workload (§11).

### Death presentation and aircraft clearance

Live actor transforms come from OpenRA snapshots. `units` keeps no memory of an actor beyond the
snapshots, with one exception: the 64-entry death-visual cache. An authoritative destruction event may
retain the last drawn source mesh, model transform, player colour and completed skin palette. This is
disposable presentation state, never an actor, hitbox, path obstacle, target, damage calculation or
predicted death. The renderer owns every borrowed GPU buffer, and capture copies palette values before
the next frame overwrites them. Event birth uses the authoritative tick, not stale frame alpha.

Humans and animals collapse, rest and fade. Rigged vehicles detach their real source parts and fade.
Aircraft bodies descend. Static buildings continue through the persistent wreck node, which never also
keeps an intact copy of an animated casualty. Visibility is checked at birth and over current part
bounds; expired or rewound visuals clear. Contact is a conservative, source-bound approximation, not a
rigid-body solver.

On Red Alert maps with verified zero-height or ramp-only sources, aircraft presentation adds
reconstructed terrain clearance with spatial anticipation. Maps with their own elevation bypass it.
No simulation altitude, movement, targeting or damage changes. Airborne death effects use the captured
displayed hull height, so an explosion cannot appear under a visual mountain.

The instance record is 24 floats (§12.2). A non-negative final scalar is opaque damage; a negative one
packs an 8-bit damage band in even integer steps plus fractional opacity
(`render/instance-appearance.ts`). Static and skinned forward shaders both decode it. Fading geometry
keeps its damage shading and must not write depth or shadows. Material-mask alpha is wear, never
opacity.

The shared skin palette is fixed at 32768 matrices, 2 MiB per GPU buffer (current and previous).
Transient death poses reserve ahead of live and ambient rigs. CPU and GPU allocation is fixed at boot,
with explicit overflow counters.

---

## 1. Provenance and rebase

| fact | value |
|---|---|
| upstream | `https://github.com/OpenRA/OpenRA.git` |
| fork | OpenRA-Web, the WebAssembly port of OpenRA (branch `wasm-port`) |
| `engine/` snapshot base | **`49da5cf300411e034484f8231c0e535ba9effe13`** |
| `engine/openra/` runtime pin | upstream URL and commit in `engine/openra/vendor-policy.json`; SHA-256 of every pinned file in `engine/openra/provenance.lock.json` |

`engine/` holds two trees:

- the fork snapshot at the top level (`engine/OpenRA.Game/`, `engine/OpenRA.Mods.*/`,
  `engine/OpenRA.Browser/` and the other upstream projects);
- the pinned runtime subset under `engine/openra/`, which the WebAssembly build and the ranked replay
  verifier compile.

### 1.1 How the fork is vendored

`engine/` contains tracked files only, with no `.git` history. Upstream history contains EA binaries
(`mods/cnc/bits/*.shp`, `*.aud`, `global mix database.dat`), and a repository's history is part of the
repository. A nested `.git` would also stop the parent repository from tracking `engine/`.

Rebasability is kept by record rather than by remote. Inherited engine source is never edited in this
repository: `engine/openra/` must match its lock byte for byte, and `engine/OpenRA.Game/`,
`engine/OpenRA.Mods.Common/` and `engine/OpenRA.Mods.Cnc/` stay untouched. Gameplay code of our own
lives in a standalone assembly (§1.5). Upstream patches therefore apply cleanly by construction. Do
not weaken this for convenience.

To verify the runtime subset, or to move its pin after changing the commit in `vendor-policy.json`:

```bash
node engine/steelseed-host/tools/vendor-openra.mjs --source=/path/to/OpenRA-Web                        # verify
node engine/steelseed-host/tools/vendor-openra.mjs --source=/path/to/OpenRA-Web --vendor --write-lock  # re-vendor
```

The tool reads the pinned commit with read-only `git show` and checks that the source worktree is
unchanged afterwards.

To pull upstream changes into the top-level fork snapshot, diff upstream and apply with a three-way
merge:

```bash
git clone https://github.com/OpenRA/OpenRA.git /tmp/openra-upstream
cd /tmp/openra-upstream && git diff 49da5cf3..<target> -- OpenRA.Game OpenRA.Mods.Common OpenRA.Mods.Cnc \
  > /tmp/engine.patch
cd <repository>/engine && git apply --3way /tmp/engine.patch
```

### 1.2 What the vendored trees exclude, and why

Runtime subset (`engine/openra/vendor-policy.json` is authoritative):

| excluded | reason |
|---|---|
| `mods/ra/chrome.yaml`, `metrics.yaml`, `cursors.yaml`, `uibits/`, `bits/` | 2D presentation; the WebGPU client draws everything |
| `mods/ra/audio/` | original audio |
| `mods/ra/ZoodRangmah.ttf` | fonts; the host loads none |
| `mods/ra/maps/*/*.lua`, campaign and co-op mission rules, campaign maps | scripting and campaigns; the runtime is skirmish and multiplayer only |
| `OpenRA.Browser/` with its agent mode, sidecar and tests | the fork's browser host; `engine/steelseed-host/OpenRA.Browser/` replaces it |
| `.aud .des .int .lua .pal .png .shp .sno .tem .ttf .vqa .wav .wsa` files | original art, audio, video, palettes and scripts |

Map extraction keeps only `map.yaml` and `map.bin` from each `.oramap` and rejects Lua, custom rules,
weapons, sequences and art entries.

Fork snapshot (`engine/` top level):

| excluded | reason |
|---|---|
| `mods/{ra,cnc,d2k,ts,all,common}`, `mods/*-content` | EA content and unused mods; Red Alert gameplay text lives in `engine/openra/mods/ra/` |
| `packaging/artwork/*.png` | EA icons |
| `OpenRA.Browser/BrowserContentInstaller.cs`, `wwwroot/openra-content.js`, `OpenRA.Browser/Content/` | the game never fetches or mounts original content |
| `global mix database.dat`, `IP2LOCATION-LITE-DB1.IPV6.BIN.ZIP` | EA data and a third-party binary database |
| `OpenRA.Browser/tests/fixtures/determinism-ra.orarep` | a binary replay of EA content (§1.4) |
| `OpenRA.WindowsLauncher/`, `OpenRA.Launcher/`, desktop launch scripts | the game ships as a browser build and its own desktop shell |

**Kept on purpose:** `OpenRA.Mods.Common/FileSystem/ContentInstallerFileSystemLoader.cs`. It is
unreferenced code, not mounted content. Deleting it from a directory that is never edited would break
the clean-rebase property of §1.1 for no benefit.

### 1.3 Trademark names: authored surface and inherited source

The authored code surface carries no Westwood/EA trademark names in prose: `web/src/`, `web/tools/`,
`engine/mods/`, `engine/OpenRA.Browser/Steelseed/` and `engine/OpenRA.Mods.Steelseed/`. `rulecheck`
scans these directories. Inherited engine source keeps upstream naming and OpenRA's copyright headers,
because it is never edited (§1.1).

**Structural references are exempt; prose is not.** Authored code must be able to name an inherited
assembly, or the fork could not reference the engine it forked.

- **Exempt:** mechanical references: `ProjectReference`, `TrimmerRootAssembly`,
  `WasmFilesToIncludeInFileSystem`, `using`/`import`, `require()`, `Assembly.Load`, `typeof(...)`.
- **Not exempt:** prose. A comment reading "mirrors OpenRA.Mods.Cnc" fails, because the sentence can be
  written without the trademark and loses nothing by it.

`rulecheck.mjs` implements exactly this split.

### 1.4 Replays are text, never binary

No replay file (`.orarep`) is committed. A scripted match is a committed text order-script:

```
web/tools/replays/<name>.orders.json   # { schema, serverSeed, scenario, orders: [{tick, player, order...}] }
```

A harness feeds the script to the host one line at a time (`playtest.mjs`). The simulation is
deterministic lockstep and the script is fixed, so the resulting sync-hash sequence is fixed, which is
all a determinism gate needs.

### 1.5 Maps and the gameplay assembly

The skirmish catalog is the 67 script-free Red Alert maps vendored from OpenRA-Web (`map.yaml` and
`map.bin` only, §1.2), plus one original landmark map, River Crossing, which `build-ra-mod.mjs` writes
at build time. No other map file is stored.

The standalone `mods/steelseed` mod generates its maps in memory. `SteelseedMapGenerator`
(`engine/OpenRA.Mods.Steelseed/`) builds a complete playable map (heightfield, terrain types, resource
fields and N spawn points laid out with the symmetry the player count needs) from a named preset: a
seed plus parameters (size, biome, symmetry, resource density, chokepoint bias). The same preset and
seed produce the same map every time. Nothing is written to disk.

**Gameplay code lives in a standalone, RID-neutral assembly.** A mod manifest's assemblies must load
in both the desktop utility (to validate YAML) and the WebAssembly host (to run), and only a RID-neutral
assembly in `bin/` satisfies both. It is also how upstream separates gameplay code from a platform
host, which keeps the fork rebasable (§1.1).

| | |
|---|---|
| projects | `engine/steelseed-host/OpenRA.Mods.Steelseed/` (the Red Alert runtime, output `engine/openra/bin`); `engine/OpenRA.Mods.Steelseed/` (the standalone mod's map generator and roster export) |
| shape | a plain class library like `OpenRA.Mods.Cnc.csproj`, inheriting the engine's `Directory.Build.props`, with RID-neutral `bin/` output |
| declared as | `OpenRA.Mods.Steelseed.dll` in the mod's `mod.yaml`, **never** `OpenRA.Browser.dll` |
| forbidden | must never reference `OpenRA.Browser`. Gameplay code stays platform-agnostic. |

---

## 2. Directory ownership

Each subsystem owns its directory. This table is the authority on what lives where.

| path | contents | rule |
|---|---|---|
| `engine/openra/` | pinned runtime subset of OpenRA-Web | read-only; must match `provenance.lock.json` (§1.1) |
| `engine/OpenRA.Game/`, `engine/OpenRA.Mods.Common/`, `engine/OpenRA.Mods.Cnc/` | inherited engine source | **frozen**; never edited (§1.1) |
| `engine/steelseed-host/` | WebAssembly host (`OpenRA.Browser/`), assetless traits (`OpenRA.Mods.Steelseed/`), mod YAML (`mod/`), policies, node tools and host gates (`tools/`) | authored |
| `engine/mods/steelseed/`, `engine/OpenRA.Mods.Steelseed/` | the standalone mod and its gameplay assembly (§1.5) | authored |
| `engine/OpenRA.Browser/` | the fork's original WebAssembly port and its test harnesses | authored |
| `web/src/core/`, `web/src/geo/` | registry, ctx, RNG, math and snapshot decoder; the stateless geometry library | importable by every node |
| `web/src/<node>/` | one subsystem (§3) | owned by that node; other nodes reach it at runtime only |
| `web/tools/` | build tools and gates | |
| `art/sources.lock.json`, `art/supplied-inputs.lock.json` | hash-pinned third-party art downloads; every input a shipped pack rests on, with its rights | the provenance gate reads both (§0) |

Cross-node access is **runtime only**: `const fx = ctx.get('fx')`. A static `import` of another
subsystem's module fails `rulecheck`: it defeats independent work on nodes and creates load-order
cycles. `core` and `geo` are the exceptions. They hold types, math, the RNG, the snapshot decoder and
stateless geometry functions, with no node instance, init order or GPU object to couple to.

---

## 3. Node contract

```ts
export class MySystem {
  static id   = 'mysystem'      // unique registry key; how others reach you
  static deps = ['render']      // ids that must complete init() before yours starts

  async init(ctx: Ctx): Promise<void> {}   // build resources; may await
  onSnapshot(snap: Snapshot, prev: Snapshot | null, ctx: Ctx): void {}  // once per sim tick, 25 Hz
  update(dt: number, ctx: Ctx): void {}    // once per rendered frame — interpolate, animate
  lateUpdate(dt: number, ctx: Ctx): void {}
  resize(w: number, h: number, ctx: Ctx): void {}
  prewarm(ctx: Ctx): void {}               // compile/upload everything you can produce
  dispose(): void {}
}
```

`ctx` provides:

| member | type | notes |
|---|---|---|
| `device` | `GPUDevice \| null` | null only when WebGPU is unavailable; the renderer then stays disabled (§13) |
| `gl` | `WebGL2RenderingContext \| null` | null on the WebGPU path; no renderer uses it (§13) |
| `backend` | `'webgpu' \| 'webgl2'` | decided once at boot, never changes |
| `canvas` | `HTMLCanvasElement` | |
| `config` | `Config` | `config.q` is the active quality preset (§7) |
| `events` | `EventBus` | §4.9 event vocabulary |
| `input` | `Input` | raw capture; `camera` interprets it |
| `time` | `{elapsed, dt, tick, alpha, frame}` | `alpha` ∈ [0,1) is the sim-tick interpolant |
| `rng` | `Rng` | SplitMix64. `ctx.rng.fork()` for an independent stream |
| `snapshot` | `Snapshot \| null` | latest decoded snapshot |
| `get(id)` | `T` | throws if absent — declare it in `deps` |
| `peek(id)` | `T \| null` | does not throw; for optional collaborators |
| `has(id)` | `boolean` | |
| `actorTypeName(typeId)` | `string` | the mod's name for a snapshot `typeId` (§4.5, §14.13) |

**Interpolation is mandatory.** The sim ticks at 25 Hz (40 ms); you render at display rate. Every world
transform is interpolated between snapshot `N-1` and `N` by `ctx.time.alpha`. Facings interpolate on the
**shortest arc**: a unit rotating through 1023→0 must not spin the long way. A unit that pops, stutters
or teleports between ticks is a gate failure.

### 3.1 The `Mesh` contract

`web/src/geo/mesh.ts` is the canonical geometry container. Every mesh-producing node (`geo/*`, `units`,
`terrain`) and every consumer (`render`, `anim`) uses it, so its field names are contract, not
implementation detail. **Anything more than one node consumes is pinned in this file before anyone
builds against it.**

| field | type | notes |
|---|---|---|
| `positions` | `Float32Array` | 3 floats per vertex |
| `normals` | `Float32Array` | 3 per vertex |
| `tangents` | `Float32Array` | 4 per vertex (w = handedness ±1) |
| `uv0`, `uv1` | `Float32Array` | 2 per vertex |
| `materialZone` | `Uint8Array` | per-vertex zone index — the texture forge keys its zone table off this, and it is what makes player colour a real repaint rather than a hue shift |
| `skinIndices` | `Uint8Array \| null` | 4 per vertex; null on a static mesh |
| `skinWeights` | `Float32Array \| null` | 4 per vertex, normalised to sum 1 |
| `indices` | `Uint32Array` | triangle indices |
| `vertexCount`, `triangleCount` | `number` | |
| `aabbMin`, `aabbMax`, `boundingSphere` | `Float32Array` | readonly |

**Construct through the API, never by assigning buffers.** `Mesh` maintains capacity, counts and
bounds internally. A mesh whose arrays were swapped in behind its back reports `vertexCount === 0` to
every consumer and silently renders nothing. An object literal shaped like a `Mesh` typechecks under a
structural cast and fails at the first `computeNormals()`.

Prefer the methods over touching the raw arrays; they maintain capacity, bounds and skin state:
`addVertex`, `addTriangle`, `addQuad`, `setPosition`, `setNormal`, `setTangent`, `setUv0`, `setUv1`,
`setZone`, `setSkin`, `getPosition`, `getNormal`, `reserve`, `clear`, `clone`, `dispose`,
`enableSkin`, `flipWinding`.

**Toolchain note.** TypeScript 5.7 made the typed arrays generic over their buffer
(`Float32Array<TArrayBuffer extends ArrayBufferLike = ArrayBufferLike>`). A growable-pool helper that
returns a bare `Float32Array` yields `Float32Array<ArrayBufferLike>` and will not assign to a field
inferred as `Float32Array<ArrayBuffer>`. Make the field and the helper agree explicitly. `as any`,
`@ts-ignore` and loosening `tsconfig.json` are not allowed: the geometry layer is where a silent type
error becomes corrupt vertex data.

---

## 4. Frame contract — packed binary snapshot

The **only** channel between simulation and presentation. No JSON in the hot path, no side channels, no
reaching into traits from JS, no reflection. All integers **little-endian**. All section offsets
**4-byte aligned**.

Emitted once per sim tick over the host's `[JSExport]` seam. Double-buffered: the bridge writes buffer
`A` while JS reads `B`, then swaps. **The bridge allocates no snapshot buffer per tick.** Both buffers
are fixed 8 MiB allocations, made once and reused; §4.11b pins the exact managed allocation sequence.

The ABI version is 2. The emitter (`engine/steelseed-host/OpenRA.Browser/SnapshotEmitter.cs` and
`SnapshotWriter.cs`), the decoder (`web/src/core/snapshot.ts`) and the independent layout parser in
`engine/steelseed-host/tools/snapshotabigate.mjs` are the executable definition of the byte layout. The
development bridge (`web/src/core/devsnapshot.ts`) produces the same layout for fixtures.

### 4.1 Buffer layout

```
[FileHeader 32B][SectionTable 12B × sectionCount, room reserved for 13][section payloads, 4B aligned]
```

**FileHeader** — 32 bytes

| off | type | field |
|---|---|---|
| 0 | `u32` | magic `0x504E5353` (`'SSNP'` LE) |
| 4 | `u16` | version — **2** |
| 6 | `u16` | sectionCount |
| 8 | `u32` | byteLength (total, including header) |
| 12 | `u32` | tick — `World.WorldTick` |
| 16 | `u32` | syncHash — `World.SyncHash()` |
| 20 | `u32` | gameTimeMs — tick × `World.Timestep`, clamped to `u32` |
| 24 | `u32` | flags: `1<<0` terrain.static present · `1<<1` paused · `1<<2` replay · `1<<3` game over |
| 28 | `u32` | reserved (0) |

**SectionTable entry** — 12 bytes, one per present section, in write order

| off | type | field |
|---|---|---|
| 0 | `u16` | sectionId |
| 2 | `u16` | sectionFlags — always 0 |
| 4 | `u32` | byteOffset from buffer start |
| 8 | `u32` | byteLength, including the section's trailing alignment padding |

The host reserves room for 13 table entries, so the first payload starts at byte 188 whatever
`sectionCount` is. Readers find a section through the table by its id. They never assume ascending
ids, adjacent payloads or a fixed start. A section absent this tick is simply not in the table, and JS
must tolerate any subset.

**Section ids**

| id | name | cadence |
|---|---|---|
| 0 | `world` | every tick |
| 1 | `terrain.static` | at map load and after an authoritative tile change (header flag `1<<0`) |
| 2 | `terrain.delta` | reserved; never written (§4.4) |
| 3 | `actors` | every tick |
| 4 | `actors.lifecycle` | every tick |
| 5 | `projectiles` | every tick; count 0 when nothing is in flight |
| 6 | `shroud` | every tick |
| 7 | `events` | every tick |
| 8 | `player` | every tick |
| 9 | `production` | every tick; absent means unsupported |
| 10 | `actors.frozen` | every tick: structures remembered under fog (§4.10d) |
| 11 | `resources` | every tick: live resources known to the render player (§4.10e) |
| 12 | `deployments` | every tick; records only for visible construction yards made by a deploy |
| 13 | `actors.status` | every tick: timed states a visible unit carries |

The host writes the sections in the order 0, 1 (when present), 3, 4, 6, 7, 8, 9, 10, 11, 5, 12, 13, and
the section table lists them in that order.

### 4.2 Section 0 — `world`

| off | type | field |
|---|---|---|
| 0 | `i32 ×4` | world bounds: `left, top, right, bottom` (cells) |
| 16 | `u32` | cell size in WDist, always `1024` (one cell) |
| 20 | `u16` | render player: index into the `player` table (§4.10); `0xFFFF` when there is none |
| 22 | `u8` | map state: 2 running · 3 game over |
| 23 | `u8` | session state: 1 running · 2 paused |
| 24 | `u32` | environment present: 0 or 1 |
| 28 | `u16` | time of day, 0..1439 minutes (this and the rows below only when the environment is present) |
| 30 | `u16` | weather kind: 0 clear · 1 overcast · 2 rain · 3 snow · 4 dust |
| 32 | `u16` | weather intensity 0..1000 |
| 34 | `u16` | wind direction, WAngle 0..1023 |
| 36 | `u16` | wind speed 0..1000 |
| 38 | `u16` | pad |

The Red Alert host always writes environment present = 0 and ends the section at byte 28, because Red
Alert synchronizes no weather; `snapshotabigate` fails on any other length. Only the development bridge
writes the environment block, for deterministic fixtures. The bounds are the map's render bounds
(`Map.Bounds` on a rectangular map); `right - left` and `bottom - top` are the grid width and height
every per-cell section uses.

### 4.3 Section 1 — `terrain.static`

Structure-of-arrays over `w*h` cells, row-major, `w` and `h` from world bounds. Each plane is padded to a
4-byte boundary.

| type | field |
|---|---|
| `u32` | w |
| `u32` | h |
| `u8[w*h]` | terrain type index (into the tileset's terrain-type table) |
| `u8[w*h]` | height (OpenRA cell height) |
| `u8[w*h]` | ramp type |
| `u8[w*h]` | passability bits — see below |
| `u8[w*h]` | resource type in the map file (0 = none); live resources are section 11 |
| `u8[w*h]` | surface type (§8 enum) |

A cell inside the bounds but outside the map reads 0 in every plane except passability, which is `1<<4`
(blocked). The surface plane maps Red Alert terrain types onto §8; `Clear` and `Tree` become the
tileset's ground (`grass`, or `sand` on desert and `snow` on snow maps). **The render must match this
grid exactly**: `terrain` never invents its own passability. The gate is an overlay proof against this
section.

**Passability bits, stated precisely.** Every one is derived from the simulation, never from a
terrain-type guess. Bits 0–2 and 4 answer *movement* questions via `Locomotor.MovementCostForCell`, the
same call the pathfinder makes: a locomotor may enter a cell whose cost is not
`PathGraph.MovementCostForUnreachableCell`. Bit 3 answers a *terrain* question.

| bit | meaning |
|---|---|
| `1<<0` foot | the `foot` locomotor may enter |
| `1<<1` wheeled | the `wheeled` locomotor may enter |
| `1<<2` tracked | the `tracked` locomotor may enter |
| `1<<3` water | **the cell IS water** (terrain type `Water` or `Shallow`) — NOT "something amphibious may enter" |
| `1<<4` blocked | **nothing** may enter: none of the `foot`, `wheeled`, `tracked` or `naval` locomotors |

Two rules for consumers:

- **Bit 3 is a terrain fact, not a movement answer.** Deriving it from a hover locomotor would set it
  on ordinary clear ground, because hover traverses land and water alike. Consumers of this bit (water
  rendering, splash fx, footstep audio) ask whether the cell *is* water.
- **`blocked` is not "not land-passable".** A water cell is passable to something and is not blocked;
  a cliff is blocked. A consumer selecting buildable ground wants `foot && !blocked`, not `!water`.

### 4.4 Section 2 — `terrain.delta`

Section id 2 is reserved. The decoder names it (`SectionId.terrainDelta`), but the host never writes it
and the decoder never reads it. Live resources travel in section 11 (§4.10e), and section 1 is
published again after an authoritative tile change. Id 2 is not reused.

### 4.5 Section 3 — `actors`

**Structure-of-arrays**, so JS can view each field as a typed array and feed GPU instance buffers with
no per-actor JS object. Arrays appear in this exact order, `n = count`. Padding to a 4-byte boundary
follows the `u16` group, the `u8` group, `displayTypeId` and `turretFacing`; inside a group the arrays
are packed.

| type | field | notes |
|---|---|---|
| `u32` | count | |
| `u32` | turretTotal | sum of all `turretCount` |
| `u32[n]` | id | stable OpenRA actor id |
| `i32[n]` | posX | WPos |
| `i32[n]` | posY | WPos |
| `i32[n]` | posZ | WPos |
| `u16[n]` | typeId | index into the type table |
| `u16[n]` | facing | WAngle 0..1023 of the actor's first `IFacing`; 0 without one |
| `u16[n]` | animState | semantic posture: 2 prone; `0xFFFF` otherwise. **Never a clip index or frame counter** |
| `u16[n]` | prodProgress | always `0xFFFF`; production progress travels in sections 8 and 9 |
| `u16[n]` | turretOffset | start index into `turretFacing` |
| `u16[n]` | speed | mean WDist/tick since the actor's previous sample, at most `0xFFFE`; `0xFFFF` on its first sample |
| `u8[n]` | owner | index into the `player` table (§4.10); 255 when none |
| `u8[n]` | health | 255 × HP / max HP; 255 without a `Health` trait |
| `u8[n]` | cargo | passenger count |
| `u8[n]` | turretCount | |
| `u8[n]` | flags | `1<<0` disabled · `1<<1` cloaked · `1<<2` parachuting · `1<<3` husk · `1<<4` deployable · `1<<5` firing · `1<<6` moving · `1<<7` submerged (named by the decoder; the host never sets it) |
| `u8[n]` | surface | surface the actor stands on (§8); 0 outside the map |
| `u8[n]` | ammo | current ammo across `AmmoPool` traits, at most 254; 255 means no limited pool |
| `u8[n]` | cargoReserved | `Cargo.ReservedCount`: passengers that reserved a seat and are on their way in |
| `u8[n]` | veterancy | `GainsExperience` level; 0 without one |
| `u16[n]` | displayTypeId | after alignment; the type to draw. Equals `typeId` unless an effective-owner trait disguises the actor |
| `u16[turretTotal]` | turretFacing | after alignment; WAngle 0..1023 of each turret's world yaw |
| `u32[n]` | crashParentId | after alignment; original aircraft of a falling husk, otherwise 0. The host always writes it; a decoder accepts a section that ends before it |

The flag bits mean: `disabled` is the rules' `disabled` condition (low power, an outage, a power-down);
`cloaked` is any active `Cloak`, which is also how a submerged submarine reports; `parachuting` is
`Parachutable.IsInAir`; `husk` is a dead actor or one falling to earth; `deployable` means a deploy
order can be issued now; `firing` is an `AttackBase` that is aiming; `moving` is any `IMove` with a
current movement type.

The section carries only in-world actors that occupy space and that the render player may see: all of
its own actors, and others through OpenRA's own `CanBeViewedByPlayer`. With no render player it is
empty. Editor-only markers (spawn points, waypoints) never appear.

The type table (`snapshotTypeTable`) is one string list for every name a snapshot carries: actor types,
weapons (event records), production items and factions. The emitter registers every ruleset actor type,
every weapon key and every armament's authored weapon name before the first snapshot leaves, so a name
first used mid-match is never an id past the table the browser has fetched. Later entries (factions,
nameless husks) stay lazy.

Actors are ordered by ascending `id` every tick, so `prev`-to-`curr` matching is a merge, not a hash
lookup, and the ordering itself is deterministic.

### 4.6 Section 4 — `actors.lifecycle`

| type | field |
|---|---|
| `u32` | count |
| `{u32 actorId, u16 typeId, u8 kind, u8 owner}[]` | `kind`: 0 created · 1 destroyed; `owner`: player table index, 255 when none |

A created record is published only when the new actor is in the same snapshot's visible set. A
destroyed record is published when an actor that was visible in the previous snapshot leaves the world.
The decoder also names 2 captured, 3 sold and 4 husk-spawned; the host does not emit them.

### 4.7 Section 5 — `projectiles`

Published every tick from OpenRA's read-only `IProjectileFlight` surface, at most 512 flights per
snapshot. Count zero means no flights. A superweapon missile (`NukeLaunch`) is a flight too, named by its
weapon (`atomic`), from the tick it leaves the silo until it detonates; it carries no source actor or
launch facts. Fields are separate arrays in the listed order; position axes are OpenRA world X/Y/Z.

| type | field |
|---|---|
| `u32` | count |
| `u32[n]` | id, sourceActorId |
| `i32[n]` | posX, posY, posZ, tgtX, tgtY, tgtZ |
| `i16[n]` | velX, velY, velZ |
| `u16[n]` | typeId, remainingTicks |
| `u8[n]` | kind (0 flight, 1 instantaneous beam) |
| padding | align to four bytes |
| `i32[n]` | launchX, launchY, launchZ |
| `u32[n]` | launchShot |
| `u16[n]` | launchArmament, launchBarrel |

The prefix occupies `4 + 43*n` bytes before alignment. The launch tail adds `20*n` bytes; the host
always writes it, and a decoder accepts a section without it.

- `id` is the projectile's runtime object hash: stable for one flight, opaque otherwise. OpenRA
  projectiles carry no simulation identity.
- A flight is published only over a visible, explored cell, and it publishes its own position as its
  target, so nothing reveals where it is aimed. A beam publishes its real far end, and only when both
  ends stand on visible, explored cells.
- Velocity is WDist per simulation tick, clamped to `i16`. `typeId` is the type-table id of the weapon's
  authored name. `remainingTicks` is 65535 when the projectile homes and cannot know its arrival.
- `sourceActorId` and the launch tail are filled only when the source actor is visible and its launch
  cell is visible. Otherwise the source is 0, the launch position 0, the shot 0 and armament and barrel
  `0xFFFF`. The tail identifies the real shot and captures its source once; it cannot steer the
  projectile.
- `launchShot`, `launchArmament` and `launchBarrel` match the `shot`, `armament` and `barrel` of the
  `weapon:fire` event (§4.9), so a client can pair a launch, its flight and its impact.

### 4.8 Section 6 — `shroud`

Per-cell visibility for the render player, run-length encoded over the world bounds in row-major order.

| type | field |
|---|---|
| `u32` | runCount |
| `{u32 cellIndex, u16 runLength, u8 state, u8 pad}[]` | `state`: 0 unexplored · 1 explored-not-visible · 2 visible |

`cellIndex` is the first cell of the run. Runs are contiguous from cell 0 and cover every cell in the
bounds every tick; a run holds at most 65535 cells. State 2 means visible and explored, so with the
lobby's fog option off every explored cell is 2 while unexplored ground stays 0. Without a render player
the section carries zero runs, and a missing or zero-run update invalidates every prior visible cell.
**Zero information leak** is a `shroud` gate, and it binds every node: a hidden actor must not appear in
reflections, shadows, light bleed, particle spawns or audio.

### 4.9 Section 7 — `events`

A tagged stream. Every record is 4-byte aligned and begins with a 4-byte record header, so an unknown
event kind is skippable. That lets the host add events without breaking an older consumer.

```
u32 eventCount
per record:  [u16 kind][u16 byteLength][payload…]
```

`byteLength` counts the payload only; each record is padded to a 4-byte boundary.

| kind | name | payload |
|---|---|---|
| 1 | `weapon:fire` | 30 bytes: `u32 actor, u16 armament, i32 muzX, i32 muzY, i32 muzZ, u16 facing, u16 weapon, u16 damage, u16 barrel, u32 shot` |
| 2 | `projectile:impact` | 34 bytes: `i32 x,y,z, i16 incidenceX,incidenceY,incidenceZ, u8 surface, u8 0, u16 damage, u16 weapon, u32 sourceActor, u16 armament, u32 shot` |
| 4 | `actor:damaged` | 22 bytes: `i32 x,y,z, i16 incidenceX,incidenceY,incidenceZ, u8 surface, u8 projectileClass, u16 damage`; `projectileClass` is always 255 because `INotifyDamage` does not expose projectile identity |
| 5 | `actor:destroyed` | 19 bytes: `u32 actor, i32 x,y,z, u8 owner, u8 violence, u8 deathVoice` |
| 8 | `production:complete` | 4 bytes: `u8 player, u8 queue, u16 actorType` |
| 13 | `events:dropped` | 4 bytes: `u32 count` — records `SteelseedEventSink` refused because it was full; written first, only when non-zero |

Field notes:

- **`weapon:fire`.** `armament` is the index among the actor's `Armament` traits. The muzzle position is
  the WPos the armament fires from, and `facing` is the WAngle of the muzzle orientation. `weapon` is the
  type-table id of the armament's authored weapon name. `damage` is the weapon's summed positive
  `DamageWarhead` damage. `barrel` is the barrel index. `shot` numbers the actor's shots, which pairs a
  fire with its flight (§4.7) and its impact.
- **`projectile:impact`.** `incidence` is the normalised direction (×32767) from the impact toward the
  shot's source, and `(0, 0, -32767)` when the impact has no source position. `damage` is the summed
  positive damage, and 0 for a heal or repair; other zero-damage impacts are not published. `weapon` is
  the type-table id of the weapon's ruleset key. `sourceActor`, `armament` and `shot` read 0, `0xFFFF`
  and 0 unless the source actor is visible.
- **`actor:damaged`.** The position is the damaged actor's centre, and `incidence` points from it toward
  the attacker. It is published only for damage above 0 from an attacker that is in the world and
  occupies space.
- **`actor:destroyed`.** `owner` is a player table index (255 when none). `violence` is 255 × final
  damage / max HP. `deathVoice` is 0 none · 1 normal · 2 burned · 3 zapped, resolved from the actor's
  `DeathSounds` rules the same way OpenRA resolves them.
- **`production:complete`.** `player` is a player table index. `queue` is always 255, because
  `INotifyProduction` does not expose the producing queue. `actorType` is the type-table id of the
  produced actor type.

Kinds 3, 6, 7 and 9–12 are reserved. The decoder's `EventKind` names them (`explosion`, `unit:moving`,
`structure:built`, `resource:harvested`, `power:state`, `order:accepted`, `notify`), but the host does
not emit them.

`weather:change` (sky) and `resize` (core) are **JS-side** events on `ctx.events`. They never cross the
boundary and are not in this table.

Records come from OpenRA's `INotifyAttack`, `INotifyDamage`, `INotifyKilled`, `INotifyProduction` and
`INotifyWeaponImpact` callbacks. The host writes the `weapon:fire` records first and then the rest, each
group in callback order. That order is presentation input, **not part of the simulation sync
contract**: no simulation code consumes an event, its ordering or an observer result.
`SteelseedEventSink` implements no tick or sync interface, is bounded to 4,096 records between
snapshots (refusals are reported as kind 13), and is cleared only after the frame is encoded. The
browser republishes the events of every snapshot drained between two frames, not only the rendered one,
bounded to the newest twelve after a stall. Spatial records are published only for visible, explored
cells of the render player's authoritative shroud, and `weapon:fire` only for actors in the visible set;
production completion is exported only for the render player.

### 4.10 Section 8 — `player`

| type | field |
|---|---|
| `u32` | playerCount |
| per player, 36 bytes | `u32 cash, u32 resources, i16 powerSupplied, i16 powerDrawn, i32 clientIndex, u16 faction, i16 team, u8 relation, u8 flags, u8 red, u8 green, u8 blue, u8 alpha, u32 score, u16 queueCount, u16 0, u16 0` |
| | flags: bit0 alive · bit1 isRenderPlayer · bit2 isBot · bit3 won · bit4 lost |
| | relation to the render player: 0 self · 1 ally · 2 enemy · 3 neutral, or no render player |
| | then `queueCount` × `{u16 queueId, u16 actorType, u16 progressPermille, u16 itemsQueued}` |

Players are ordered by `ClientIndex`, and a player's id is its index in this table: `world.renderPlayer`,
actor and lifecycle `owner`, event `player` and `owner`, and `production.playerId` all index it.

- `cash` is liquid cash; `resources` is stored ore's credit value, which OpenRA spends first.
- `faction` is the type-table id of the faction's internal name. `team` is the lobby team, else the map's
  player-reference team (0 = none). The colour is OpenRA's player colour.
- `score` is always `0xFFFFFFFF`: Red Alert exposes no synchronized score, and the host does not invent
  one.
- In a queue record, `queueId` is the queue's index among the player's production queues, `actorType`
  is the current item (`0xFFFF` when idle), `progressPermille` runs 0..1000, and `itemsQueued` counts
  every queued item.

An enemy's economy is withheld for fog fairness. For a player that is neither the render player nor
its ally, cash, resources and power are 0 and no production queue is sent, here or in `production`. A
spectator, including a defeated player, receives every player's.

### 4.10a Section 9 — `production`

The dynamic production catalogue. It is separate from section 8, so a consumer that only knows player
economy and current-queue summaries can skip it without misreading the next player. The actor type
table supplies names; this section supplies the simulation-owned availability and pricing.

| type | field |
|---|---|
| `u32` | queueCount |
| per queue | `u8 playerId, u8 queueId, u8 flags, u8 kind, u16 currentActorType, u16 progressPermille, u16 itemsQueued, u16 itemCount` |
| | queue flags: bit0 enabled · bit1 current item paused · bit2 current item complete and ready |
| | kind: 0 structures · 1 infantry · 2 vehicles · 3 aircraft · 4 naval · 255 other |
| per item | `u16 actorType, u16 flags, u32 cost, u16 buildTicks, u16 queued` |
| | item flags: bit0 visible (always set) · bit1 buildable · bit2 queued · bit3 current · bit4 ready · bit5 building (the item is a structure) |

`playerId` is a player table index, and `queueId` is the queue's index among that player's queues, as in
section 8. `currentActorType == 0xffff` means idle. Red Alert's concrete queue types map onto the five
kinds (`Building` and `Defense` are structures, `Infantry` and `Soldier` infantry, `Vehicle` vehicles,
`Aircraft`, `Plane` and `Helicopter` aircraft, `Naval`, `Ship`, `Boat` and `Submarine` naval). The
catalogue is read-only presentation state: it is sampled from the production queue that owns the rules,
never reconstructed from YAML on the JS side. The UI issues ordinary §4.11 orders, and the simulation
stays authoritative.

### 4.10b Section 12 — `deployments` (additive, ABI v2)

Presentation provenance for actual MCV transforms; OpenRA creates a new actor ID. No proximity matching
and no synthetic gameplay timer. A `u32` count precedes fixed 32-byte records:

| offset | type | field |
|---|---|---|
| 0 | u32 | current yard actor ID |
| 4 | u32 | copied source MCV actor ID (different, nonzero) |
| 8/12/16 | i32 | source center X/Y/Z in WPos at the transform |
| 20 | u16 | source facing, WAngle 0–1023 |
| 22 | u16 | current authoritative make frame |
| 24 | u16 | make sequence frame count; 0 means completed/skipped |
| 26 | u16 | milliseconds per make frame; 0 only with completed/skipped |
| 28 | i32 | new actor creation world tick |

Source facts are value actor initializers, never references to a disposed MCV. The current make
sequence is sampled read-only; production and build-incomplete conditions and the reference 32-frame
timing stay authoritative. Each record is emitted only for an actor in the ordinary visible actor set.
The section is written every tick, and zero records is normal. The decoder rejects more than 4,096
records, a record whose source equals the yard or is 0, a facing of 1024 or more, and inconsistent frame
facts. Consumers must tolerate joining mid-sequence, completion, removal and reverse make frames during
undeployment, and must not treat frame 0 as an inferred new gameplay action.

### 4.10c Section 13 — `actors.status` (additive, ABI v2)

Timed states a unit visibly carries, for the actors in the same snapshot's visible set. A `u32`
count precedes fixed 12-byte records:

| offset | type | field |
|---|---|---|
| 0 | u32 | actor ID |
| 4 | u8 | kind: 1 invulnerable (the Iron Curtain, or the crate), 2 chronoshifted and due to return |
| 5 | u8 | 0 |
| 6 | u16 | remaining ticks; 0 means unknown (a permanent grant) |
| 8 | u16 | total ticks of the longest active grant |
| 10 | u16 | 0 |

Kind 1 is sent to every viewer, as OpenRA's red overlay is. Kind 2 is sent only for the render
player's allies, as OpenRA's own return bar is. The facts are the actor's `invulnerability` condition
with its `ExternalCondition` timer, and `Chronoshiftable.ReturnTicks`, read without side effects. The
section is written every tick; the decoder rejects more than 8,192 records and any other kind.

### 4.10d Section 10 — `actors.frozen`

Structures the render player remembers under fog: the records of OpenRA's `FrozenActorLayer` that are
valid, currently shown frozen, not shrouded and not hidden, ordered by ascending id. Live actors never
appear here. Fields are separate arrays in the listed order, `n = count`.

| type | field |
|---|---|
| `u32` | count |
| `u32[n]` | id — the frozen record's id |
| `i32[n]` | posX, posY, posZ — WPos |
| `u16[n]` | typeId |
| padding | align to four bytes |
| `u8[n]` | owner — player table index, 255 when none |
| `u8[n]` | health — 255 × remembered HP / max HP; 255 without `Health` |

### 4.10e Section 11 — `resources`

Live resources known to the render player, row-major from `world.boundsLeft/Top`:

| type | field |
|---|---|
| `u16` | width — the world bounds width |
| `u16` | height — the world bounds height |
| `u32` | revision |
| `u8[w*h]` | resource index: OpenRA `ResourceIndex` (Red Alert: 1 ore, 2 gems; 0 none) |
| `u8[w*h]` | density |
| `u8[w*h]` | maximum density |
| padding | align to four bytes |

`revision` changes whenever a published plane or the player perspective changes. Unexplored cells read
0; explored cells under fog keep the last observed state (§0). The decoder rejects dimensions that differ
from the world bounds and any length other than `align4(8 + 3*w*h)`.

### 4.11 Input — the other direction

JS does 3D picking and sends orders. **The sim stays authoritative.**

```ts
interface OrderIntent {                 // web/src/core/app.ts
  readonly orderString: string
  readonly subjectIds: Uint32Array      // empty: a player-level order (production, placement)
  readonly subjectCount?: number
  readonly targetActorId: number
  readonly targetCellX: number
  readonly targetCellY: number
  readonly queued: boolean
  readonly targetString: string
  readonly extraData: number
  readonly extraCellX?: number          // Order.ExtraLocation; -1 leaves it unset
  readonly extraCellY?: number
}
```

The bridge resolves ids to `Actor`s and issues real `Order`s through the `OrderManager`. JS **never**
mutates actor state, **never** fabricates an actor id and **never** predicts an order's outcome. It
draws order feedback optimistically, but the world changes only when a snapshot says so. Contextual
orders (`issueContextOrder`) send only subject ids and a target, and the host resolves them with
OpenRA's own targeters (§0).

### 4.11a The bridge ABI

The .NET JavaScript interop cannot marshal a JS-owned buffer into a `[JSMarshalAs<JSType.MemoryView>]`
parameter: an `ArrayBuffer` or `DataView` is rejected, and a `Uint32Array` throws `ExitStatus(1)` and
aborts the caller (the runtime itself survives). The bridge is shaped around that constraint.

```ts
interface BridgeApi {                   // full declaration: web/src/core/app.ts
  /** A persistent pinned-slot alias, or EXACT null when this sim/presentation state was already polled. */
  pollSnapshot(): Uint8Array | null
  issueOrder(order: OrderIntent): Promise<string>
  snapshotTypeTable?(): string | Promise<string>
  getSkirmishCatalog?(): Promise<SkirmishCatalog>
  startSkirmish?(config: StartSkirmishConfig): Promise<SessionStatus>
}
```

1. **Zero-copy snapshots.** C# pins two byte buffers and the host aliases them directly in the WASM
   heap. No `slice()`, no per-tick copy. With the worker host, the proxy transfers a trimmed copy of
   the payload to the page (§6).
2. **A generation counter is required.** A pinned pointer over a resizable buffer is a use-after-move,
   and a stale JS alias reads *plausible garbage* rather than failing. The host reads the generation
   before and after acquiring metadata and retries on a change (a seqlock). It rebuilds its aliases
   when the generation moves or `WebAssembly.Memory` grows under it, and **throws if a pointer or
   capacity changed without a generation bump.** C# pins the replacement pair before releasing the old
   handles.
3. **Exact `null` from the poll.** Not an empty view: an empty `ArraySegment` is truthy, and a drain
   loop over it never ends.
4. **A one-time order scratch buffer on the C# side**, so orders cross the boundary without a JS-owned
   buffer ever being marshalled.
5. **`globalThis.steelseedBridgeReady`, a Promise published synchronously before the host's first
   `await`.** `getBridge()` is async. Module order cannot make readiness synchronous, because the
   consumer runs while `dotnet.create` is still pending. A rejected host boot stays a boot failure and
   never falls back to the dev bridge.

**The drain loop has no iteration cap.** A cap turns a hang into silent truncation: the tab stays alive
while the sim falls behind, and nothing reports it. Exact `null` ends the loop.

Pause and game-over are presentation state that can change while `WorldTick` is held. Snapshot
deduplication therefore keys both the tick and the paused, game-over and replay header flags;
otherwise the UI could issue a real pause order and never observe its result. Match creation is the one
exception to the order-only rule, because no `World` exists yet. The adapter exposes the host's real
catalog and start calls; after creation all gameplay returns to ordinary OpenRA orders.

`web/tools/bridgegate.mjs` witnesses the contract: a JS-originated order must move the commanded actor
while an un-ordered control actor does not move. **Both halves are the assertion.** A harness that only
checks the commanded actor cannot tell an order from a coincidence.

### 4.11b Snapshot allocation sequence

`allocprobe.mjs` pins the exact managed allocation of snapshot emission, tick by tick, on one named
workload: NullPlatform `amber-crossing`, seed 104729, one normal bot, exactly 8 spatial actors, 16
warm-up emissions, then 64 samples at ticks 16..79. The floor is 248 bytes, which belongs to the frozen
`World.SyncHash` enumerable surfaces. Player, production, movement and event observation add
deterministic transients at nine ticks:

```
18=664, 24=376, 25=320, 29=392, 35=592, 50=304, 66=304, 75=360, 76=360
```

The sequence is exact, not an upward-only budget. Movement in either direction is red and requires an
explicit re-measurement; averaging the transients away would turn an exact contract into a budget.
`--falsify=above` injects an allocation inside the measured boundary and `--falsify=below` raises the
first expected sample by one; both must go red.

### 4.12 Changing this contract

Adding a field is a bridge change **and** an edit to the table above **in the same commit**. Bump
`version` on any layout change that is not a purely additive new section or new event kind. JS asserts
`magic` and `version` on every snapshot and fails loudly on mismatch: a silently misread binary layout
is the worst class of bug available to this project. `snapshotabigate` round-trips the live C# emitter
through the TypeScript decoder and an independent layout parser, and checks that a presentation build
rejects a producer of another version.

---

## 5. Determinism

1. **No `Math.random()`.** Anywhere. `ctx.rng` is SplitMix64; keep a `ctx.rng.fork()` for a stream you
   own. `rulecheck` rejects `Math.random()`, `crypto.getRandomValues` and wall-clock reads inside
   generators.
2. **Asset generation is a pure function of the asset seed.** Two runs of the same seed produce
   byte-identical geometry and textures. This is what makes `baseline.mjs` a usable gate.
3. **Never read or perturb `World.SharedRandom`.** That belongs to the lockstep. Touching it desyncs
   multiplayer, and the failure appears minutes later in someone else's match.
4. **Same order script + same asset seed ⇒ same match, same frame, same sync-hash sequence.**
5. **Generated and baked output is versioned.** `GENERATOR_VERSION` (`core/config.ts`) and the forge
   manifests record the version, the seed or source hashes, and SHA-256; Vite emits content-hashed
   deployable URLs. The boot LOD cache (`core/lod-cache.ts`) stores only decimated LOD levels in
   IndexedDB, keyed by a digest over every input: forge manifest hashes, the roster slot list, a
   geometry digest and a format version. A hit goes through the same `uploadLods` validation as a fresh
   build, and a mismatch rebuilds that slot. Any other browser-side cache keys on its complete inputs
   the same way.

---

## 6. Threading

`WasmEnableThreads=false`, and **it stays false**: the sim is single-threaded and must remain so.

The mono-wasm host boots in a dedicated Web Worker
(`engine/steelseed-host/OpenRA.Browser/wwwroot/sim-worker.js`, a timer-driven `Frame` pump). There is
exactly one simulation thread: the worker takes the page's rAF role as the pump owner and does not
parallelize the sim. There is no `SharedArrayBuffer`, because the browser build must run on any host
without COOP/COEP. Snapshots cross as trimmed, transferred `ArrayBuffer` copies. RPC methods cost one
`postMessage` round trip. Hot polled values (host status, probes, net frame) are served synchronously
from a 4 Hz status cache. `main.js` is the dual-mode boot: `?worker=0`, or a runtime without `Worker`
(the Node fixtures), keeps the page-hosted path that synchronous capture gates and export interception
need. The §4 ABI, the OpenRA order boundary and the single build lane are the same on both paths.

Procedural generation belongs entirely to the `web/` side and never reads simulation RNG. Procedural
archetype generation (the fallback path) runs during presentation boot, never during play. Baked forge
output (§14.11) removes the heaviest generation from the browser. Web Workers with transferable
buffers are the scaling path for expensive boot-time generation that stays in the browser. The WASM
simulation thread never waits on generation during a match. §12.5 records the one exception, GPU
texture generation in `materials`.

---

## 7. Quality presets and budgets

`config.q` selects one. **Never exceed a budget; degrade gracefully.** Budgets are measured by
`profile.mjs`, not asserted in prose. `core/config.ts` mirrors this table.

| budget | low | medium | high | turbo | classic, ultra, ultra-max |
|---|---|---|---|---|---|
| draw calls | 800 | 1 500 | 2 500 | 2 200 | 3 200 |
| triangles | 2.5 M | 6 M | 12 M | 10 M | 16 M |
| dynamic lights | 32 | 128 | 256 | 192 | 256 |
| shadow cascades | 2 | 3 | 4 | 3 | 4 |
| local shadow casters | 0 | 8 | 16 | 12 | 24 |
| probe updates / frame | 16 | 64 | 128 | 64 | 192 |
| live particles | 20 k | 80 k | 200 k | 160 k | 300 k |
| decals | 512 | 2 048 | 4 096 | 3 072 | 6 144 |
| texture VRAM | 256 MB | 640 MB | 1 024 MB | 1 024 MB | 1 536 MB |
| internal resolution scale | 0.70 | 0.85 | 1.00 | 0.90 | 1.00 |
| audio voices | 48 | 96 | 128 | 96 | 128 |

| preset | look | in play |
|---|---|---|
| `low`, `medium` | reduced budgets; `low` drops rain and snow particles | locked |
| `high` | full budgets | holds 60 fps: the governor sheds and restores (§7.1) |
| `turbo` | the classic look with cut submit and shading budgets | the governor only lowers the internal scale (floor 0.55) and restores it |
| `classic` | Ultra budgets with the classic look: no cloud shadows, leaf transmission, post-AgX grade or near-field living scatter | locked |
| `ultra` | Ultra budgets, screen-space reflections and rain and snow particles; near-field living grass and wind grass off | locked |
| `ultra-max` | `ultra` plus near-field living grass and wind grass | locked; frame time is whatever the GPU delivers |

The lobby Graphics switch also offers **Detect** and **Dynamic**. Both score the hardware and pick
`low`, `medium` or `high`. Detect then stays locked; Dynamic applies the `high` governor to the picked
tier. With no stored or URL choice, the game boots `classic` where the hardware scores high and
Dynamic elsewhere. Detect never selects `turbo`, `classic`, `ultra` or `ultra-max`. The URL flags
`?quality=`, `?contact=` and `?reflections=` override for review captures. The HUD shows the active
tier, the measured p50 and the governor state.

**Pipeline permutations are constant during play.** Every pipeline, bind-group layout and material
variant is created before frame 1 with the correct target formats bound. Target: **0 pipeline creations
during play**, measured per frame by `profile.mjs`.

### 7.1 The visual target, and the millisecond budget that pays for it

**Objective: the best graphics achievable in a browser while holding a steady frame rate.** Both halves
bind. Better graphics never license a frame-time regression, and frame rate never licenses a flat,
ungrounded image. When they conflict, the degradation order below decides.

Budgets are stated in **milliseconds**, because fps is a rate and a budget is a duration. The reference
workload is §11.4: 200 clustered units, DPR 2, `high`, `internalScale` 1.0, moving camera, never a
static camera. The frame budget there is **16.7 ms p50 (60 fps), worst frame ≤ 50 ms**. Below this the
build does not ship (§10).

**Pricing rule, mandatory for every visual feature.** A feature is not done when it looks right. It is
done when its **measured** p50 and p99 ms cost at the reference workload is recorded against a named §7
budget line. A feature with no measured cost has not landed. §12.6 applies with full force:
encode-time counters prove nothing about presentation, so the number comes from `profile.mjs`
GPU-complete timing or it does not exist.

**Degradation order, pinned.** Only `high`, Dynamic and `turbo` change cost in play; every other preset
is locked. While sampled frames stay over budget, the governor (`core/frame-governor.ts`) sheds one
step at a time, in this order:

1. internal resolution scale, in ×0.85 steps down to the preset floor (`turbo` stops here);
2. contact shading;
3. shadow cascades, down to one;
4. wind grass;
5. rain and snow particles;
6. near-field living grass, shrubs and props;
7. scenery density.

It restores in reverse after sustained display-paced frames with real headroom. The governor never
touches the AgX tonemap, the probe volume, materials or screen-space reflections.

**Never degraded, at any preset:** the AgX tonemap, the irradiance probe volume and the §9.0 material
response. Those three *are* what the game looks like. A preset that changes the **look** rather than the
**fidelity** is a bug, not a knob.

**Adaptive quality stays off in deterministic mode** (`core/config.ts`). A frame-rate-dependent quality
ladder is not reproducible, and §10's reproducibility gate would end up measuring the ladder instead of
the renderer.

---

## 8. Surface types

Shared enum, tagged on terrain cells and hit results, consumed by `fx`, `audio` and `terrain`.

```ts
export const Surface = {
  soil: 0, rock: 1, sand: 2, gravel: 3, grass: 4, road: 5, metal: 6,
  concrete: 7, water: 8, shallow: 9, snow: 10, ash: 11, resource: 12,
} as const
```

Every consumer must handle all 13. A `default:` branch that silently does nothing is a gate failure:
missing dust on `gravel` is exactly the kind of thing that ships.

---

## 9. Factions — the design language

This design language governs the procedural generators (the fallback path, §0) and the `foundry`,
`lattice` and `drift` material sets. `rulecheck` rejects the words neon, cyberpunk, hologram,
antigravity, sci-fi and futuristic anywhere in `web/src`.

### 9.0 Art direction — near-future clean industrial

**The machines look like military hardware fifteen to thirty years from now:** recognisably descended
from machines that exist today, not invented from nothing. Composite over alloy. Large clean panels,
fine recessed seams, machined bevels, chamfered plate edges. It is a war fought with machines a person
could walk up to and touch, newer, better made and better maintained than today's.

**Hard prohibitions:**

- **No cyberpunk palette.** No cyan/magenta accent language, no holograms, no floating UI in world
  space.
- **No energy weapons, no shields, no hover, no walkers, no antigravity.** Wheels, tracks, rotors,
  propellers and legs that are actually legs only.
- **No decorative emissive.** The emissive rule below is a permit list, and the distinction it draws is
  *function*, not brightness.

**The wear band.** Wear has a floor and a ceiling: nothing is factory-fresh, and nothing is derelict.

| | permitted | prohibited |
|---|---|---|
| **floor** — nothing is factory-fresh | edge rub on handholds and hatch lips, dust settled in recesses, exhaust staining, heat discolour at manifolds, boot-polish on step plates, faint fading on canvas and paint | a surface with *no* wear at all. A machine with no history reads as a render. |
| **ceiling** — nothing is derelict | localised scuffing, thin dust film, thermal bluing | **rust bleeding from seams and rivets**, mud caking, corrosion pitting, chipped-to-primer enamel, zinc bloom. These belong to `drift` (wrecks and derelicts) and to damage states — **not** to a serviceable unit. |

The distinction is *maintenance*. A fielded machine is cleaned, repainted and serviced; a wreck is not.
Making that difference visible is what lets a player read a battlefield.

**The ceiling binds actor surfaces only.** Units and structures are maintained; terrain and environment
are not. Rust on a §8 ground surface (industrial plating, a gantry, a weathered concrete apron) is
scenery, and scenery may decay. `shadeMetal` blooms oxide out of its seams and `shadeConcrete` chalks
and weathers, and both are correct because they are ground, not machines. The actor-facing sets are
`foundry`, `lattice` and `drift`; every other set in `SET_DEFS` is terrain and is governed by §8, not
by this ceiling.

**`drift` is the exception in the other direction.** It is derelicts and salvage, so decay, bleaching,
corrosion and mismatched materials are *required* there. It is what a maintained machine is read
against.

**Functional emissive is a permit list.** Emissive exists only where a **real emitter** exists:

| permitted emitter | permitted emitter |
|---|---|
| headlamps, work lamps, spotlights | sensor and radar array faces |
| amber hazard beacons, navigation and running lights | status strips and charge-state indicators |
| muzzle flash, tracer, welding arcs | operator displays and console glow |
| hot exhaust manifolds, thermal vents, fire, embers | illuminated instrument panels |

**Still prohibited:** glowing panel *lines*, seam glow, decorative trim, energy-field shimmer, and any
emissive whose purpose is to look futuristic rather than to indicate, illuminate or radiate. **If you
cannot name the bulb, the display or the hot thing, it does not glow.** A status strip that reports a
real state is permitted; the same strip added for styling is not, and the difference is legible in the
code that drives it. `SurfaceSet` carries the emitter class (§12.1), which is what the emissive-keyed
bloom reads.

### 9.1 The two factions

Distinguishable **by silhouette alone, in monochrome, at max zoom-out**. That constraint drives geometry,
never paint. Player colour is a **material mask channel**: a real repaint of specific panels and
markings, never a hue shift over the whole unit.

The contrast is **solid cast mass vs open bolted framework**. Both are ordinary industrial engineering,
and both read instantly in silhouette without a single glowing line. **That silhouette contrast is the
load-bearing part of this section.** It is what makes the monochrome test passable, and no amount of
surface treatment can substitute for it.

| | **The Foundry** | **The Lattice** |
|---|---|---|
| premise | heavy cast and pressed armour, overbuilt and mass-produced | prefabricated modular frames, shipped flat and bolted together on site |
| surface | seamless cast housings, deep-drawn plate, smooth-welded joins, matte service paint | bolted truss members, gusset plates, ribbed panel, anodised alloy |
| joins | overlapping, flush-bolted, smooth-filleted | exposed frames and open structure, visible fasteners |
| locomotion | tracked, planted, low | wheeled 6x6 / 8x8, tall ground clearance |
| light sources | work lamps, thermal vents, hot exhaust, foundry glow | headlamps, amber hazard beacons on tall masts, sensor array faces |
| palette | warm graphite, gun-metal, deep ochre accents, oiled steel | cool grey, pale alloy, sand, olive accent panels |
| emissive temperature | **warm** — amber/orange indicators, hot metal | **cool** — white/pale-blue indicators, sensor faces |
| silhouette | boxy, wide, low, hunched, solid | tall, narrow, skeletal, open frames and lattice masts |
| audio | diesel rattle, track clank, gruff band-passed radio voice | turbo-diesel whine, air brakes, chain rattle, clipped radio-procedure voice |
| wear (within the §9.0 band) | edge rub on hatches, heat bluing at manifolds, dust in recesses | scuffing on frame members, dust film, thin fading on panel decals |

**Emissive temperature is the second faction cue, and it is deliberately the only place colour carries
identity.** Factions must separate in *monochrome*, so hue may reinforce identity but may never
establish it. Warm-vs-cool indicator light is legible in colour, vanishes in monochrome, and the
silhouette carries the load either way. It cannot be confused with the banned cyberpunk accent
language, because named indicators emit it rather than paint carrying it.

Neither faction is far-future. The Foundry is a heavy-industry combine that builds armour the way it
builds presses; the Lattice is a combat engineering corps whose army ships flat and bolts together.
`drift` carries the weathering vocabulary: rust, corrosion, mud, sun-bleached canvas and chipped enamel
mark derelicts and wrecks, which is what makes a fielded machine read as maintained by contrast.

**Drift**: neutral civilian and derelict structures, salvage props, wrecks, mismatched materials. It
fills the map and gives the lighting something to bounce off.

### 9.2 What is fixed and what is seeded

Assets are a **pure function of the asset seed** (§5), and the default seed is a constant
(`'steelseed-default'`). **Nothing changes between restarts.** A Foundry tank is byte-identical on every
launch and on every machine. That is what makes the game learnable and what makes `imagediff.mjs` a
usable gate at all.

Randomness is therefore about *variety within a match*, never about *a different game each launch*:

| level | seeded? | why |
|---|---|---|
| faction identity — silhouette language, palette, material set, join style | **NEVER** | this is the thing the player learns to read at a glance. It is authored, pinned in §9.1, and no generator may vary it. |
| actor type — what a Foundry medium tank is | **NEVER** | two players must see the same unit and mean the same thing. |
| per-instance detail — this particular building's greebles, this wreck's twist, wear placement | seeded from `(assetSeed, instance id)` | so two of the same structure on screen differ without either becoming unrecognisable. |
| the map | only for generator presets (§1.5) | catalog maps are fixed files; a generated map is rebuilt from preset and seed and never stored. |

**The rule for generators: vary the wear, never the shape language.** A player must be able to name the
faction from a five-frame flash at max zoom-out, and that is impossible if a generator is free to
reroll proportions or palette per launch.

---

## 10. Gates

A change is done when its gates pass. Cross-cutting gates:

| gate | command | bar |
|---|---|---|
| rules | `npm --prefix web run lint:rules` | zero findings; needs no browser, GPU or engine build |
| sim integrity | `node web/tools/synccheck.mjs` (runs `simparitygate.mjs`) | an unstripped pinned reference build and two assetless runs produce identical fixed-order sync hashes |
| boot | build the host and the web bundle (README), then `node web/tools/capture.mjs` | produces a frame; an all-black or single-colour frame fails |
| reproducibility | `node web/tools/baseline.mjs` | two isolated runs, exact RGBA for every named shot |
| no-visual-change (optimization gate only) | `node web/tools/imagediff.mjs` | zero |
| performance | `node web/tools/profile.mjs --actors=200 --cluster=17` | the §11.4 reference workload: p50 ≥ 60 fps, worst ≤ 50 ms, 0 pipeline compiles |
| visual-feature cost | `node web/tools/profile.mjs` | every feature's measured p50/p99 ms cost recorded against a §7 budget line (§7.1 pricing rule) |

A static-camera median is **banned** as a performance metric.

**Scope of the sim-integrity gate.** Both arms are headless and neither has a renderer. The gate proves
that the assetless transformation and the snapshot emitter do not perturb the simulation. A renderer
reaches the simulation only through orders (§4.11); input timing and frame pacing are not exercised by
this gate.

---

## 11. Measured baseline

Performance numbers are measured, never asserted, and every figure is quoted with its hardware,
resolution, preset and workload. This section defines the build configuration and the reference
workload that measurements use.

### 11.1 Bundle and build configuration

`PublishTrimmed` is `true`, and `RunAOTCompilation` defaults to `true` for release
(`engine/steelseed-host/OpenRA.Browser/OpenRA.Browser.csproj`). `RunAOTCompilation` is declared with
`Condition="'$(RunAOTCompilation)' == ''"` so the development loop can override it: an AOT publish takes
minutes against seconds for a trimmed-only build.

```bash
dotnet build engine/steelseed-host/OpenRA.Browser/OpenRA.Browser.csproj -c Release -p:RunAOTCompilation=false   # dev
dotnet publish engine/steelseed-host/OpenRA.Browser/OpenRA.Browser.csproj -c Release                            # ship
```

AOT costs bundle size, because the compiled code goes into the native module, and buys boot time and
simulation throughput. A non-AOT bundle is never measured for frame rate.

**`InvariantGlobalization` must stay `false`.** OpenRA's localisation system, Fluent, builds a real
`CultureInfo` for every mod from the hardcoded `FluentCulture = "en"` in `OpenRA.Game/Manifest.cs`. In
invariant mode that throws `CultureNotFoundException` at boot, before the first frame, and
`Manifest.cs` is inherited source that is never edited.

### 11.2 Simulation tick

The simulation ticks at 25 Hz (40 ms per tick) in its worker. `moveperfgate.mjs` is the load gate: with
the heavy roster driving, the worker keeps at least 20 ticks per second and no main-thread stall exceeds
500 ms (§0).

### 11.3 Large engagements

Simulation tick cost at large actor counts (around 800) is quoted only from a measurement at that
count. A figure from a small scripted match is not a large-engagement figure, and the CPU-side tick is
never confused with the GPU frame of §11.4.

### 11.4 GPU frame at the reference workload

`profile.mjs` measures GPU-complete frame time on a fixed workload: 1512×982 CSS pixels at DPR 2,
`high`, 30 warm-up frames plus 240 measured frames, camera moving throughout. `--actors`, `--cluster`,
`--size`, `--quality`, `--tod` and `--roster` parameterize it. The §7.1 reference is
`--actors=200 --cluster=17`: 200 units drawn from a disc around the map centre.

- When comparing actor counts, grow the cluster radius with √n so density stays constant. A fixed
  radius would conflate instance count with overdraw.
- Scattering actors over the whole map lets the frustum cull most of them, which measures the culler,
  not the renderer.
- Dynamic lights need a night arm (`--tod`), because headlamps are gated on sky light level.
- `stats.triangles` and `stats.drawCalls` accumulate in every pass: once per shadow cascade, once in
  the depth prepass and once in the forward pass (§12.5). Divided by actor count they give billed
  triangles per actor, not mesh triangles (§12.6).
- To locate a cost, decompose by actor count. If many times the actors adds almost nothing, the cost
  is fixed and not about the roster.
- A single hitch in one arm is reported, never averaged away.

---

## 12. Tier-1 interfaces

`materials`, `render` and `terrain` form the tier-1 chain every visual node builds on. Every symbol
below is contract; nothing here may be guessed at.

Cross-node access stays runtime-only (`ctx.get('render')`). These are the shapes those calls return.
The TypeScript declarations (`web/src/materials/api.ts`, `web/src/render/types.ts`,
`web/src/terrain/types.ts`) are authoritative and carry further optional members; the excerpts below
show the contract members.

### 12.1 `materials` — `web/src/materials/`

**Emitter class.** Functional emissive (§9.0) travels as a constant emitter class in the `foundry` and
`lattice` material alpha, the one otherwise unused scalar in the four-texture pack, with placement from
a unit-mesh-only analytic coordinate. It needs no extra texture, no extra VRAM and no ABI change.

**Units only.** Structures share these material sets, and a 2–4 m plan repeats the material tile, so a
band that lands once on a 1.1–1.7 m hull would repeat across a building and become the panel-line glow
§9.0 bans by name. Structures keep the zero mesh marker until a real per-actor emissive channel exists
and is paid for in the §7 VRAM arithmetic. The bloom pass adds no authoring surface and does not lift
this boundary.

**Bloom.** A quarter-resolution, single-pass, 13-tap radial bloom, keyed on the emitter alpha rather
than on a luminance threshold. A threshold would bloom sunlit snow and white hulls, which is the
decorative glow §9.0 bans; an emitter key can only bloom something authored to emit. The sign of the
key carries faction (positive Foundry warm, negative Lattice cool), so one channel carries both
magnitude and tint. The key is fogged by the same aerial term as the colour, so a distant emitter
blooms less, and TAA carries it with a neighbourhood clamp on the key itself so it cannot ghost. Zero
intensity is structural, not a multiply by zero: at `BLOOM_INTENSITY = 0` no layout, pipeline, texture,
bind group or pass is created and the WGSL is not generated.

**Budgets** (`emissivegate`, `bloomgate`): emissive area ≤ 3% of eligible unit body, with a 1–2%
target; HDR emissive-to-lit-hull luminance 3–6×; halo extension ≤ 15 px; p99 cost ≤ 0.5 ms at the
reference workload. §7.1 is satisfied by measured figures, not by the feature existing.

```ts
export interface SurfaceSet {
  readonly id: string
  /**
   * SAMPLE THROUGH THIS. `rgba8unorm-srgb` view over an sRGB-encoded `rgba8unorm` texture,
   * so the hardware performs the transfer decode on read. See §12.5.
   */
  readonly albedoView: GPUTextureView
  /** Raw texture — sRGB-ENCODED, not for direct sampling. Copies and VRAM accounting only. */
  readonly albedo: GPUTexture
  /** rg8unorm octahedral-encoded normals. Two channels, not three — bandwidth. */
  readonly normal: GPUTexture
  /** r=roughness g=metalness b=ao a=height, packed into one rgba8unorm. */
  readonly orm: GPUTexture
  /** r8unorm player-colour mask. A REAL repaint of panels, never a hue shift (§9). */
  readonly mask: GPUTexture
  readonly layerCount: number
  /** Bytes of VRAM this set occupies. Must be measured, not estimated (§7). */
  readonly vramBytes: number
}

export interface MaterialsApi {
  /** Built at boot from (assetSeed, id). Never during play. */
  get(id: string): SurfaceSet
  has(id: string): boolean
  /** Bind group layout every material-sampling pipeline must use. */
  readonly bindGroupLayout: GPUBindGroupLayout
  bindGroupFor(set: SurfaceSet): GPUBindGroup
  readonly totalVramBytes: number
}
```

Static id is `'materials'`. Required surface set ids: one per §8 surface type, plus `'foundry'`,
`'lattice'`, `'drift'`.

**What `layer` means, and what `materialZone` is NOT.** `layerCount` is a count of **variants**:
independently generated variations of the *same* material, so two instances of one structure are not
identical (`LAYERS_PER_SET = 4`). §3.1's per-vertex `materialZone` selects among those variants and
nothing else.

`materialZone` is **not** a material-region id. A mesh that needs genuinely different materials (steel
hull, rubber track, glass, canvas) expresses that as **separate `DrawItem`s with separate `surfaceSet`
ids**, because a `DrawItem` carries exactly one `surfaceSet`. Zones cannot express it, and trying fails
silently: `materialZone` is a `uint8` with a 0..255 range that no generator bounds, while `layerCount` is
4, so every zone ≥ 4 clamps onto the last variant and a mesh authored with 8 "materials" renders 5 of
them identically.

Selection is `layer = min(zone, layerCount - 1)`: **clamp, never wrap** (§12.5), in *both* the render
shader and the `materials` canonical `ssSample`. Clamping is deliberate: an out-of-range zone then looks
like repetition, which points at the generator, instead of aliasing an unrelated valid material, which
looks like a texturing bug.

Player colour does **not** travel through zones either. It is the `mask` channel (§9), a real repaint of
specific panels.

### 12.2 `render` — `web/src/render/`

```ts
export interface Camera {
  readonly view: Mat4
  readonly proj: Mat4          // reverse-Z, infinite far (see core/math m4.perspectiveReverseZ)
  readonly viewProj: Mat4
  readonly position: Vec3
  readonly nearPlane: number
}

export interface DrawItem {
  readonly mesh: GpuMesh
  readonly surfaceSet: string      // key into MaterialsApi.get
  /** Opt-in albedo-alpha coverage in forward, prepass/reflections and shadows. */
  readonly alphaCutout?: boolean
  /** Instance transforms, column-major, 16 floats each. */
  readonly instances: Float32Array
  readonly instanceCount: number
  /** Per-instance player colour index, or null for unowned geometry. */
  readonly playerColors: Uint8Array | null
  /**
   * Bone-palette base per SOURCE instance. Renderer compaction copies the matching value
   * into instance float 21; null or omitted means every instance is unskinned.
   */
  readonly paletteBases?: Uint16Array | null
  readonly castsShadow: boolean
}

export interface GpuMesh {
  readonly vertexBuffer: GPUBuffer
  readonly indexBuffer: GPUBuffer
  readonly indexCount: number
  readonly aabbMin: Vec3
  readonly aabbMax: Vec3
}

export interface RenderApi {
  /** Upload a geo Mesh once, at boot. Returns a handle for DrawItem. */
  upload(mesh: import('../geo/mesh').Mesh, label: string): GpuMesh
  /** Submit for this frame. Cleared every frame; callers re-submit in update(). */
  submit(item: DrawItem): void
  /** Reserve consecutive matrices in this frame's shared bone palette. */
  reserveBones(count: number): { base: number; matrices: Float32Array } | null
  /** Add a dynamic light this frame. Respects the §7 budget; excess is dropped by priority. */
  addLight(x: number, y: number, z: number, r: number, g: number, b: number, intensity: number, radius: number): void
  /** Directed light in the same pool, with smooth inner/outer cosine falloff; no private shadow map. */
  addSpotLight(x: number, y: number, z: number, dx: number, dy: number, dz: number,
    r: number, g: number, b: number, intensity: number, radius: number, innerCos: number, outerCos: number): void
  readonly camera: Camera
  setCamera(view: Mat4, proj: Mat4, position: Vec3): void
  /** Colour target format, so other nodes create compatible pipelines at boot (§7: none during play). */
  readonly colorFormat: GPUTextureFormat
  readonly depthFormat: GPUTextureFormat
  /**
   * Per-frame counters for profile.mjs. Measured, never asserted.
   *
   * `dropped` / `lightsDropped` are contract, not debug extras. A `surfaceSet` id that
   * `materials` does not carry must not give a silently black scene: `submit()` warns ONCE
   * per unknown id and counts the drop here. These counters record what was REJECTED AT
   * SUBMIT; like `drawCalls` they say nothing about whether the frame was presented (§12.6).
   */
  readonly stats: {
    drawCalls: number
    triangles: number
    lights: number
    pipelineCreations: number
    dropped: number
    lightsDropped: number
  }
}
```

Static id is `'render'`, `deps = ['materials']`. Depth prepass → froxel light cull → forward+ → post.
Reverse-Z throughout: depth compare is `greater`, depth clear is `0.0`. Any separately compiled passes
that must reproduce the same clip-space depth must declare `@invariant` on `@builtin(position)` in
**both** modules; a one-sided declaration establishes no agreement.

**The instance record.** The GPU instance record is 24 floats: 0–15 model matrix, 16–19 player-colour
tint, 20 material layer count, and 21–23 as below. Each slot has one owner, because two features writing
one slot would show up as one of them silently corrupting the other's geometry, and since records are
packed per frame the corruption would follow whichever actor occupied the slot.

| float | owner | meaning |
|---|---|---|
| 21 | `render` | `paletteOffset` — base index into the bone palette. **0 means unskinned** and takes the identity path, so the default costs nothing. |
| 22 | `anim` | `phase` — a periodic scalar for motion that is not articulation. Track scroll as a UV phase, rotor blur. **A scrolling track is not a bone** and must not consume one. |
| 23 | `units` | `damage01` — derived from the `health` byte §4.5 decodes. Fragment-stage blend only, no geometry. |

All three are written by `writeInstance` and by nothing else. A write from anywhere else is a bug. A
negative float 23 packs a damage band and an opacity (§0, death presentation).

### 12.3 `terrain` — `web/src/terrain/`

Static id is `'terrain'`, `deps = ['render', 'materials']`.

Consumes `snapshot.terrainStatic` (§4.3) and **must match the sim's cell grid exactly**. The gate is an
overlay proof against that section, so terrain never invents its own passability or extent.

```ts
export interface TerrainApi {
  /** World-space height at a cell, for anim foot IK and vehicle suspension. */
  heightAt(worldX: number, worldY: number): number
  /** Surface type (§8) at a world position, for fx and audio. */
  surfaceAt(worldX: number, worldY: number): number
  readonly cellsWide: number
  readonly cellsHigh: number
}
```

The second argument of both methods is render **Z** (§12.5).

### 12.3b `TerrainAtlas` — blended surface boundaries

**The problem.** `terrain` submits ground per chunk, and §12.2 pins one `surfaceSet` per `DrawItem`.
Without an atlas, a triangle belongs wholly to one surface and the shader has nothing to blend toward,
so boundaries land exactly on cell edges: stair-stepped, and flickering under TAA jitter.

**The design.**

1. **A distinct `TerrainAtlas`, not a reinterpreted `SurfaceSet`.** Physical layer index is
   `surface * variantsPerSurface + variant`. `SurfaceSet.layerCount` keeps its variants-only meaning;
   overloading it would make `planForge`'s "degrade resolution first, variants second" semantics false.
2. **Layer indices are cell-constant. Only the weights interpolate.** **WGSL integer varyings are
   flat.** If two vertices of a triangle carry different layer indices, the fragment stage receives the
   provoking vertex's values rather than anything blendable, and the shader silently blends the wrong
   materials, worst exactly at boundaries. So a cell carries a fixed layer palette and per-corner
   weights. Continuity across a shared edge holds by construction: two cells sharing a boundary with the
   same pair emit `mix(a,b,w)` and `mix(b,a,1-w)`, which are identical.
3. **Three layers, zero vertex growth.** The terrain vertex keeps its 60-byte stride (position 0, normal
   12, tangent 24, uv0 40, uv1 48, materialZone 56). For terrain only, `materialZone.xyz` holds three
   layer indices and `.w` the face kind. The two weights live in `uv1`, because weights must
   interpolate and an integer varying cannot; the third derives as `1 - w1 - w2`. The shader recovers
   slope from the normal as `1 - n.y`. Slot 1 is the secondary surface and slot 2 is a dedicated
   own-surface-variant slot, so a surface transition and a variant transition can both be expressed
   where they meet. The slots are independent, not ranked.
4. **Variants are retained.** The atlas is VRAM-neutral against the standalone sets. Folding terrain to
   one variant would save memory, but it is an optional quality degradation, and the forge sacrifices
   resolution first.
5. **One ground draw per chunk** replaces one per (chunk, surface): roughly a 6× draw-call reduction at
   4 cascades (§12.5's `2 + cascades` billing). Water stays a separate part, because it overlaps the bed
   and needs different depth and transparency behaviour.
6. **The blend lives in `render`.** `render` never calls `terrain.encode()`; every terrain triangle
   reaches the screen through render's forward shader via `submit()`. The atlas path is a forward
   pipeline variant in `render`, selected by `DrawItem.blendZones`, with an atlas bind group built
   against the §12.1 per-set layout so it drops into the existing pipeline layout unchanged. Terrain's
   own `encode()` pipelines are not a draw channel (§12.5).
7. **Two pipeline variants, not one data-driven shader.** Branching on the interpolated weight would put
   `textureSample` in non-uniform control flow, which WGSL forbids. Sampling every layer unconditionally
   would charge every unit in the game for a feature only the ground uses.
8. **Height blending needs a gain.** `ORM.a` is scaled by the set's `heightScale`, a real distance in
   metres, as little as 0.035 peak to peak. A blend depth of 0.2 against that is 4× the entire dynamic
   range, which silently degrades height blending into the linear crossfade it exists to replace. The
   blend uses gain 6, depth 0.16.
9. **Normals are decoded before blending.** Averaging the encoded octahedral pairs and decoding the
   average is wrong: the encoding is piecewise linear with a fold, so a pair straddling it decodes to a
   direction unrelated to either input.

**Cliff tips.** `emitWall` emits a wall whenever either end of a cell edge steps, so one end can sit at
zero height while the other stands up to a metre. That collapsed end is sub-pixel wide and nearly black,
because a vertical face gets no sun at this elevation, and TAA jitter would swing it against the lit
ground beside it. Each end's vertex normal therefore tapers toward up as its height collapses, and
normal-map detail fades at cliff tips, so an unattenuated normal map cannot rotate the shading normal
back below the sun. **No geometry is removed, so no crack can open by construction.** Skipping short
walls by a height threshold is wrong: it opens see-through holes, and gap size is not a valid proxy for
visibility.

**Known limit.** Three slots cannot express four surfaces, so a 4-surface corner shows an axis-aligned
discarded-material wedge. Such corners are rare, and most corners with three or more surfaces involve
`resource`. Widening the payload to a fixed four-layer palette is the remedy if they matter; the atlas
and forge work carry over unchanged.

**Gate.** Histogram the distinct surface candidates per corner across the maps. Capture the worst 3-way
junction at three zoom levels under TAA. Require no visible discarded-third wedge, no static-camera
flicker and bit-identical output across isolated runs.

### 12.4 Coordinate convention — one source of truth

The sim is `WPos` in WDist (1024 per cell), X east, Y **south**, Z up. The renderer is right-handed,
**Y up**, metres. One conversion, defined once, used everywhere:

```
worldX =  wpos.x / 1024
worldY =  wpos.z / 1024      // sim Z (height) becomes render Y (up)
worldZ =  wpos.y / 1024      // sim Y (south) becomes render Z
```

One cell is one metre. A unit is roughly 1–3 m and a war factory roughly 6–8 m, so scale is expressible
in real units. **Any node doing its own axis swap is a bug**: this mapping is the only one.

### 12.5 Interface semantics

A name without its meaning is only half a contract. These semantics are pinned alongside §12.1–§12.4.

**Terrain grid origin.** `terrain.static` (§4.3) plane index `i` is cell
`(boundsLeft + x, boundsTop + y)`, where the bounds come from the **`world` section** (§4.2). Everything
else in the frame (actor positions, projectiles, crater events) is absolute. A terrain node that draws
grid index `(0,0)` at render origin displaces the entire battlefield by `(boundsLeft, boundsTop)` metres
from the units standing on it. **Terrain must offset by the world bounds; the bridge does not
pre-shift.**

**`heightAt` / `surfaceAt` arguments.** The second argument is render **Z**, not render Y. Under §12.4
render Y is the height axis, so reading `heightAt(worldX, worldY)` literally would make the second
argument the return value.

**Height step.** One unit of the §4.3 `height` plane is **512 WDist = 0.5 m** of rise. This single number
sets every slope and cliff in the game.

**`SurfaceSet` albedo is sRGB-ENCODED and must be sampled through `albedoView`.** Albedo is clamped to
0.02..0.90, and **0.02 stored linearly in 8 bits is 5 raw levels against ~40 through sRGB**: an 8×
precision loss exactly where dark materials live. §12.1 therefore pins `albedoView`, an
`rgba8unorm-srgb` view over the sRGB-encoded `rgba8unorm` texture, as the sampling handle, so the
hardware always performs the decode and sampling without it is not expressible. The raw `albedo`
texture stays exposed for copies and VRAM accounting, documented as encoded and not for sampling.

The general principle: **when two nodes can disagree about a value, change the interface so the wrong
option is unavailable. Do not write a rule saying which to pick.** A convention binds only those who
read it; a type binds everyone.

**Texture-array layer selection.** `layer = min(zone, layerCount - 1)`: **clamp, never wrap.** Wrapping
makes an out-of-range zone silently alias a valid material, which reads as a texturing bug rather than
the data error it is.

**Draw-call accounting.** `render` bills one `DrawItem` as `2 + shadowCascades` draw calls when
`castsShadow` is true: a prepass, a forward pass and one per cascade. A node budgeting its own share must
multiply by that, not assume one item is one call. On `high` (4 cascades) each shadowing item costs
**6**, so a node claiming "35% of the draw budget" at 1 item = 1 call is really at ~210%.

**Mesh ownership.** Meshes reach the GPU through `render.upload()` and `render.uploadLods()` only. A node
that mints its own `GpuMesh` bypasses render's pipeline-creation counter, so `profile.mjs`'s "0 pipeline
compiles during play" gate goes blind to it, and nothing typechecks the shape across the seam.

**There is no hand-back draw channel.** Nodes submit `DrawItem`s and `render` encodes. A node exposing
its own `encode(pass)` for render to call is not part of §12; if it is never called, that node's entire
shader set silently never executes.

**Depth compare.** Depth-**writing** pipelines (prepass, shadow) use `greater` with
`depthClearValue: 0`. The forward pass uses `greater-equal`, deliberately: prepass and forward are
separate shader modules and float invariance across modules is not guaranteed, so `equal` or `greater`
would reject every fragment.

**Threading exception.** §6 puts expensive procedural generation in Web Workers. **`materials` is
exempt**: a `GPUDevice` is not transferable, and a worker-owned device could not share textures with
`render`. GPU texture generation therefore runs on the main thread as compute dispatches. Mesh
generation (`geo`, `units`) stays worker-bound.

---

### 12.6 Counters are recorded at encode time and prove nothing about presentation

`render.stats.drawCalls` and `.triangles` are incremented when a draw is **recorded into a command
encoder**. They are not evidence that anything was submitted, and certainly not that anything was
presented. One bad `drawIndexed` raises a validation error at `encoder.finish()`, which invalidates the
**whole command buffer**: shadow passes, depth prepass, forward, TAA, exposure and post all die together,
because they share one encoder, while every counter reads normal.

Two consequences bind every node and every tool:

1. **A GPU validation error is neither a `pageerror` nor a `console.error`.** A boot gate that watches
   only those sees a clean run. Wrap frames in `device.pushErrorScope('validation')` when measuring
   anything.
2. **The only check that spans the whole path is reading the presented canvas.** `capture.mjs` fails on
   an all-black or single-colour frame for exactly this reason.

When reading back a canvas, render and read in the **same task, with no `await` between them**. A WebGPU
canvas is presented when its task ends and is not preserved across the boundary.

`copyTextureToBuffer` against a texture lacking `COPY_SRC` is a validation error that leaves the
destination buffer **zero-filled**, indistinguishable from a black render. `render.targets`' HDR and
history textures and the exposure buffer all carry `COPY_SRC` so the harness can read them honestly.

---

## 13. Platform and renderer constraints

- **WebGPU is required.** There is one renderer, and it is WebGPU-only. On a browser without WebGPU the
  3D renderer stays disabled, logs an error and sets `render.unsupported`, which `ui` shows on screen;
  everything else boots. `ctx.gl` and the `webgl2` backend value remain in the types, but no renderer
  uses them.
- **The probe volume is ambient irradiance, not global illumination.** Each probe integrates the
  analytic sky over 32 fixed directions plus the sun's single bounce off the ground, gated by the shadow
  cascade so a probe under a roof loses its bounce term (`render/probes.ts`). There is no
  surface-to-surface transport and no occlusion beyond the sun's own depth buffer. Probes refresh
  round-robin within the §7 `probe updates / frame` budget.
- **Per-object motion vectors.** The depth prepass writes a persistent `rg16float` velocity AOV from the
  exact current and cached previous model, skin pose, camera and selected LOD. TAA reprojects from that
  AOV. First sightings, stale reappearances and static submissions use current = previous, so they
  cannot streak in from an invented origin. Actor history is keyed by stable simulation id and updated
  only after admission to the render budget. `motiongate.mjs` measures the production attachment
  against the production-submitted transforms, and its zero-object-motion control must go red.
  `dbgview` reads the same AOV.
- **Spot lights share the clustered pool.** `addSpotLight` adds a directed light with smooth inner and
  outer cosine falloff to the same pool as point lights (a 48-byte light record). There is no private
  shadow map. A consumer node never fakes a cone itself: a headlamp is not the place to invent renderer
  contract.
- **No overdraw debug view.** It cannot be a branch in the forward fragment shader, because without
  blending only the topmost fragment is visible; it needs a dedicated additive-blend pipeline created at
  boot. `dbgview.mjs` reports it as blocked rather than faking it.
- **No Lua runtime.** The runtime is skirmish and multiplayer only; scripted campaigns are excluded
  (§1.2).

---

## 14. Assets, generation and engine boundaries

This section sets the rules for assets, build-time generation, and the boundaries between the
renderer, the audio engine and the game.

### 14.1 No EA content; open formats

No Westwood/EA content in the repository, the bundle or any deployable, ever. The mod mounts no `.mix`
and wires no `.shp`, `.aud` or `.vqa` loader. That data is EA's copyright, released as freeware for
personal download only, and this project never ships, hosts, streams or commits it. Art is never
derived from EA art (§14.12), and the authored code surface carries no EA trademark names (§1.3).

The project's own assets use open or project-defined formats: Blender `.blend` sources, gzip-compressed
mesh and material packs, and compressed images and audio. Procedural generation stays a capability: it
is the fallback path and the source of per-instance variation, wear and greebles.

### 14.2 Budgets that depend on the asset mix

Budgets that depend on what ships are re-measured whenever the asset mix changes: download size,
texture VRAM (§7) and boot time. The composed bundle has no remote runtime dependency. There is no service worker and no offline shell, so no offline or warm-revisit
claim is made; the boot LOD cache (§5) is the only browser-side cache.

### 14.3 Renderer boundary

Nodes reach the renderer only through `RenderApi` (§12.2): they submit `DrawItem`s and never encode
passes themselves (§12.5). The renderer holds no game rules; from the snapshot it reads only the player
colour table. `sky` is the single writer of time of day and weather, through `render.setEnvironment()`.
Two writers of one perceptual channel would mean two clocks that can disagree.

### 14.4 Rendering features are gated

Every rendering feature has a named gate and a measured cost (§7.1 pricing rule). A feature is named for
what it computes: a technique that does not transport light between surfaces is not called global
illumination (§13).

### 14.5 Tonemap and exposure

- **The AgX transform maps neutral to neutral.** Its inset and outset matrices each have row sums of
  exactly 1. Published AgX listings are written in rows, while WGSL `mat3x3(a, b, c)` takes columns, as
  GLSL `mat3()` does, so a listing is transposed on transcription. `tonegate.mjs` parses the matrices
  out of the shader rather than keeping a second copy, and asserts grey in, grey out across 8 stops
  through the real nonlinearity. `--falsify=transpose` and `--falsify=pair` must go red.
- **Relative measurements cannot see a uniform error.** A non-black capture, a healthy frame time and a
  day/night ratio all pass when every pixel carries the same tint. An absolute invariant, such as
  `tonegate`'s, is the only guard.
- **Exposure.** The low-light exposure ceiling keys only from `SkyEnvironment.ambientScale`, the authored
  environment value that terrain, units and probes already use, and never from metered scene luminance.
  Transient effects therefore cannot pump whole-frame exposure. `todgate` reads exposure beside
  depth-masked samples at four hours and asserts the day/night range.

### 14.6 Audio consumes events

The game emits events; it does not emit sound. A consumer says "a 120 mm gun fired at this world
position, from this actor, on this surface". The audio engine chooses the voice, the distance model and
the occlusion, and decides whether the voice budget (§7) can afford it. It owns the mixer, the voice
budget, spatialisation, occlusion, ducking and the synthesis and sample graph. Sound comes from
synthesis (engines, weapons by calibre) and from pre-rendered clips (announcer voices, music and effect
banks) that ship as baked output (§14.9). Synthetic audio reacts only to real simulation events.

### 14.7 Licence and provenance

- The software is GPL-3.0-or-later: the engine (a fork of OpenRA), its WebAssembly port, the dedicated
  server and multiplayer node (`engine/`), the WebGPU client (`web/`), the desktop app (`desktop/`) and
  the build tools. It ships with complete corresponding source, keeps OpenRA's copyright headers and
  `engine/AUTHORS`, and carries the notice that EA has not endorsed it.
- Creative files (Blender models and textures, art packs, music, voices, sound effects and cinematics)
  are licensed separately; `LICENSE` states the terms. Third-party material and its licences are listed
  in `THIRD_PARTY_NOTICES.md`.
- Every third-party asset input has a recorded licence and origin (`art/sources.lock.json`,
  `art/supplied-inputs.lock.json`, `sourcelicensegate`). "Found it online" is not an origin.
- Trademarks are separate from copyright. The trademark notice is in `LICENSE`.

### 14.8 Audio is a separate, smaller engine, and neither engine depends on the other

**Audio is its own package, not a room inside the renderer**, because the two have incompatible
internal constraints. Audio runs against a hard real-time deadline: an AudioWorklet gets a 128-sample
quantum, roughly 2.6 ms at 48 kHz, and missing one is an audible click that no temporal filter can hide.
Graphics runs against a frame budget and is *allowed* to drop a frame; §7.1's degradation ladder is
built on that permission. Packaging a system that may degrade with one that may not lets the looser
constraint set the engineering culture for both.

Consequences:

1. **Audio is gateable without a GPU.** The audio gates (`audiogate.mjs`, `audionodegate.mjs`) render
   waveforms in Node, with no browser, no GPU and no `AudioContext`. They never pay for the GPU browser
   harness and its traps (a WebGPU canvas that does not survive a task boundary, `copyTextureToBuffer`
   returning zeros).
2. **Audio is independently adoptable.** A 2D game, a visualiser or an audio tool can take it without a
   WebGPU renderer, and WebGPU availability never decides whether sound works.
3. **A consumer who wants no sound ships no sound.**

**Neither engine depends on the other.** The renderer never imports audio, and audio never imports the
renderer. If the renderer imported audio it would have to know what a gunshot is. Only the composing
layer knows both exist. The seam audio needs is small and fully specified: **a listener pose, a clock
and an occlusion query.** In this game `camera` supplies the pose and the clock is `ctx.time`. The
occlusion query is a **callback the composing layer supplies**, so audio can ask "is this source
occluded" without being given scene knowledge, which would otherwise pull geometry into the audio
package and undo the split.

If the seam ever needs a fourth member, treat that as evidence the split is eroding and raise it
explicitly rather than widening the seam quietly.

### 14.9 Binary files and baked output

- `web/src/`, `web/tools/` and `engine/mods/` contain no binary files. `rulecheck` checks content type,
  not extensions.
- The editable art sources (`.blend`) and the scripts that build them are separately licensed creative
  files (`LICENSE`) and are not part of this repository.
- Baked packs, textures, portraits and pre-rendered audio are build output in the ignored
  `web/.forge/` and are never committed. A checkout without the packs runs the procedural fallback
  (§0).
- The renderer may load mesh, texture and audio assets, because reuse requires it. The game loads only
  its own baked packs and makes no external art requests (§0).

### 14.10 Environment lighting is generated

Environment lighting comes from the analytic sky model owned by `sky`, which follows the day/night
cycle and the weather. The probe volume integrates that sky (§13). No captured environment photograph
is used: a single frozen moment cannot respond to time of day.

### 14.11 Build-time forge

Generation does not have to run in real time. Expensive, shared generation runs at build time: the
sources stay sources, and the deployable carries baked output that Vite fingerprints.

The forge commands live in `web/package.json`: `forge` (the Blender mesh pack from saved `.blend`
sources; it never overwrites saved models), `forge:environment`, `forge:materials`, `forge:trees`,
`forge:previews`, `forge:index`, and `forge:proof` (a single-structure procedural bake). The Blender
commands need the separately licensed sources (§14.9). Every forge output:

1. is deterministic: the same inputs produce the same output bytes, and its gate proves the hash is
   stable across two runs;
2. is content-hashed and integrity-checked at load;
3. falls back to the procedural path when it is missing, disabled (`?noforge=1`) or invalid.

Bake what is expensive and shared (mesh LODs, material sets, portraits). Generate at runtime what is
per-instance and cheap (wear, greebles). A first visit and a revisit with the boot LOD cache (§5) are
measured separately.

### 14.12 Boundary — what may and may not be taken from the Red Alert data

**Permitted: functional data, which is not protected expression.** Cell footprints, build times, costs,
ranges, damage values, reload and turret rotation rates, speeds, vision radii, animation frame *counts*
and timings, tech-tree shape. These are the rules of a game, not its artwork, and OpenRA ships them as
MiniYAML in its own mods. The game plays Red Alert's rules directly (§0).

**Permitted: genre convention.** A tracked tank has a hull and a turret; a refinery has a silo and a
dock. Style and genre are not protected; only specific expression is.

**Not permitted: anything derived from the art or audio itself.** Do not sample their palettes, trace or
match their silhouettes, derive shapes or proportions from their sprites, reproduce insignia, or
generate any asset *from* their assets. Output derived from copyrighted input is a derivative work
regardless of how much of our own code sits in between. The Blender models are original
interpretations of names and gameplay roles, made without reading or converting the original artwork.

**Not permitted: a build that depends on their files.** The forge must be byte-deterministic and
reproducible (§14.11). A bake that reads `.mix` data cannot run on a machine that lacks it, so the build
would stop being reproducible, could not run in CI and could not ship as complete corresponding source
under the GPL. This is a hard engineering objection, independent of the legal one.

**Why this matters:** the project is distributable *because* it replaces EA's content rather than
loading it. Deriving our art from theirs would give up exactly that.

### 14.13 Generation is driven by the roster slot's archetype and its numbers

The procedural generators (the fallback path, §0) build each actor from its roster slot's *semantic
archetype* plus the functional data §14.12 permits. "Refinery", "harvester", "artillery" and "light
tank" are generic RTS vocabulary that describes a **function**, not an expression.

Deriving geometry from function is the correct generator for §9.0's machines a person could walk up to
and touch. Real machines look the way they do because of what they do, and the balance numbers describe
function precisely enough to build from:

| functional datum | what it drives |
|---|---|
| cell footprint | physical dimensions, track/wheel span, hull length |
| weapon range + damage | barrel length and bore, recoil mass, muzzle geometry |
| reload / turret rate | breech bulk, turret ring diameter, traverse gear |
| speed + locomotor | wheel count, track width, suspension travel, engine deck size |
| cost / HP / armour class | plate thickness, bolted vs cast massing, greeble density |
| build time | plausible structural complexity |
| vision radius | sensor mast, optics housing |

**The tuning numbers become art direction.** A unit that is expensive, slow and heavily armoured
*generates* as a slab of cast steel without anyone deciding that by hand, and a cheap fast scout
generates as a light frame on thin wheels. Faction identity stays fixed per §9.2 (the Foundry casts and
welds, the Lattice bolts frames), so the same archetype yields two recognisably different machines.
Dispatch is by `Family` (`web/src/units/archetype/params.ts`). The data flows exporter → `rosteradapt`
→ `roster.json` → `RosterSlot` → `ChassisParams`.

**Resolve archetypes through `ctx.actorTypeName()`, never through `typeId`.** Type ids are assigned
first-seen on the C# side, not from an enum, so a hard-coded table draws the wrong unit silently. The
archetype map is keyed by name and must fail loudly, counted in `stats.dropped`, on an unrecognised
name, rather than fall back to a generic hull that hides the omission.

### 14.13a The mod may describe FUNCTION more precisely; the generator may not read a NAME

The generators never key geometry on an actor's name. A name table goes stale silently the first time
an actor is renamed, and then draws the wrong unit with nothing reporting it. The mod may describe an
actor's function in more detail (massing, role, crew, deck, armour style, appendages), and the
generators consume such data like any other functional datum through the §14.13 path. Two actors with
identical functional data generate identical geometry.

`rulecheck` enforces this. Any string literal matching `/^(foundry|lattice|drift)_/` in code under
`web/src/units/archetype/` fails; comments that cite a measured actor are exempt, and the committed
`roster.json` is data, not code. The display names in `engine/mods/steelseed/fluent/en.ftl` are for
people authoring function data and are never an input to code.
