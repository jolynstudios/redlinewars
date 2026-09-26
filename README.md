# Redline Wars: Fractured Order, source code

**Redline Wars is an independent, free, fan-made game. It is not affiliated with, sponsored by or
endorsed by Electronic Arts or Westwood Studios. Command & Conquer and Red Alert are trademarks of
Electronic Arts Inc. EA has not endorsed and does not support this product.**

The complete source code of [Redline Wars: Fractured Order](https://www.redlinewars.online), a real-time
strategy game built on [OpenRA](https://www.openra.net). It has:

- the OpenRA fork and its WebAssembly port;
- the WebGPU client;
- the Electron desktop shell;
- the dedicated server;
- the community node, room host and relay;
- the tools that build and package them.

It is free software under the GNU General Public License, version 3 or later: see [LICENSE](LICENSE) and
[NOTICE.md](NOTICE.md). Third-party components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- Play: https://www.redlinewars.online
- Bugs: https://github.com/jolynstudios/redlinewars/issues

## The source of each version we distribute

The versions we distribute have a tag, starting with `v2026.09.26-4c6da14`. The builds we distributed from
20 September 2026 until then have none here. [compliance/RELEASES.md](compliance/RELEASES.md) lists each
tagged artifact with its sha256, its tag and how it was checked against that tag.

| Tag | Source of |
|---|---|
| [`v2026.09.26-a87bf8d`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-a87bf8d) | the browser game at play.redlinewars.online, and the desktop apps (Windows, macOS, Linux) and community node zips at www.redlinewars.online/downloads |
| [`v2026.09.26-4c6da14`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-4c6da14) | the same, as first released on 26 September 2026; replaced the same day |

The tag's `RELEASE-SOURCE.json` gives:
- the commit of the private development repository it was exported from;
- what was withheld, and why ([compliance/EXPORT.md](compliance/EXPORT.md)).

Each desktop package, node zip and npm node package carries a `RELEASE-MANIFEST.json` naming the tag and the
source commit it was built from. Each download's sha256 is in the `SHA256SUMS` file beside it.

## What is not in this repository

- **Separately licensed art**, including:
  - the Blender-built models, textures and landmark packs (`web/.forge/`);
  - the music, voices and sound effects;
  - the brand icons and the desktop landing backgrounds.

  `tools/fallback-art.mjs` writes plain stand-ins, so the game builds and plays without them. They are:
  procedural geometry and materials, a simple bridge, silence, a neutral icon and flat backgrounds. The
  official builds use the same code with the separately licensed art.
- **Other private material:**
  - the marketing website;
  - the Blender source files and the art pipeline that builds the packs;
  - production infrastructure: deployment, and the CI with its hosts and secrets;
  - internal notes.

## Build

You need:
- Node.js 22 or newer and git;
- the .NET 8 SDK pinned in `global.json`, with the WebAssembly workload (`dotnet workload install wasm-tools`).

```sh
git clone https://github.com/jolynstudios/redlinewars && cd redlinewars
git checkout v2026.09.26-a87bf8d
node tools/build.mjs                       # set DOTNET=/path/to/dotnet if it is not on PATH
```

`tools/build.mjs` runs the same steps as the official CI:
1. `npm ci`;
2. the stand-in art;
3. the .NET builds;
4. the generated mod and its `simBuild` id;
5. the WebAssembly publish;
6. the client build;
7. compose.

The output is `engine/bin-browser/AppBundle`.

### The browser game

```sh
node engine/OpenRA.Browser/tests/server.mjs --root engine/bin-browser/AppBundle --port 8080
```

Then open `http://127.0.0.1:8080/steelseed/index.html` in a browser with WebGPU, such as Chrome or Edge 113+.

### The desktop app

The packager consumes the AppBundle built above and never rebuilds game code. It also needs the
self-contained server for each target:

```sh
node tools/build.mjs --standalone osx-arm64,osx-x64      # win-x64 / linux-x64,linux-arm64 for the others
npm ci --prefix desktop --workspaces=false
node desktop/package.mjs mac                              # or win, linux
```

The results land in `desktop/dist/`:
- macOS: `Redline-Wars-macOS-<arch>.zip`, each with ad-hoc signed apps;
- Windows: `Redline-Wars-Windows-x64-Setup.exe`;
- Linux: `Redline-Wars-Linux-<arch>.AppImage`, which must be packaged on Linux with `patchelf`.

### A headless community node

```sh
node tools/build.mjs --standalone linux-x64
node engine/steelseed-host/tools/pack-node.mjs linux-x64    # dist/redline-node-linux-x64.zip
```

The zip holds the room host, the generated mod and the self-contained server; it has no WebGPU client.
Unzip it and run `./start-node.sh` (`start-node.cmd` on Windows); `README-NODE.md` inside explains the
options. `--lan` runs a LAN-only node with no connection to the public Grid.

### Checking a download against its source

```sh
git checkout v2026.09.26-a87bf8d && node tools/build.mjs
node tools/verify-release.mjs --source . --sums SHA256SUMS --require-manifest Redline-Wars-macOS-arm64.zip redline-node-linux-x64.zip
```

The verifier fails the artifact unless:
- its hash matches `SHA256SUMS`;
- its source commit, tag and `simBuild` are this checkout's;
- every node source file, and every client source file embedded in the shipped source maps, is byte-equal
  to the checkout (a build without source maps, or with a map that leaves out its sources, fails);
- the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries are byte-equal to the checkout's,
  and the third-party notices credit the engine and those libraries;
- a server artifact carries no WebGPU client.

For the live browser game, pass the deploy's own AppBundle with `--appbundle`: the verifier then also checks
that every WebAssembly runtime file the site serves (`_framework/`) is the build's. `node --test
tools/verify-release.test.mjs` shows each of these checks failing on a broken build.

## Layout

| Path | What |
|---|---|
| `engine/openra/` | the pinned OpenRA fork, with its provenance lock |
| `engine/OpenRA.*`, `engine/mods/` | the OpenRA projects that the dedicated server, utility and mod builds compile |
| `engine/OpenRA.Browser/` | the browser test harness and the static server |
| `engine/steelseed-host/` | the WebAssembly host (`OpenRA.Browser`), the mod (`OpenRA.Mods.Steelseed`), the ranked replay verifier, and the node, room host, relay and packaging tools (`tools/`) |
| `engine/licenses/` | the licences of the libraries the engine bundles (GPL v2, LGPL v2.1, LGPL v3) |
| `engine/tools/` | the self-contained server publish (`publish-standalone.mjs`) |
| `web/` | the WebGPU client (TypeScript, WGSL), its build (Vite, compose) and its gates |
| `desktop/` | the Electron shell and its packager |
| `tools/` | `build.mjs`, `fallback-art.mjs`, `verify-release.mjs`, `export-release.mjs` |
| `compliance/` | the release inventory, the dependency audit and the export policy |
| `ARCHITECTURE.md` | the architecture and the snapshot ABI |

## Licence

Redline Wars: Fractured Order © 2026 Jolyn Studios.

OpenRA © The OpenRA Developers and Contributors.

The code is released under the GNU GPL v3 or later. The Redline Wars name, logo and icon are not licensed for
use as marks; see [NOTICE.md](NOTICE.md).
