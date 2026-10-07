# Public source edition release record

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
