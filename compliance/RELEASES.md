# Public source edition release record

## v0.2.0 — 7 October 2026

This public source edition aligns its first-party package and game version records to 0.2.0. It preserves the shared OpenRA/WASM engine, WebGPU renderer, neutral minimal interface, generated stand-in assets, minimal desktop wrapper, licensing notices and architecture documentation from the reviewed public edition. The simulation and renderer are unchanged.

The public node packagers now read `release/game-version.json` for the app version in ZIP/npm release manifests and for the npm package version and installation example. This focused metadata adaptation replaces the npm packager's old fixed version and fills the previously absent manifest app version. Public packaging, licence notices, simulation identity and feature exclusions are preserved.

The production HUD and launcher, JOA, Freehop integration, production artwork/audio and deployment configuration remain excluded. The private development blog is not part of this edition. The upstream commit in [RELEASE-SOURCE.json](../RELEASE-SOURCE.json) records provenance; this edition is not asserted to be corresponding source for the separate production game or its installers.

Validation of this edition's source and package-version changes:

| Check | Result |
|---|---|
| Source inventory and credential-pattern audit | PASS; all 4,214 source paths checked, including the public package-version regression test |
| Source/export, artifact-verifier and package-version tests | 69 passed |
| Node package version regression | PASS; tiny fixture ZIP/sidecar and npm metadata follow canonical versions 0.2.0 and 0.7.2 without changing simulation identity |
| Shared native, WebAssembly and WebGPU client build | PASS |
| Web TypeScript | PASS |
| Desktop wrapper and source-identity tests | 13 passed |
| Built client sources and notices | PASS; 156 client source files match; licence and author notices match |
| Generated stand-in asset licence/provenance gate | PASS; six creative files, no pending rights evidence |
| Real browser skirmish | PASS; tick 30, selection and accepted contextual order, legal documents, zero external requests or runtime/console errors |

The build and browser checks ran in an isolated public-source candidate containing the same engine, renderer and first-party package versions. The later node-packager metadata adaptation was tested separately with the fixture checks above. The final Git checkout repeated the source audit, guard tests, built-source verification and stand-in asset licence gate. The simulation identity remains `6ad027ce9dd7`. These checks do not qualify production binaries, installers, node archives or physical platform performance. No production correspondence is claimed.

## v0.1.0 — 7 October 2026

First release of the replacement public source repository. Scope: the minimal public source edition described in [README.md](../README.md). The production game was not rebuilt or deployed.

[RELEASE-SOURCE.json](../RELEASE-SOURCE.json) records upstream inputs and this edition's changes. Its upstream commit is provenance, not an assertion of correspondence with production binaries. The public Git commit/tag identify this edition, excluding production GUI/artwork, JOA and Freehop.

## Validation

Checks ran in an isolated checkout on macOS arm64, Node 26.3.0, .NET 8.0.423 and wasm-tools. Browser execution used the local Chromium/WebGPU harness.

| Check | Result |
|---|---|
| Source inventory and credential-pattern audit | PASS; excluded features and generated outputs rejected |
| Source/export and artifact-verifier tests | 56 passed |
| Web TypeScript, Vite and focused tests | PASS; 16 focused tests passed |
| Native server, utility, replay verifier and WebAssembly build | PASS |
| Shared AppBundle composition | PASS; 47 presentation files, 7,560,105 bytes |
| Placeholder asset licence/provenance audit | PASS; six shipped creative files traced to generated stand-ins, no pending evidence |
| Built client sources and notices | PASS; 156 client source files match; GPL/LGPL/AUTHORS match |
| Real engine browser skirmish | PASS; maps, start, ticking, selection, accepted contextual Move order, legal documents |
| Browser requests/errors | Zero external service requests and zero runtime/console errors during the check |
| Engine/hosting Node suites | 125/126 initially passed; after supplying the generated-build prerequisite, all five ranked-worker tests passed on rerun |
| Desktop wrapper/source-identity tests | 13 passed |
| Modified upstream provenance | PASS; 1,678 source files, 66 maps |
| Installer and node archive packaging | Not qualified for this source release |

Compiler style/analyser warnings and Vite's large-chunk advisory did not stop the build. No production performance or cross-platform installer qualification is claimed.

Simulation identity: `6ad027ce9dd7`; modHash: `6047a2558836489607f199604462a950543488210c1cc43eb6cf3b01b143a8cd`.

The browser proof recorded tick 21, one visible local actor, five player records, and `ok: issued 1/1 OpenRA contextual orders (Move)`. The minimal interface provides basic skirmish controls; adopters add production controls and a multiplayer lobby.

## Repeating the checks

From the repository root, with the documented toolchain:

```sh
node tools/build.mjs
node tools/release.mjs
node --test --test-force-exit engine/steelseed-host/tools/*.test.mjs
node --test desktop/*.test.mjs engine/steelseed-host/tools/release-manifest.test.mjs
node web/tools/composedgate.mjs
node tools/verify-release.mjs --source . engine/bin-browser/AppBundle
```

The final command audits local client sources and notices. It is not independent binary-rebuild verification or certification of another distribution.

For the placeholder asset inventory, run from `web/`:

```sh
node tools/sourcelicensegate.mjs --target=public-sample --inventory=../engine/bin-browser/AppBundle/steelseed/composition.json --forge=.forge
```

Produce a source archive from a fixed public commit without production repository or deployment access:

```sh
node tools/export-release.mjs --commit v0.1.0 --out ../redlinewars-source-v0.1.0
```

The exporter requires a new directory, validates the edition's source policy and never commits, pushes or deploys.
