# Public source edition boundary

This repository is a source edition with a minimal playable interface and procedural stand-ins.
It was assembled in an isolated directory from a fixed development snapshot and the earlier public
export's licensing and build material. The production game, its checkout, deployments and installers
are outside this release operation.

## Included

- OpenRA engine source, authored WebAssembly host and assetless simulation/mod inputs;
- WebGPU client, procedural visual and synthetic audio systems;
- the minimal public interface and neutral startup page;
- dedicated server, room host, relay and node tools without companion or media integration;
- a minimal Electron wrapper that opens the shared AppBundle directly;
- build and packaging tools, retained checks, architecture, attribution and dependency notices;
- asset provenance metadata required by the source and asset checks.

## Excluded

- Production HUD, setup and lobby screens, tutorial, match-report presentation and desktop launcher;
- JOA phone application and its companion integration;
- Freehop dependencies, client/host integration and related production controls;
- production models, textures, recorded voices, music, cinematics, logos and backgrounds;
- the private art generators, marketing site, deployment infrastructure, credentials and internal notes;
- generated build outputs, dependency caches and local work files.

The simple interface is separate from the production presentation. Generated fallback assets replace
required absent inputs. Adopters supply additional UI and their own content; the minimal interface
does not expose every capability of the underlying engine.

## Provenance and current snapshots

`RELEASE-SOURCE.json` identifies this as `edition: public-source`. Its `sourceCommit` is the upstream
development snapshot used as an input, not an assertion that this edition is byte-identical to that
snapshot. `baselinePublicCommit` identifies the earlier export used for restored documentation and
tools. The recorded public modifications explain the changed feature set.

The public repository's own commit and release tag identify the finished source edition. Its engine
and mod changes can produce a different simulation build id from the production game. No production
binary correspondence is claimed by the upstream provenance fields.

`tools/export-release.mjs` exports a fixed commit of this public source repository. It does not import
private source or deploy the game. `tools/release.mjs` prepares a public-edition snapshot; publication
is a separate repository operation. Follow the commands' usage output for arguments.

## Build boundary

`tools/build.mjs` installs dependencies, prepares fallback inputs and builds the engine. The only
client assembly lane is the `web/` Vite build followed by `web/tools/compose.mjs`, producing
`engine/bin-browser/AppBundle`. Browser serving and desktop packaging use that same artifact.
Desktop packaging must consume the existing bundle and must not rebuild game code.

Public checks validate this edition's declared source and feature set. Checks that require excluded
production GUI, artwork or infrastructure are not evidence about this edition and are not part of
its release claim. Retained engine and renderer contracts remain applicable.

## Review and evidence

Review the export for secrets, private files, forbidden feature imports and unexpected binary assets.
Keep applicable licence texts, copyright headers and attribution. A scanner or a successful build
checks its stated technical properties; neither establishes the legal status of a different program.

The release record is [RELEASES.md](RELEASES.md). It reports only checks run on the current candidate
and identifies any unverified targets. Historical reports and old repository objects were backed up
separately; they are not presented as current release evidence.
