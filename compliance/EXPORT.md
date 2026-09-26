# How the public tree is produced

Redline Wars is developed in a private repository. It holds the code published here together with
material that stays private: separately licensed art and its Blender sources, the marketing website,
production infrastructure and internal notes.

`tools/export-release.mjs` writes the public tree of one private commit:

```sh
node tools/export-release.mjs --source <private repository> --commit <sha> --out <empty directory>
```

It reads the private repository only through `git ls-tree` and `git archive` of that exact commit. Each
release tag here is one such export, with `README.md`, `NOTICE.md`, `THIRD_PARTY_NOTICES.md`, `LICENSE`,
`licenses/`, `tools/` and `compliance/` added at the root.

A release tag is named `v<commit date>-<short hash>` of the private commit it was exported from, for
example `v2026.09.26-4c6da14`: the commit date is `YYYY.MM.DD` and the hash its first seven hex digits. The
official build runs in the private repository, and each package it makes names that tag and the private
commit in its `RELEASE-MANIFEST.json`, so a download points at its source before the tag exists.

## What is published and what is withheld

Every tracked path must match a rule, or the export fails. The most specific rule wins; on a tie the
private rule wins. A private rule that matches nothing also fails the export, because a mistyped rule would
publish what it was meant to keep.

**Published:**
- `engine/`: the OpenRA fork and its WebAssembly port, the dedicated server, the node, room host and relay;
- `web/`: the WebGPU client, its build and its gates;
- `desktop/`: the Electron shell and its packager;
- `art/sources.lock.json` and `art/supplied-inputs.lock.json`: the provenance records that the client
  build reads;
- `ARCHITECTURE.md`, `AUTHORS`, `global.json`, `.gitignore`.

**Withheld** (file counts of the current export):

| Withheld | Files | Why |
|---|---|---|
| `landing/` | 1221 | the marketing website |
| `art/` (but the two locks) | 915 | the Blender sources and the art pipeline |
| `web/tools/` art generators | 16 | Blender forges, text-to-speech and sound renders, supplied-mesh promotion: they build the separately licensed art, not the game |
| `web/.forge/` | 1 | the built art packs; the one tracked file holds muzzle anchors measured from the private models; `tools/fallback-art.mjs` writes stand-ins |
| `desktop/build/icon.*`, `desktop/build/brandmark.svg`, `desktop/shell/bg-*`, `desktop/shell/hero-*` | 21 | brand artwork and backgrounds; `tools/fallback-art.mjs` writes stand-ins |
| `brand/` | 22 | brand artwork |
| `engine/bin-browser-legacy/` | 539 | tracked compiled binaries of the original host (build output) |
| `codex backup/` | 435 | a local backup tree |
| `deploy/`, `.github/` | 34 | production infrastructure: hosts, deployment, CI with its secrets |
| `docs/`, `docs-archive/`, `issues/`, `plan/`, `Blender-Review/`, `scripts/`, internal root documents | 145 | internal notes, measurements and tooling |
| `engine/.github/`, `engine/steelseed-host/tools/vmlab/`, `engine/steelseed-host/COMPLETION-AUDIT.md`, `web/.tmp-*` | 15 | upstream OpenRA's CI templates, an internal VM lab, an internal record, scratch scripts |
| root `LICENSE`, `README.md`, `THIRD_PARTY_NOTICES.md` | 3 | replaced by the public editions |

Build output, such as `bin/`, `obj/`, `node_modules/`, `dist/` and `generated/`, never leaves, whatever
directory it is in.

None of the withheld files is needed to build the game. Of the art, the build needs only the landmark
manifest, which `tools/fallback-art.mjs` writes. The desktop packager needs audio in the bundle and the
icons, and the stand-ins cover both.

The withheld CI and deployment scripts are the official build's control scripts. They name production
hosts and use secrets. `tools/build.mjs` runs the same build steps without them, and
[README.md](../README.md#build) documents each one.

## Documentation-only rewrites

Local paths on the author's machine are replaced in two files, and nothing the build runs is touched:
- one in a match report (`engine/OpenRA.Browser/tests/match-results/LEADERBOARD.md`);
- one path, nine times, in a gate's reference file (`web/tools/nightlight-reference.json`).

`RELEASE-SOURCE.json` records each rewrite: the file, the count and the replacement.

## Self-check

Before it passes, the export scans every file it wrote.

**Fatal:**
- private keys;
- GitHub, AWS, Slack, npm, Stripe, Resend and other API tokens;
- credentials in URLs;
- `.env`, key and certificate files.

**Reported for review:**
- home-directory paths;
- names of private repositories;
- the project's hosts.

What remains in the tags, all reviewed:
- The public hosts: `www`, `play` and `spine.redlinewars.online`.
- `web/forge-baseline.json`, which names the private repository that holds the art baseline. Public
  builds do not use it.
- The pinned OpenRA fork's provenance records, which name the private repository it was vendored from.
  They are part of the simulation's build id, so changing them would change the `simBuild` that the
  shipped builds carry.
- Two documentation links to a private repository.
- A test's placeholder path, `/Users/private/`.

## The tests in this repository

The unit suites pass here as they do in the private repository. A check that needs a withheld file reports
itself as skipped:

| Suite | Result |
|---|---|
| `node --test web/tools/*.test.mjs` | 149 pass, 3 skipped: the deploy workflow's cache-key checks need the private CI workflow |
| `node --test desktop/*.test.mjs` | 42 pass |
| `node --test --test-force-exit steelseed-host/tools/*.test.mjs` (in `engine/`) | 92 pass |
| `node --test tools/verify-release.test.mjs` | 7 pass: a good build passes, and each broken build fails for its own reason |
