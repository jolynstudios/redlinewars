# Redline Wars — public source edition

An OpenRA-based engine, WebAssembly host and WebGPU client with procedural visuals and a minimal
playable interface. Developers can use this source edition as the starting point for their own
presentation and product.

This is the first release of this replacement source repository. It includes:

- the OpenRA fork, game rules, WebAssembly host and dedicated server;
- the WebGPU renderer, procedural geometry, materials, animation, effects and synthetic audio;
- a neutral interface for choosing a map, starting a bot skirmish, selecting units and issuing orders;
- community-node, room-host and relay source;
- a minimal Electron wrapper and the tools to build and package the same AppBundle.

Project code is free software under GPL-3.0-or-later. Third-party components retain their stated
licences. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). [CONTRIBUTION.md](CONTRIBUTION.md) describes the
included systems and [ARCHITECTURE.md](ARCHITECTURE.md) documents their contracts.

Redline Wars is an independent fan-made game. It is not affiliated with, sponsored by or endorsed by
Electronic Arts, Westwood Studios or the OpenRA project. Command & Conquer and Red Alert are trademarks
of Electronic Arts Inc.

## Release scope

The production HUD, setup screens, multiplayer lobby, tutorial, match report, desktop landing GUI,
JOA phone app and Freehop integration are excluded. So are the production models, textures, music,
recorded voices, cinematics, logos and backgrounds. The marketing website, credentials and production
deployment configuration are not part of this edition.

The replacement interface uses system fonts and neutral controls. It provides map choice and a local
bot skirmish, click or Shift-click selection, right-click contextual orders, white selection rings,
and credits, power, tick and match-outcome information. Adopters implement additional menus, production
controls and multiplayer presentation using the included engine interfaces.

`tools/fallback-art.mjs` generates stand-ins for required asset inputs. Procedural visuals and
synthetic audio remain available; recorded voice and music inputs are replaced with silence.

The separately distributed Redline Wars game has additional components and is unchanged by this
source release. This repository documents and builds the public source edition; it does not claim
to reproduce the separately distributed production client or share its simulation build identity.
Source provenance is recorded in [RELEASE-SOURCE.json](RELEASE-SOURCE.json), the export boundary in
[compliance/EXPORT.md](compliance/EXPORT.md), and checks actually performed in
[compliance/RELEASES.md](compliance/RELEASES.md).

## Build

Requirements:

- Node.js 22 or newer and git;
- the .NET 8 SDK pinned in `global.json`, with its WebAssembly workload
  (`dotnet workload install wasm-tools`).

```sh
git clone https://github.com/jolynstudios/redlinewars
cd redlinewars
node tools/build.mjs
```

Set `DOTNET=/path/to/dotnet` if the required SDK is not on PATH. The script installs locked npm
dependencies, generates stand-ins, builds the engine and mod, publishes WebAssembly, builds the
client with Vite, and runs `web/tools/compose.mjs`.

The single game output is `engine/bin-browser/AppBundle`. Both browser serving and desktop packaging
use this AppBundle. Desktop packaging never builds a second copy of the game.

### Browser

```sh
node engine/OpenRA.Browser/tests/server.mjs --root engine/bin-browser/AppBundle --port 8080
```

Open `http://127.0.0.1:8080/steelseed/index.html` in a browser with WebGPU enabled.

### Desktop

The desktop wrapper opens the same AppBundle directly. It does not include the production launcher
or its account, hosting and companion screens. After building the AppBundle:

```sh
node tools/build.mjs --standalone osx-arm64,osx-x64
npm ci --prefix desktop --workspaces=false
node desktop/package.mjs mac
```

Use `--standalone win-x64` before packaging `win`, or `--standalone linux-x64,linux-arm64` before packaging `linux`. The packager consumes the existing AppBundle and fails if it
is missing; it does not build game code. Platform-specific packaging may require the corresponding
platform's packaging tools. See [compliance/RELEASES.md](compliance/RELEASES.md) for the targets
actually validated for this edition.

### Hosting source

The dedicated server uses the same simulation source and generated mod as the browser host, without
rendering. To build a self-contained server for a supported runtime identifier:

```sh
node tools/build.mjs --standalone linux-x64
```

The node, room host and relay live in `engine/steelseed-host/tools/`. The node defaults to local/LAN
operation; joining an adopter's relay requires explicit `--spine` or `SPINE_URL` configuration.
These components do not supply a multiplayer lobby in the minimal interface or access to the
production service. Adopters supply their own interface and service configuration. See the included
protocol and node documentation.

## Layout

| Path | Contents |
|---|---|
| `engine/openra/` | Pinned OpenRA fork and provenance lock |
| `engine/OpenRA.*`, `engine/mods/` | Engine projects and mod inputs |
| `engine/OpenRA.Browser/` | Browser regression harness and local static server |
| `engine/steelseed-host/` | WebAssembly host, assetless mod, replay verifier and hosting tools |
| `web/` | WebGPU client, minimal interface, Vite build, composition and retained checks |
| `desktop/` | Electron wrapper and packaging glue |
| `tools/` | Source-edition build, fallback assets, export and verification tools |
| `licenses/`, `engine/licenses/` | Third-party licence texts |
| `art/*.json` | Asset provenance records, not production artwork |
| `compliance/` | Export scope, dependency research and this edition's release evidence |

## Licence and attribution

Redline Wars source modifications © 2026 Jolyn Studios. OpenRA © The OpenRA Developers and
Contributors. Keep the applicable copyright, licence, attribution and warranty notices when
redistributing this code. See [NOTICE.md](NOTICE.md) for trademark terms.
