# Releases

Every Redline Wars build distributed since the first tag, `v2026.09.26-4c6da14`, with the tag that holds its
source and how it was checked against that tag (`tools/verify-release.mjs`, on a clean checkout of the tag
built with `tools/build.mjs`). The builds distributed from 20 September 2026 until then have no tag; they are
recorded below, in [Before the first tag](#before-the-first-tag). The 28 September 2026 downloads went out
before their tag existed; the gap is recorded in
[v2026.09.28-ab47013](#v20260928-ab47013-the-downloads-of-28-september-2026), and that tag was published
with the release after it.

## v2026.09.30-a3367f1 — native Windows ZIP manifest reader (release candidate)

Source: private commit `a3367f1fb06c863b961b2ebcd56889ec5fa149bf`. Simulation build remains
`8a45d97ae0f6`; game and shell code is unchanged from the qualified fix candidate.
The Windows archive fixture in CI exposed that the Unix-oriented manifest reader did not recognize
its ZIP member. On Windows the packaging helper now reads ZIP manifests through the built-in .NET
archive API, normalizing member separators and decoding UTF-8, without installing a new tool.
The Unix archive listing also accepts CRLF. Real manifest, sidecar and missing-manifest assertions
remain intact; local targeted tests pass 13/13. The prior exact-commit run passed eight lanes and
failed Windows; its failure remains recorded rather than waived. Latest exact-commit CI and
production verification remain pending. No new audio/video is included.

## v2026.09.30-97ddee8 — coordinated release preparation (release candidate)

Source: private commit `97ddee8cdbc2ac79761b0ee98c177f0add2f2d40`, simulation build `8a45d97ae0f6`.
Game, shell and packaging sources are unchanged from the qualified `ecb69d1e` candidate.
The full-release API and relay jobs now wait for the shared AppBundle, GPU gates, all desktop
packages and signed Mac node archives before switching production backend versions. Partial
component releases retain their existing routes. Outcome tests prove failed, cancelled, skipped or
incomplete preparations block a full release. The Windows manifest test now creates its real ZIP
fixture using built-in PowerShell instead of depending on an absent `zip` executable; manifest,
archive and checksum assertions remain intact. Local targeted tests: 13/13, no skips.

Exact-commit CI and production artifact verification are pending; no successful live deployment
is claimed yet. Earlier failed CI runs and source tags remain preserved; no tag was moved.

## v2026.09.30-5a4a3fb — release CI catalog fix (release candidate)

Source: private commit `5a4a3fbb32d99f7491995ce89ad1beb3c2e62f79`. Game, shell and packaging sources
are byte-identical to the qualified `ecb69d1e` candidate below; only private `.github/workflows/ci.yml`
changes. A clean cross-platform CI checkout lacked the resolved RA catalog required by node
assembly. Both node-package lanes now explicitly export it before packaging, matching the existing
deployment build. No gate was bypassed. Failed CI run `36767792998` is retained; the corrected exact-
commit run must pass before production dispatch. Production installation and artifact hashes remain
pending. Simulation build remains `8a45d97ae0f6`.

## v2026.09.30-ecb69d1 — desktop/lobby fixes (release candidate)

Source: private commit `ecb69d1eecdabd9f0d547eca20cf845d578d55c0`, simulation build
`8a45d97ae0f6`, mod hash `f924d02e240281cb7718eea7125f9ea2335e012fe704ee7997066ff7aa03b81d`.
The corresponding source tag is published before binaries. Production installation and CI-built
artifact hashes are pending; no live-release verification is claimed in this entry yet.

Changes: observer-host administration without occupying a chair; clean lobby/session transitions;
one-click human and AI removal; consistent discovery; retained capacity and corrected Start rules;
server-validated administrator controls and Ready updates; inactive-administrator transfer;
ephemeral lobby chat; canonical engine build graph and URL handling; desktop Main-to-Skirmish cleanup.
New audio/video is excluded. The separate direct-connection experiment is not in this source tag.

Local qualification: 166 web, 121 hosting and 45 desktop tests, 23 engine lobby tests, 13 real lobby
test groups, Chromium/WebKit/Firefox paths, production-AOT ranked receipt and native replay verification,
and actual arm64 packaged UI. Existing strict cadence thresholds unchanged: all four measured profiles
pass (p50 8.3–9.4 ms, worst frame 17.6–18.3 ms), with no model fallbacks. This is measured-profile
evidence, not a universal hardware claim. Physical cross-device/network and Windows/Linux render
qualification remains outstanding; local Mac packages are ad-hoc signed, not notarized.

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

## v2026.09.30-9aad742 (the current release)

Exported from private commit `9aad742c`. Player-facing: the host's lobby finally works with AI.
A bot now takes its seat Ready the moment it enters — it has no player to press Ready, so the seat
itself must be — instead of sitting "Not ready" as the last blocker; the host can remove the AI it
added (`Remove AI` re-opens every bot's slot, which the server already treats as evicting the bot);
and the Start gate mirrors the server's own rule — at least one seated human and every required
seat filled, with bots counting toward filling — so a host alone with a table of AI can start the
match instead of waiting for a second human who never comes. Standing rooms now run with the
server's single-player switch on by default (a rooms-file entry may still pin `"solo": false`),
and player-created unranked rooms are created solo the same way; ranked rooms keep the two-human
rule — bots never settle a ranked match. `simBuild` moves (`92e9eeeec519` → `3fe0cba30479`): the
engine change lives in both trees and the lobby sync is network-visible, so client and node
releases move together — the game deploys first, then the node. Proven before release on a local
spine, a standing node and the real dedicated runner: join → bots Ready on entry → Start enabled
with one human + AI → Remove AI empties the table → re-add → start → the match ran 20 s with no
disconnect; the node suite is 125/125. The release head `9aad742c` carries two follow-ups over the
fix commit `127dd139` — the re-pinned Ranked E2E gate (`simBuild 3fe0cba30479`, signed settled
receipt and native replay verification, effective rules hash unchanged) and a withheld source-gate
test update — neither changes the published tree.

Published by deploy run `36717267918` (`components=all`, 30 September 2026 — the `simBuild` moved, so
the single-dispatch path carried every component together: the relay, the account API, the game node,
landing, the Ranked control plane, the shared AppBundle and the downloadables). The live site serves
build `3fe0cba30479`.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 458308201 | `d84a53207d5f7a6511400d5ab776b8e3e90ad0fc48096a61f4f92852b4bd20c1` |
| `Redline-Wars-macOS-arm64.zip` | 488543793 | `0b2d72e28ec8c5628e90ad6de1ece1853348ef6f705c161c0f3c67ab16b7f76c` |
| `Redline-Wars-macOS-x64.zip` | 497321635 | `e24163bbfa3982140a25c4505cce467edc1c6dc0cf353944cad8ea9ddb24058e` |
| `Redline-Wars-Linux-x64.AppImage` | 454183819 | `4fe59f672e869c8d026021aa0249aa5794db4d780aae722b6ef6479c789b6079` |
| `Redline-Wars-Linux-arm64.AppImage` | 454260327 | `f72758ceba1bd7ada95d2c1c805a9d8d383908d8a9ce24de50fd413a952fea9b` |
| `redline-node-linux-x64.zip` | 72765614 | `febee289e56628e6cd89b3ebf7dc75f70668f412eda41837c62ff1b48f0f0be6` |
| `redline-node-linux-arm64.zip` | 70021153 | `ca816af0f5af43082c39482ea97d056f4bf89cea50a94c67f0a7faa34a60625b` |
| `redline-node-win-x64.zip` | 109255248 | `12c11629ee3edfed624f2f581f293ea90e12b30bd040ca7c0a78fa029f5f3fa1` |
| `redline-node-osx-arm64.zip` | 68396635 | `3dd2bed5bbec719b66e98e4daef3544745444a7fe8c760426af2982a5805cc5d` |
| `redline-node-osx-x64.zip` | 71620551 | `d82711df93acc96fd598c40b6c71ba44c455ab1b42f0538d1015af2e92b6cfc4` |

**Verification: PASS** in strict mode, 30 September 2026 (`--strict --sums SHA256SUMS --appbundle
<the deploy run's own AppBundle>`, 10 artifacts and the live site against a clean `tools/build.mjs`
build of this tag, `simBuild 3fe0cba30479`, 223 checks): every artifact's sha256 equals its
`SHA256SUMS` line as mirrored; the five node zips pass their full inventory (218/218 first-party node
files, byte-equal sources), licences, notices and the no-client boundary; the five desktop packages
pass payload end to end — composition, 1234 presentation files, runtime, shell, notices and manifests
— against the run's own AppBundle, which is also exactly what the live site serves (a single-run
release: the split-run caveat of `v2026.09.29-7360ec1` cannot apply). The live site passes fully: the
served composition is the run's, its 19 scripts match, the 163 `web/src` files through the reference
maps equal the tag's, and the 284 `_framework` files equal the build's. Not run: `--rebuild` and
platform execution reports; the deploy's own macOS gates (signing, GPU gates, the packaged selftest)
ran green inside run `36717267918`.

## v2026.09.30-127dd13 (superseded by v2026.09.30-9aad742)

The export of the fix commit `127dd139` itself, tagged before the release head moved two
private-only follow-ups on (see `v2026.09.30-9aad742`, the current release, for the full
entry). The published tree is identical; nothing was distributed from this tag.

## v2026.09.30-1bdea0a (superseded by v2026.09.30-9aad742)

Exported from private commit `1bdea0ae`. Player-facing: joining a network room from the site on a
high-latency link failed every time — the join reached the server, the server accepted the handshake
and sent the lobby, and the client then reported `not connected` and hung up about half a second in.
The seat claim raced the server's first lobby sync: the engine marks the connection live the instant
its handshake validates, but the local player only becomes visible to the claim one engine tick
later, when that sync lands — on a nearby server the sync wins the race, on a distant one the claim
does, and the claim treated "not visible yet" as "not connected". The claim and the spectator path
now wait briefly for the sync instead of refusing; a real failure still fails through the existing
wording. The lobby's focus cue also stops throwing on browser-extension keydowns without a key.
`simBuild` is unchanged (`92e9eeeec519`); the engine and the network protocol are untouched. The
repair was proven against the live community room before release: the pre-fix client fails at
519 ms with `not connected`, the fixed client claims its seat, receives the lobby sync and holds
the connection.

Published by deploy runs `36696086584` (`components=game`, the live site now serving build
`92e9eeeec519` with the fix in the served hud chunk) and `36698057151` (`components=downloadables`).

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 458247326 | `eb7bec1dd658abe4987920ba44c130c26890abfe6225ba40acb31b20ad1cb239` |
| `Redline-Wars-macOS-arm64.zip` | 488541100 | `fde529a1e05b145dae7374a99258551a3faef8811ca6f337990405c3aba13e29` |
| `Redline-Wars-macOS-x64.zip` | 497318936 | `7914037317d710064cad1bd00ef342b787d0a9b990e4281277fb423a927728f6` |
| `Redline-Wars-Linux-x64.AppImage` | 454179840 | `6d24fa3eede8b7f53df14cc46a460708d9dd3adf7c4d0b5abc4438b4c3be6b3e` |
| `Redline-Wars-Linux-arm64.AppImage` | 454256586 | `b2ccbb3729477d06441d786a9b3a056620c5ab0b2ab1a010a53ec2f6a05d8ff6` |
| `redline-node-linux-x64.zip` | 72765375 | `a3d2755e72d7717ef033ee13807a65fd8023b6d1398d639dc72812896343f778` |
| `redline-node-linux-arm64.zip` | 70020886 | `9c1ce09603c1f2ccd0f011bcf2a18b901812efc637174e7bd5d5e10958e43dda` |
| `redline-node-win-x64.zip` | 109255003 | `1fa50d860f8dd13fab71083bf7a8140b2913afa79e49789e99c7963c5b18e943` |
| `redline-node-osx-arm64.zip` | 68396359 | `9990d4f6ec554c7f88d29a138e230044b3bf3d4b1810bc6a239fed076d272f26` |
| `redline-node-osx-x64.zip` | 71620265 | `ac2899920d9a99031db1031f54b751fb9acde6fd595c81617b01755ec90f52e2` |

**Verification: PASS** in strict mode, 30 September 2026 (`--strict --sums SHA256SUMS --appbundle
<the downloadables run's own AppBundle>`, 10 artifacts and the live site against a clean
`tools/build.mjs` build of this tag, `simBuild 92e9eeeec519`, itself verified byte-stamped against
the live `build.json` before the check): every artifact's sha256 equals its `SHA256SUMS` line as
mirrored; the five node zips pass their full inventory, licences, notices and the no-client
boundary; the five desktop packages pass payload end to end — composition, presentation files,
runtime, shell, notices and manifests — against the downloadables run's own AppBundle (the
split-run caveat of `v2026.09.29-7360ec1` applies unchanged: compare each desktop package with its
own run's AppBundle only). The live site passes fully: the served composition is the game deploy's,
its scripts match, the 163 `web/src` files through the reference maps equal the tag's, and the
284 `_framework` files equal the build's. The join repair itself was proven on the live site: a
headless client joined the community room, claimed a seat on the wire, received the lobby sync and
held the connection. Not run: `--rebuild` and platform execution reports; the deploy's own macOS
gates (signing, GPU gates, the packaged selftest) ran green inside run `36698057151`.

## v2026.09.30-27197e6 (superseded by v2026.09.30-1bdea0a)

Exported from private commit `27197e69`. Player-facing: the lobby counts seats, not people — the two
in-room lobby panels (the seat panel and the bottom-left player list) counted every connection, so a
host who opened a room without playing rendered as a player row, with faction/team/spawn selects no
server would honour, and the seat panel read "Players · 2" in a 2-seat room with one joiner, as if
the room were full; the room directory was already seat-only since `v2026.09.29-7360ec1`. Both
panels now follow the same seat rule everywhere else uses (`slot:none` is a spectator): observers
render as a `watching` row without controls, the headers count seated players and name the watchers
("Players · 1 · 1 watching"), and the admin's spawn reassignment deals to seated players only.
Community #1 grows with it: the standing-room example ships 5 seats on a rotation of maps with five
or more spawn points (Sudden Death, Unconventional Warfare, Doughnut) instead of 2 seats pinned to a
2-spawn map, which is why the community server advertised "2 players max"; the live server's rooms
file was moved to the same rotation the day this ships. `simBuild` is unchanged
(`92e9eeeec519`); the engine and the network protocol are untouched.

## v2026.09.29-7360ec1 (superseded by v2026.09.30-27197e6)

Exported from private commit `7360ec11`. Player-facing: rooms now count seats, not connections — a
dedicated server reports a lobby census (`STEELSEED_ROOM seated/observers/slots/map`) from every
seat-relevant lobby sync in both engine trees, so a creator who opens a room without playing shows as
0/N in the directory while a real joiner counts 1/N; and a community room's host (the admin) can
change map and seat count live from a host panel, unranked rooms widen their map pool to the stamped
catalog while ranked keeps its pin, and the seat ceiling stays 5. The near-miss this tag also fixes:
the shipping pipeline could leave the browser bundle's embedded mod stamp one sim build behind the
servers (a forced `dotnet publish` alone skips the packing when its incremental link is up to date),
which every server answered with "Not running the same version" — `web/tools/ship.mjs` now re-publishes
on stamp drift and re-syncs the AppBundle support files plus their `blazor.boot.json` hashes, and the
ranked end-to-end match that caught it passes again (pins regenerated to sim build `92e9eeeec519`).

Published by deploy runs `36637559151` (`components=all` — relay, node, landing, ranked control plane
and the AppBundle, all jobs green including the macOS GPU gates) and `36642911170`
(`components=downloadables`, after this source tag was pushed). The ten packages and `SHA256SUMS` are
on the `latest` release and mirrored at `/downloads/`; the deploy verified the mirror with
`sha256sum -c` and the live site serves build `92e9eeeec519` (`build.json`, the relay's
`acceptedBuilds`, and the host-control symbols in the HUD chunk). **Verification: PASS** in strict mode, 30 September
2026 (`--strict --sums SHA256SUMS`, 10 artifacts and the live site, against a clean `tools/build.mjs`
build of this tag, `simBuild 92e9eeeec519`): every artifact's sha256 equals its `SHA256SUMS` line;
the five node zips pass their full inventory, licences, notices and the no-client boundary; the five
desktop packages pass payload end to end — composition, 1234 presentation files, the 301 runtime
files, shell, notices and manifests — and the live site passes fully (composition, 19 served
scripts, 163 `web/src` files through the reference maps, 284 `_framework` files).

One property of the publishing split, recorded for the next verification: the game deploy
(`36637559151`) and the downloadables run (`36642911170`) each built its own shared AppBundle from
the same commit `7360ec112e8c`, and the two agree byte for byte on every emitted `.js` — the
shipped code is deterministic — but four source maps differ between the runs (`steelseed-audio`,
`-hud`, `-materials`, `-units`), the chunks that embed the art packs. The desktop packages are
consistent with their own run's AppBundle (they pass strict against it) and the desktop filter does
not ship those maps; the strict check fails only when a desktop package is compared against the
*other* run's AppBundle. A single-run release, like `v2026.09.29-a2b7ac6`, cannot hit this.

## v2026.09.29-a2b7ac6 (superseded by v2026.09.29-7360ec1)

Exported from private commit `a2b7ac68`, one commit past `v2026.09.28-2df2ad8` after its strict check
failed; every owner-asked change of that tag rides here unchanged, and the one repair is in the
packaging itself. The logo: the R is optically centred in its red slab (translated by 12.4/10.9) and
the wordmark rebalanced so both gaps beside the plate measure the same 97.4 px — presentation
transforms only, on every published sprite (game header, landing brand and favicons, desktop build
icons); the `brand/` originals are untouched. The desktop app icons are regenerated from that fixed
mark — every iconset size, `icon.png`, `icon.icns` and `icon.ico` rebuilt and round-trip checked,
pixel-measured at 1024: the R sits at margins 132/133 (left/right) and 124/124 (top/bottom) inside
the slab, where the previous binaries read 22 px left and 19 px high of centre. The desktop app menu:
dev mode reported "Electron" into the Apple menu and the About panel; `app.setName` plus an explicitly
built app menu (Dutch labels) fix the name, and "Spel afsluiten" sits at the bottom of that menu,
routed through the before-quit guard. The landing's "Why this exists" background: the CC BY 2.0
Suriname aerial photo is replaced by Jolyn Studios' own generated artwork — a deterministic seeded
cold-dusk landscape (snowy far range, layered forested ridges, dark fir foreground), 1600×1071 webp
at 36 KB — and every credit for the old photo is gone from the caption, footer, credits page and
`THIRD_PARTY_NOTICES.md`; grep finds no remaining reference.

The repair: `desktop/package.mjs`'s bundle filter, which `a8bf17ae` had widened to `!**/*.map` to keep
the client's sourcesContent out of the installers, also stripped `_framework/dotnet.js.map` and
`dotnet.runtime.js.map` — the .NET runtime's own maps, which carry no withheld source. The strict
verifier holds every file outside `steelseed/` to the reference AppBundle byte for byte, so all five
desktop packages of the previous tag failed on exactly those two files. The filter now names the
presentation bundle only; the runtime ships whole again.

Published by deploy run `36490732257` (dispatched 00:09 CEST on 29 September 2026, `components=all`,
landing included). The packaged mac app proves the desktop work: the bundle identity reads
`Redline Wars` (CFBundleName, CFBundleDisplayName, CFBundleExecutable — the Apple menu and About
panel no longer say Electron), the app menu in the shipped `app.asar` ends in "Spel afsluiten" after
the Dutch hide/unhide entries, the shipped `icon.icns` is byte-equal to the regenerated centred mark,
and the shipped AppBundle carries `_framework/dotnet.js.map` and `dotnet.runtime.js.map` again.

### Downloads: www.redlinewars.online/downloads

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 458227869 | `e16a6d5d5b1a33a7b84a938a77c193623a4a31e18b8f54dcd034af0969740106` |
| `Redline-Wars-macOS-arm64.zip` | 488538817 | `b726a2bac3b3bb9a1b3798525071e44fc405cf8af5cc44278fb7692da3ae88fc` |
| `Redline-Wars-macOS-x64.zip` | 497316661 | `7231b66003fe08dc37860e03157a3dd3b824b520711fbbe1fa3b58849db18aa4` |
| `Redline-Wars-Linux-x64.AppImage` | 454184333 | `65a9f358a3eee4bbfe8b38819df9074dff6afb1cd8c30ab8d949669ec3c3de2d` |
| `Redline-Wars-Linux-arm64.AppImage` | 454261335 | `d04fcd808fd2801fdaa1728f5236a0e77d98cbcea5595368344fb135b53fa057` |
| `redline-node-linux-x64.zip` | 72759330 | `9aa0a3b4b5fde53c4401f993e796112fb9f20d5e615369c859de63c984f5d97c` |
| `redline-node-linux-arm64.zip` | 70014861 | `347c7ee74a55cd95073aeeaea80da6617d67ab538f78b994771723477c8f1782` |
| `redline-node-win-x64.zip` | 109248945 | `52cb63adcc26e3f64b0499abfa81ecc746484d2936a05cc0eaabc91b776aabe1` |
| `redline-node-osx-arm64.zip` | 68390791 | `c0baef3db2dca7b32aa7c1bc6a1a3802f906f0ce0cee3e8d8bc6d8cd1105cd2b` |
| `redline-node-osx-x64.zip` | 71614718 | `bb947c4e9821788da659270c1185182f39c426ac4d3e0768c478803aa3dfc57d` |

**Verification: PASS** in strict mode (`--strict --sums SHA256SUMS --appbundle <the deploy's own
AppBundle>`, 11 artifacts and the live site against a clean `tools/build.mjs` build of this tag,
`simBuild 7e45c0e93135`): every artifact's sha256 equals its `SHA256SUMS` line; each
`RELEASE-MANIFEST.json` names this tag and source commit `a2b7ac683d19`; the five node zips pass
their full inventory (218/218 node files byte-equal, licences, notices, no WebGPU client); the five
desktop packages pass payload end to end — composition equal to the reference, 1234 presentation
files present and equal, the 18 client source maps intentionally absent, and the runtime beside
`steelseed/` byte-equal to the reference (the two restored `_framework` maps included); the shell and
`app.asar` pages equal the tag's; 163 `web/src` files embedded in the reference's 18 source maps equal
the tag's; the licence set and notices are complete on every artifact. The live site passes fully:
the served composition is the deploy's, its scripts match, the 284 served `_framework` files equal
the build's, and the licences are served. Not run: a rebuild comparison (`--rebuild`) and platform
execution reports; the deploy's own macOS gates (signing, gpu gates, the packaged selftest) ran green
inside run `36490732257`.

## v2026.09.28-2df2ad8 (superseded by v2026.09.29-a2b7ac6; its downloads were live for about forty minutes)

Exported from private commit `2df2ad82`, superseding `v2026.09.28-a7bcd14` the same night. Deployed by
run `36487582363` (dispatched 23:39 CEST on 28 September 2026, `components=all`); its downloads replaced
the `aa02032` set at about 00:00 CEST on 29 September and were themselves replaced by
`v2026.09.29-a2b7ac6` at about 01:00. The owner-asked changes it carried are described under the tag
that supersedes it, unchanged. The packaged mac app proves the desktop work end to end: the bundle
identity reads `Redline Wars` (CFBundleName, CFBundleDisplayName, CFBundleExecutable — the Apple menu
and About panel no longer say Electron), the app menu in the shipped `app.asar` ends in
"Spel afsluiten" after the Dutch hide/unhide entries, and the shipped `icon.icns` is byte-equal to the
regenerated centred mark.

**Verification** (`--strict --sums SHA256SUMS --appbundle <the deploy's own AppBundle>`, 11 artifacts
and the live site against a clean build of this tag): all eleven hashes match `SHA256SUMS`; the five
node zips pass everything (218/218 inventoried node files byte-equal, notices, manifests, boundaries);
the live site passes fully (composition, served scripts, 163 embedded `web/src` files, 284 `_framework`
files). The five desktop packages fail strict in one way each: the payload check finds
`_framework/dotnet.js.map` and `_framework/dotnet.runtime.js.map` missing from the shipped AppBundle —
the packaging filter defect that `v2026.09.29-a2b7ac6` repairs. Integrity, notices, manifests, shell,
client-source correspondence (163 files through the reference maps) and the composition all pass on
every artifact.

### Downloads: www.redlinewars.online/downloads (published 29 September 2026, ~00:00–01:00 CEST)

| Artifact | Bytes | sha256 |
|---|---:|---|
| `Redline-Wars-Windows-x64-Setup.exe` | 458122712 | `9e54352fbde68a19e39d11be236af60fa24780b911b0cbff30fa356955fea547` |
| `Redline-Wars-macOS-arm64.zip` | 488419097 | `9b12a39c42d280bd99a0e1a35499be31a8604b0f68e11842a45dcd62970026a6` |
| `Redline-Wars-macOS-x64.zip` | 497196945 | `d5920a719a7961e92eae9928370b94ca9fb2f3654d702cd0f7415a3c8beaa26c` |
| `Redline-Wars-Linux-x64.AppImage` | 454065468 | `ed7938e56ad2c134cef4e57be7df38384efabfc4c6fbcb87d2b148c90b19c20a` |
| `Redline-Wars-Linux-arm64.AppImage` | 454142380 | `0958f12278b6a9392e22977275e35ddb06b0b3da354ec7ff59168783a094bc46` |
| `redline-node-linux-x64.zip` | 72759328 | `bf5d6dd40ab20bbe0081766e5015cc8755dd75904f7dfb360504807901cb4dbb` |
| `redline-node-linux-arm64.zip` | 70014859 | `0f77d69249773a65aa6ec9a67f1084ded096795924b8e92729f526942e7135be` |
| `redline-node-win-x64.zip` | 109248944 | `46ce83ba659430edcf54cf773c70fd14dfff7c765269f881b782d356e73db597` |
| `redline-node-osx-arm64.zip` | 68390793 | `6b45672d7ccb0df8660126021de3987dc3f13197fb73dd213a461db6d6fdc9e6` |
| `redline-node-osx-x64.zip` | 71614723 | `941d25587d24bcc8cc4301aa6e237e248b34f3c9e6041838eb7a13ba6d456d74` |

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
