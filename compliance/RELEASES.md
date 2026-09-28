# Releases

Every Redline Wars build distributed since the first tag, `v2026.09.26-4c6da14`, with the tag that holds its
source and how it was checked against that tag (`tools/verify-release.mjs`, on a clean checkout of the tag
built with `tools/build.mjs`). The builds distributed from 20 September 2026 until then have no tag; they are
recorded below, in [Before the first tag](#before-the-first-tag). The 28 September 2026 downloads went out
before their tag existed; the gap is recorded in
[v2026.09.28-ab47013](#v20260928-ab47013-the-downloads-of-28-september-2026), and that tag was published
with the release after it.

## Before the first tag

The release discipline — tags, `RELEASE-MANIFEST.json`, `SHA256SUMS`, the downloads page — began with
`v2026.09.26-4c6da14`. This section records what was distributed in the week before it, from which source,
and what can still be checked. No tag was moved and no newer source was relabelled as an older one to write
it; the sources are named by the commits the deployment record itself carries.

### The browser game: play.redlinewars.online (public channel)

Every successful deploy of the private monorepo replaced the live build. 59 deploys succeeded between the
first — 20 September 2026, 12:25 UTC, source `b30e4a6` — and `64fae7ae` on 26 September 09:02 UTC; the next
deploy, 26 September 10:09 UTC, was the first tag. The runs published the site's components (the browser
game, the marketing site, the relay); the record does not say which components each run carried, so a run
marks a distribution of the site, not of every component. A replaced build's bytes were not kept unless the
run's artifacts survive (†): the server overwrote each `composition.json`, so no checksum of a pre-tag
browser build can be stated today. Times UTC; `×2` is the same source deployed twice; † the run's build
artifacts are retained in the private repository (internal evidence, never a public download).

| Day | Deploys |
|---|---|
| 20 Sep | 12:25 `b30e4a6` · 13:23 `22c012e` · 14:35 `219cd0a` · 15:33 `1f0d8a8` · 16:07 `8c0b329` · 18:45 `2abb975` · 20:15 `d3c85c4` · 20:45 `a196e45` · 21:07 `16f062f` · 23:05 `63f770c` · 23:25 `cdd4f07` |
| 21 Sep | 00:43 `57179c7` · 01:12 `86560ff` · 06:33 `ee3105b` · 09:55 `90d5032` · 10:09 `61b01d8` · 10:26 `ff82382` · 10:51 `410e748` · 11:41 `16261bb` · 12:19 `4e0d598` · 16:07 `fcdf8be` · 17:06 `36f19cb` |
| 22 Sep | 01:55 `4c29f02` · 16:42 `4d48517` · 17:37 `ee74ab7` · 17:56+18:02 `9026235` ×2 · 18:40 `1772d37` · 19:19 `3f33748`† · 20:37 `e40ce3d`† |
| 23 Sep | 19:15 `0aef897` · 21:52 `51b46b2` · 22:46 `5f60a32` · 22:54 `5220216` · 23:27 `b15f518` · 23:38 `3d2643f` |
| 24 Sep | 07:15 `1ad32e5` · 07:20 `d26ede1` · 11:51 `5f60f3d` · 16:08 `4e00f0d` · 16:28 `5164e2d` · 21:40 `aa9ab69` |
| 25 Sep | 00:42 `2c1c6fa` · 09:02 `34edb36` · 10:21 `c178ce9`† · 10:32 `bff8595`† ×2 · 12:24 `2d8cfbf`† · 13:13 `5a110ab`† · 13:55 `556a129`† · 15:38 `9a76917`† · 16:59 `9dbf8a5`† · 19:12 `6966328`† · 19:52 `00aee48`† |
| 26 Sep | 00:07 `d43b7fa`† · 00:47 `a1f6f0e`† · 07:34 `666edbe`† · 09:02 `64fae7a`† ×2 |

### The community node package (limited channel)

One pre-tag artifact is retained: `redline-node-win-x64.zip`, 109036851 bytes, sha256
`8239017e8c8c50df5b55af47ad15a995048d8b2b2c6026b593f3b7238348fa9c`, built 24 September 2026 18:07 CEST —
one minute before the commit that bundled the Node.js runtime into this packaging (`4e00f0d0`, 18:08 CEST,
deployed 16:08 UTC). Its `node-assembly.json` names source `5f60f3d` and inventories 637 files. Audited
against a read-only export of `5f60f3db93ce` (below; the export is not built):

- 637 shipped files match their inventory; the 14 node source files are byte-equal to the export; nothing
  the packaging does not place is in the zip; the node-assembly's commit is the export's source commit;
- the export is unbuilt, so the generated mod, the bundled `ws` and the `simBuild` comparison are gaps, not
  verdicts;
- the zip predates the licence set and the release manifest: it carries no GPL text, no OpenRA AUTHORS, no
  library licences and no `RELEASE-MANIFEST.json`. The tagged releases ship all of these.

How far this zip travelled is not in the repository: it is recorded as a limited distribution (community
node operators) with the hand-off unevidenced — the retained artifact proves the build, not its delivery.

### Not distributed before the tag

- **The desktop apps:** the downloads page began with `v2026.09.26-4c6da14`; no pre-tag desktop
  distribution is evidenced. The full desktop sets built by the 22 September runs (`3f33748`, `e40ce3d`)
  and from 25 September on are retained CI artifacts — internal builds, never published.
- **`@steelthorn/node` (the npm node package):** never published, before the tag or since.

### Source exports

Read-only exports of the pre-tag sources named above were prepared with `tools/export-release.mjs` (it
reads the monorepo only through `git ls-tree` and `git archive` of the fixed commit): `5f60f3db93ce` and
`4e00f0d00fea` — both `--historical`, because `brand/` did not exist at those commits and the export records
its absence in `RELEASE-SOURCE.json` instead of failing — and `64fae7ae20ab`, the last source the pre-tag
site served. `--historical` publishes nothing beyond what the normal export would; without it, a private
entry that matches no tracked path still fails the export.

## v2026.09.28-2df2ad8 (the current release)

Exported from private commit `2df2ad82`, superseding `v2026.09.28-a7bcd14` the same night; none of the
28 September tags have deployed yet (the Actions budget was topped up after `88c5ea1`'s blocker). Four
owner-asked changes ride in this tag. The logo: the R is optically centred in its red slab (translated
by 12.4/10.9) and the wordmark rebalanced so both gaps beside the plate measure the same 97.4 px —
presentation transforms only, on every published sprite (game header, landing brand and favicons,
desktop build icons); the `brand/` originals are untouched. The desktop app icons are regenerated from
that fixed mark — every iconset size, `icon.png`, `icon.icns` and `icon.ico` rebuilt and round-trip
checked, pixel-measured at 1024: the R sits at margins 132/133 (left/right) and 124/124 (top/bottom)
inside the slab, where the previous binaries read 22 px left and 19 px high of centre. The desktop app
menu: dev mode reported "Electron" into the Apple menu and the About panel; `app.setName` plus an
explicitly built app menu (Dutch labels) fix the name, and "Spel afsluiten" sits at the bottom of that
menu, routed through the before-quit guard. The landing's "Why this exists" background: the CC BY 2.0
Suriname aerial photo is replaced by Jolyn Studios' own generated artwork — a deterministic seeded
cold-dusk landscape (snowy far range, layered forested ridges, dark fir foreground), 1600×1071 webp at
36 KB — and every credit for the old photo is gone from the caption, footer, credits page and
`THIRD_PARTY_NOTICES.md`; grep finds no remaining reference.

Downloads and the verification record will be added when the release is deployed.

## v2026.09.28-a7bcd14 (superseded by v2026.09.28-2df2ad8; not deployed)

Exported from private commit `a7bcd14e`, superseding `v2026.09.28-88c5ea1` the same night; like it, not
yet deployed (see below). The desktop landing's header mark now reads the way the owner asked: white
letters with no white plate. The plate `96886bd4` placed behind the mark made its knockout R read white
but showed as a white background; removing it alone also removed the white, because the landing's
`rw-mark` merged the letterform into a single red path. The symbol now carries the game page's own
decomposition — red slab, white R, red counter — pixel-verified: the white sits strictly inside the red,
with no margin around it.

Downloads and the verification record will be added when the release is deployed.

## v2026.09.28-88c5ea1 (superseded by v2026.09.28-a7bcd14; not deployed)

Exported from private commit `88c5ea1b`, superseding `v2026.09.28-333da6c` the same evening. Playing that
release surfaced two defects in the stand-in interface, both repaired here. A centre-of-screen click on the
focused own unit missed: the strategic camera's tilt offsets the screen-centre ground pick about 1.6 cells
from the focus target, and the click's hit radius was 1.5 cells — it is now 3 cells, which covers the
offset without claiming a neighbour's unit. And a browser whose WebGPU adapter request falls back to WebGL2
left the renderer node disabled before its bone palette existed, while the units and animation nodes kept
calling `reserveBones` every frame, throwing ~95 `TypeError`s per second; `reserveBones` now answers null
on that path exactly as it already does on palette overflow, and every caller already treats null as
"unskinned, keep going". The renderer itself is unchanged for every WebGPU browser.

The deploy of this release (run `36475009668`, dispatched from `88c5ea1b`) did not complete: GitHub
Actions refused to start the packaging jobs — "an Actions budget is preventing further use" — so no
artifacts were built and nothing was published; the live site and downloads remain the `aa02032` set
the previous deploy published. The re-dispatch, when the Actions budget allows, will run from the
release after this one, which carries the desktop header fix below.

## v2026.09.28-333da6c (superseded by v2026.09.28-88c5ea1)

Exported from private commit `333da6c8`, superseding `v2026.09.28-aa02032` the same evening at the owner's
direction. The public pages lose the Redline Wars logo and every brand-red indicator turns white; the
stand-in gains the affordances a player needs to see it work — a crosshair cursor over the viewport, the
renderer's selection rings (the same `camera.selectActors` surface the production interface drives), and a
short order-issued/order-refused note in the strip. The desktop landing's header mark loses the rounded
white plate that had appeared behind it, so the header reads dark again.

Its downloads never shipped: no deploy ran from `333da6c8`. Playing this release surfaced the two defects
the tag after it repairs, and the next deploy (run `36475009668`) was dispatched from `88c5ea1b` once they
were fixed.

## v2026.09.28-aa02032 (superseded by v2026.09.28-333da6c)

Exported from private commit `aa020326`. This is the interface withdrawal: the Jolyn Studios game
interface — the setup screens, multiplayer lobby, in-battle HUD, tutorial, match report and the JOA
phone companion with its tactical core — leaves the open-source client from this tag on. It is the
studio's own work above the OpenRA protocol boundary, like the separately licensed art. The export
replaces it with a stand-in presentation node (`web/src/ui`) and stand-in pages (`web/public-index.html`
and `web/public-companion.html`, published under the production names), so the public build still
starts a game, renders the battlefield, selects and commands units, and reports the local player's
basics. `RELEASE-SOURCE.json` records the renames and, new in this tag, the full `withheldPaths` list,
which the verifier uses to accept withheld-proprietary sources in a release build's maps. The desktop
packager stops embedding the client's source maps in the installers: their bytes stay in the build's
own AppBundle, where the verifier checks them. Tags before this one still carry the interface under
GPLv3, as published at the time; no tag was moved or rewritten.

The live game and the desktop apps we distribute are unchanged in behaviour: they are built from the
private tree, which keeps the production interface (`web/src/hud/`).

### Downloads: www.redlinewars.online/downloads

Published by deploy run `36469939151` (source `aa020326`, dispatched 19:06 UTC on 28 September 2026) and
live until the deploy of `v2026.09.28-88c5ea1` mirrored over them the same evening. Hashes from the
`SHA256SUMS` that run published.

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 458181289 | `e992d223578c198ce2d7918065a471afe6dd2e888957380da9aa7b9e61768470` |
| `Redline-Wars-macOS-arm64.zip` | 488461537 | `0811aeec7b00f7ddb2f4e4efe775b00bbdd884ec33a360047f42ff2787db085b` |
| `Redline-Wars-macOS-x64.zip` | 497239381 | `add351e67bbca21c8abcb9782db91459145e1f09f123422d4b9afa1c85ed0c25` |
| `Redline-Wars-Linux-x64.AppImage` | 454094185 | `263d1b8433857c465e565a5ce2c5c2e1f7ed3fdfc9f8a078327ca3f4ed662e6c` |
| `Redline-Wars-Linux-arm64.AppImage` | 454171174 | `0ede92d466dc5fb8b15b4cd845f95788dc982582429b3ffe6b3999a30ee9880b` |
| `redline-node-linux-x64.zip` | 72759434 | `31ba0ca1a100c96840dfdf1894c76337b69a77639745233fd427d1744d3828e4` |
| `redline-node-linux-arm64.zip` | 70014964 | `2f896a01bf1ba49f3873c533950098f19e0754997d29ecdf858b5da86e0304b2` |
| `redline-node-win-x64.zip` | 109249048 | `1022c6a2dd94a99e4dcac8dd863a32add3b7793c7f4931aa806f02680cc7c64f` |
| `redline-node-osx-arm64.zip` | 68390895 | `3fdd871359761fd8a05e70418205285a6dd49e489973806c63973916384d12df` |
| `redline-node-osx-x64.zip` | 71614826 | `2fb6d8e0129c537e9613d6c053d6c17644d83fc6cefb0a35815dbd17c6aff1a8` |

They were not strict-verified as a set before the release after them replaced them; the release after
them carries the full verification record.

## v2026.09.28-96886bd (superseded by v2026.09.28-aa02032)

Exported from private commit `96886bd4`, published the same day as `v2026.09.28-ab47013` and superseding
it. It repairs that release's two strict findings in the packaging itself: `assemble-node` now fails
unless the resolved-RA catalog exports its own node manifest names are present (CI exports them), and the
macOS node zips are ad-hoc re-signed on a macOS runner — every Mach-O, verified — so the Apple Silicon
node can host a room as shipped. The deploy's publish step now refuses to ship downloadables until this
tag exists on this repository, so a release can no longer go out with dead corresponding-source links.
The desktop selftest proves the live match frame presents, so the multiplayer-then-walk sequence that
failed on `ab47013` cannot pass silently dark again.

Player-facing changes: the JOA companion pairs through the public page (the pairing secret rides as `?p=`,
which survives QR camera apps that drop fragments; the QR and link no longer name the host's address),
`/steelseed` and `/steelseed/companion` serve without `.html` (the old paths keep answering), a public
room's share link is a page deep link (`?room=`), the desktop landing folds Play online into the hero
beside Start skirmish with the engine boot gating both actions, the lobby gains an admin kick and a live
roster, abandoned lobbies are reaped after 30 s, and `AUTHORS` credits the game's author.

Verification: the strict check against the deployed artifacts and the live site ran on 28 September, against
deploy run `36446328179`'s own artifacts and the live `SHA256SUMS`. Nine of the ten downloads and the live
site pass everything strict asks: hashes, source correspondence, notices, manifests, boundaries, and — for
the macOS arm64 package — a multiplayer selftest the deploy ran from the exact shipped archive. The live
site serves the reference build's composition (284 `_framework` files equal). The two signed macOS node
zips fail it in one way: ad-hoc signing rewrites the server binary and the Lua dylibs after
`node-assembly.json` was stamped, so three of their sha256 entries are stale, and the re-zip embedded an
extra `unzipped/` directory at the archive root. Both are packaging defects of the signed zips only — the
unsigned zips pass, the contents are correctly signed, and a locally restamped and re-rooted copy of the
shipped zip passes every source-correspondence check. The signing step now re-stamps the inventory and
re-zips from the package directory (private commits `b1e973b1`, `9d10e155`), so the next release's signed
zips verify strictly; `verify-release` additionally tolerates a single wrapper directory so these two
remain checkable.

## v2026.09.28-ab47013 (the downloads of 28 September 2026)

The downloads below replaced the previous set on 28 September 2026, published by the deploy of the
batch after `v2026.09.26-39d2824` (the deploy workflow's publish step, not a separate release cut).
Every artifact's `RELEASE-MANIFEST.json` and GPL notice names tag `v2026.09.28-ab47013`, exported
from private commit `ab470138d8e6`. That tag was not on this repository while these downloads were the
live ones, so the corresponding-source URL every artifact prints did not answer; the export of
`ab470138d8e6` is published under that tag by the release after it, closing the gap. The verification below ran
against a read-only export of `ab470138d8e6` built with `tools/build.mjs`: the build reproduces
`simBuild 7e45c0e93135` and `modHash f924d02e2402…`.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 459452471 | `1a67807f1871ea6c0d19d8ffc82e558e4ac0a8ef1af3e5360a7fe63c6b227144` |
| `Redline-Wars-macOS-arm64.zip` | 489723178 | `47805a497f2f71fd2dd37e30e58d2c3a91897addbcb920199be3c23cff16dc15` |
| `Redline-Wars-macOS-x64.zip` | 498501033 | `f7c80213f4bf373239ae5aefc38829db8cf944199ac51eea625c2a31123f005c` |
| `Redline-Wars-Linux-x64.AppImage` | 455283614 | `8aada7ad97f3514c2528e6dbaf332e6bfb273f863de9652a4b4a54f27851ef41` |
| `Redline-Wars-Linux-arm64.AppImage` | 455360383 | `14b9262830cbd0d83cfe4f55dce57a129a6ec7040a91ac21a9cca29cd74daa73` |
| `redline-node-linux-x64.zip` | 72357222 | `3cfccbf6e85381d54c976d67b2ce13a8bab1d53ce3b9508ab9f88033aef19a32` |
| `redline-node-linux-arm64.zip` | 69612766 | `559fea6e42741c0b468391284df82643cd1a9a9481aa895c0c94fb5abfd1217f` |
| `redline-node-win-x64.zip` | 108846870 | `34940f40def2131bf7a3347f484039a3c5e1e9556850cdde6abbac302d2382a3` |
| `redline-node-osx-arm64.zip` | 68179485 | `73e1ef73486b928b8528ac1174f0793b2f59de06b35636425956a3538e36f854` |
| `redline-node-osx-x64.zip` | 71370467 | `61169d58209722b1adf5030ca7351e5feea45277bf63095ee448b82f0a57a66b` |
| `SHA256SUMS` | 950 | `d86b5d0ddb65d16abc30b0e5735b8166c40261491feb1d2ffb16eec08d2a31ca` |

**Verification** (`--strict --sums SHA256SUMS --appbundle <the deploy's own AppBundle>`, 11 artifacts
and the live site against the built export): every artifact's sha256 equals its `SHA256SUMS` line;
the node-assembly commit is the release source; the shipped `build.json`s equal the export's build;
the node sources, the generated mod, the `web/src` files embedded in the source maps, the desktop
shell and the desktop payload equal the export's; the licence set and notices are complete. Two
findings fail the strict decision, both reproduced:

- **The node inventory is incomplete against its own packaging definition.** `node-manifest.json`
  lists `steelseed-host/generated/ra-trait-audit.json` and
  `steelseed-host/generated/ra-visual-manifest.json`; none of the five node zips — nor the desktop
  packages' internal node — carries them. This is the only strict FAIL common to all ten packages.
- **`redline-node-osx-arm64.zip` cannot host a room on Apple Silicon as shipped.** Its dedicated
  server (`bin-standalone/osx-arm64/OpenRA.Server`) is cross-built on the Linux CI runner and carries
  no code signature, so macOS kills it at exec (SIGKILL before any code runs) and every room dies at
  `dedicated exited`. With one local ad-hoc signature the packaged node passes the full two-client
  gate: room reserved, both clients connected, a hosted match to netframe 202, no desync, clean
  shutdown. The macOS desktop packages are built on the mac runner, are signed, and work; the osx-x64
  node's server runs under Rosetta (unsigned x86_64 is not killed), and its full path needs an Intel
  Mac, which was not available.

**Platform:** the macOS arm64 desktop app was run on macOS 15.6.1 (Apple M3 Pro): installed, launched
and torn down cleanly, WebGPU available, a rendered frame, no external host contacted. The menu/walk
flow passes on its own and the multiplayer flow passes on its own (a hosted match, no desync, no
orphan process); the combined run — multiplayer first, then the walk — fails: the walk screen never
shows after a hosted match, reproduced twice. The other platforms were not run.

### The browser game: play.redlinewars.online

**Verification: PASS** in strict mode, against the deploy's own AppBundle and the built export: the
live `composition.json` is the deploy's, every served script matches it, the 187 `web/src` files the
maps embed equal the export's, and every served `_framework` file equals the build's.

## v2026.09.26-39d2824

Source: [`v2026.09.26-39d2824`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-39d2824), exported from private commit
`39d28248300d`; `simBuild fd9882019bca` (unchanged).

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 451463850 | `0b885ae556580e61ddf1da38448df9dcf5d176a033c35726f3d3001f2bf1e9e2` |
| `Redline-Wars-macOS-arm64.zip` | 481678990 | `7dd37f47fa281396e0bd841368f1853189ebc3e71d657c2950354877b62b75cd` |
| `Redline-Wars-macOS-x64.zip` | 490456821 | `e23435acc7070f8b0b316fc20cf411ed248b4335f0977743b82cf03c54ddd3b4` |
| `Redline-Wars-Linux-x64.AppImage` | 447278885 | `d4c72f6485e020768eb3967ff89d1b7e6a844cd47f811a9dfa28d1922d9fdef3` |
| `Redline-Wars-Linux-arm64.AppImage` | 447355118 | `42b9d720d80247b9173770dad4b5a9b8432afcbaeb4c0e3c2b0d5b78409c3ac4` |
| `redline-node-linux-x64.zip` | 72353225 | `7f0757c03967385242b13bbf469fa057c79ffbef580e25afb96bb00edd8df0fd` |
| `redline-node-linux-arm64.zip` | 69608730 | `dd28654892d1d2b0581710bb68ba9ac4f415dbccd84ad2262616149d3719d676` |
| `redline-node-win-x64.zip` | 108842868 | `6f610a383c22183dd8289144335756d7d53636051f898e74b2067d662910b804` |
| `redline-node-osx-arm64.zip` | 68175481 | `1a24d3e643675260dabf628190ae8eef06fd0f7f2e733c1c122a7f5704afafa1` |
| `redline-node-osx-x64.zip` | 71366466 | `33f339a9c5884e14b30d3698301d3bd2116ff0ca5fe3972e94c58709a732d9a3` |
| `SHA256SUMS` | 950 | `fdce36c6c53c3eaa1646da97dcdc373feb65f7893dbb95e318e6f621c2a2fbfb` |

**Verification: PASS** in strict mode (`--strict --sums SHA256SUMS --appbundle <deploy run AppBundle>`), 11 artifacts against
`39d28248300d`. For each artifact:
- its sha256 equals the `SHA256SUMS` line;
- its `RELEASE-MANIFEST.json` names this tag and source commit, and the build's `simBuild`;
- every node source file equals the tag's;
- every `web/src` file embedded in the desktop apps' source maps equals the tag's;
- a desktop app's shell scripts and pages (`app.asar`) equal the tag's; the Windows installer's now do
  byte for byte, the line endings included;
- its AppBundle equals the deploy run's, file by file, and the WebAssembly runtime beside it too;
- the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries equal the tag's; the
  .NET runtime's own notices now ship as `licenses/DOTNET-THIRD-PARTY-NOTICES.txt`;
- a node zip carries no WebGPU client; a desktop app carries the AppBundle.

**Platform:** the macOS arm64 app started with `--selftest` on macOS 15.6.1 (Apple M3 Pro): booted in
32.9 s, WebGPU available, a rendered frame, no external host contacted. The other platforms were not run.
**Rebuild:** this tag builds with `tools/build.mjs`; the build is not compared byte for byte (not run).

### The browser game: play.redlinewars.online

The build is identified by `https://play.redlinewars.online/steelseed/composition.json`, which lists every
file with its sha256. Its sha256 is `d929220649aac0ee15122462206ce9ba6322b917a0d981c5872e0ba743e77ce5`, and it lists
1124 files. It equals the deploy run's AppBundle; its 16 source maps match it, and the 173 `web/src` files
they embed equal the tag's. The 282 WebAssembly runtime files it serves equal the build's.

## v2026.09.26-a87bf8d (replaced the same day by v2026.09.26-39d2824)

Source: [`v2026.09.26-a87bf8d`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-a87bf8d), exported from private commit
`a87bf8d2b1a2`; `simBuild fd9882019bca`.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 451965510 | `74f6725a67b231560ecca6e607934aa0eddf6d555caec6904b18ba23f616f8f2` |
| `Redline-Wars-macOS-arm64.zip` | 482103030 | `b70f0e45e68582349f4878bd0931000cc8ab18492c08665595be79a1b38f30ba` |
| `Redline-Wars-macOS-x64.zip` | 490880885 | `06acd52dd6e51c54117c10a67d9a4135871c5fde2d172d245f571002ae85fcb9` |
| `Redline-Wars-Linux-x64.AppImage` | 447681946 | `f79375d1080c27ff478d4b97a771b7ce97c4f1b542099223c3627a19643e97ba` |
| `Redline-Wars-Linux-arm64.AppImage` | 447758147 | `ed0d68c9160d4205bbb294dd6429280a2228002d4574f5134cca9aa0a0145c01` |
| `redline-node-linux-x64.zip` | 72353202 | `eff53d81ccdb2b47013c3ddbed9c4ec6fc7ad833393689085028eb5f1da385a5` |
| `redline-node-linux-arm64.zip` | 69608707 | `4829f7ee7f48a12d6fdd1a588b61bd57b1032aa7763befdd7033d2b8d8f16d1b` |
| `redline-node-win-x64.zip` | 108842845 | `a22f58e23ccbc9d1d30080a8712a6a1ee29248d0c33595f867e1516158b92e4c` |
| `redline-node-osx-arm64.zip` | 68175454 | `77f36d4b0624dd675c7368840a6809ab5b3f55923f4bbd6620ea003bf9b2a7dd` |
| `redline-node-osx-x64.zip` | 71366442 | `a93025c834b058c2380b38a1a286723ba6657f1c5d44f8c4c9f2a443963faf1e` |
| `SHA256SUMS` | 950 | `2b0369ba82873f67b70fbab8423a48c3c2682e9e8d64415e589ba6aaa071d361` |

**Verification: PASS** (`--sums SHA256SUMS --require-manifest`), for each artifact:
- its sha256 equals the `SHA256SUMS` line;
- its `RELEASE-MANIFEST.json` names this tag and source commit, and the build's `simBuild`;
- every node source file equals the tag's;
- every `web/src` file embedded in the desktop apps' source maps equals the tag's;
- the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries equal the tag's, and the
  third-party notices credit the engine and those libraries;
- a node zip carries no WebGPU client; a desktop app carries the AppBundle.

**Strict verification** (`--strict`, added after this release) also compares the desktop apps' shell. The
Windows installer's nine shell scripts equal the tag's except for their CRLF line endings, which the
Windows build machine's checkout added; later builds check out with LF endings.

### The browser game: play.redlinewars.online

The build is identified by `https://play.redlinewars.online/steelseed/composition.json`, which lists every
file with its sha256. Its sha256 is `25864f51c6d18bf979e849374913df51a7e0e1f37ec610f4b3d79763b9f8f087`, and it lists 1163 files.

**Verification: PASS** (`--appbundle`, with the deploy run's own AppBundle):
- the live `build.json` carries the tag's `simBuild` and `modHash`;
- all 17 scripts the site serves match the composition's hashes;
- the site does not serve its source maps; the deploy's AppBundle carries the identical
  `composition.json`, and its 16 maps embed 173 files of `web/src`, all equal to the tag's;
- every WebAssembly runtime file the site serves (`_framework/`, 282 files) is the build's;
- the GPL text, OpenRA's AUTHORS, the licences of the bundled libraries and the third-party notices are
  served under `steelseed/licenses/`.

## v2026.09.26-4c6da14 (replaced the same day by v2026.09.26-a87bf8d)

Source: [`v2026.09.26-4c6da14`](https://github.com/jolynstudios/redlinewars/tree/v2026.09.26-4c6da14), exported from private commit
`4c6da147cc10`; `simBuild fd9882019bca`.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 451966816 | `3116888a6bcdc18b5b9438d2858b57bc477877ecc11f641472a35e3b1f5228c8` |
| `Redline-Wars-macOS-arm64.zip` | 482101921 | `0f770ee7a9346caed57aebea028161d9e3b53f042330c6109ac3c93ec1afa4ff` |
| `Redline-Wars-macOS-x64.zip` | 490879804 | `84b0502f40308a815bee145415fefa6228791a832a883886a6f4bb66a397fb3b` |
| `Redline-Wars-Linux-x64.AppImage` | 447681774 | `b864c83a58e5ca568ddc9744aabbc1bf2df6187dea7a01738e11c9cea328f046` |
| `Redline-Wars-Linux-arm64.AppImage` | 447758040 | `2f5120eca61de9781c2b84d80b8675aba4a2a5d9363d5141471afd410fab8564` |
| `redline-node-linux-x64.zip` | 72353219 | `2dc1057cdcdfe897bc9761428fd0c8386b5e33bae722a5507da4029bc3d6b011` |
| `redline-node-linux-arm64.zip` | 69608722 | `8fa67254fe646dcc467c78ff604c172764582324d8d2b24a3c2a74da568d48e8` |
| `redline-node-win-x64.zip` | 108842853 | `0bda03ab98a92102513ad2cf5e5837986083dcf5ace470ce6c06a3240e6754d5` |
| `redline-node-osx-arm64.zip` | 68175472 | `524820cdc45800bf4e8725d6ac6f27219ce23a42e11bc1d5fa037c6a8679d5dc` |
| `redline-node-osx-x64.zip` | 71366464 | `cb6cff1de2851ec5247e30c361c3e585345cdde3666b8d78931b18fd9595386f` |
| `SHA256SUMS` | 950 | `b83575e4aa4461efd7ea80a9357c633e03d939c4fe3b9b40c8ddfee30d91bae6` |

**Verification: PASS** (`--sums SHA256SUMS --require-manifest`), for each artifact:
- its sha256 equals the `SHA256SUMS` line;
- its `RELEASE-MANIFEST.json` names this tag and source commit, and the build's `simBuild`;
- every node source file equals the tag's;
- every `web/src` file embedded in the desktop apps' source maps equals the tag's;
- the GPL text, OpenRA's AUTHORS and the licences of the bundled libraries equal the tag's, and the
  third-party notices credit the engine and those libraries;
- a node zip carries no WebGPU client; a desktop app carries the AppBundle.

### The browser game: play.redlinewars.online

The build is identified by `https://play.redlinewars.online/steelseed/composition.json`, which lists every
file with its sha256. Its sha256 is `784931b6b48e47c2081fa90a8d38f8408fa397ea8267db85e73f377264b61a3d`, and it lists 1163 files.

**Verification: PASS** (`--appbundle`, with the deploy run's own AppBundle):
- the live `build.json` carries the tag's `simBuild` and `modHash`;
- all 17 scripts the site serves match the composition's hashes;
- the site does not serve its source maps; the deploy's AppBundle carries the identical
  `composition.json`, and its 16 maps embed 173 files of `web/src`, all equal to the tag's;
- every WebAssembly runtime file the site serves (`_framework/`, 282 files) is the build's;
- the GPL text, OpenRA's AUTHORS, the licences of the bundled libraries and the third-party notices are
  served under `steelseed/licenses/`.

## Not distributed

- **`@steelthorn/node` (the npm node package):** not published to npm. It exists only as a CI artifact.
- **The art baseline:** the separately licensed art packs live in a private release; they hold no program
  code.
