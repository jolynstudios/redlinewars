# Included systems

This public source edition provides the systems below under the licences in [NOTICE.md](NOTICE.md).
It supplies a minimal playable example; adopters build their own interface and content around the
documented engine and rendering contracts. [compliance/RELEASES.md](compliance/RELEASES.md) records the
checks actually performed on this edition.

## OpenRA in WebAssembly

The OpenRA simulation runs in a dedicated Web Worker. The authored host is in
`engine/steelseed-host/OpenRA.Browser/`; the pinned engine source is in `engine/openra/`.
Snapshots travel to presentation code and input travels back as engine orders. The dedicated server
uses the same simulation source and generated mod without rendering.

`engine/OpenRA.Browser/tests/` contains the local static server and retained browser harnesses.
[ARCHITECTURE.md](ARCHITECTURE.md) specifies the snapshot ABI and simulation boundaries.

## WebGPU renderer and procedural presentation

`web/src/` contains the renderer, materials, camera, terrain, animation, effects, shroud, units and
synthetic audio. Rendering consumes authoritative simulation snapshots. Procedural generators provide
visuals when separately authored packs are absent.

`tools/fallback-art.mjs` creates neutral asset stand-ins and silent replacements for recorded audio
inputs. The production artwork and the private tools that produce it are excluded.

## Minimal interface

`web/src/ui/` provides map choice, bot-skirmish startup, unit selection, contextual orders, and basic
resource and match status. It uses system fonts and neutral controls. It does not include the
production GUI, a multiplayer lobby, JOA or Freehop.

## Hosting components

`engine/steelseed-host/tools/` contains the room host, relay, node entry point, LAN discovery, protocol
definitions and server packaging tools. These transport and hosting components do not provide the
excluded production interface or media/companion integration. Service configuration belongs to the
adopter.

## Shared build and desktop wrapper

`tools/build.mjs` prepares the engine and public stand-ins, then runs the `web/` Vite build and
composition. One AppBundle serves the browser and the minimal Electron wrapper. Desktop packaging
consumes that output; it does not contain a separate implementation of the game.

## Checks and provenance

The repository retains checks for core simulation, rendering, assets, transport, packaging and source
boundaries. Some specialized harnesses require an adopter's own assets or presentation. Their presence
is not a claim that every test or platform has been qualified for this edition.

The export metadata, licensing notices, dependency research and architecture are included so adopters
can inspect how the source was assembled and what its dependencies require.
