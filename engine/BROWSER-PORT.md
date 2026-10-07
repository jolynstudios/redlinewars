# Browser (WebAssembly) port — code boundary manifest

This branch (`wasm-port`) carries the OpenRA → browser port. The canonical working
checkout for port development is the sibling repository **`../OpenRA-Web`**; this
checkout stays parked on upstream `bleed` as a pristine reference. Everything the
port adds or changes is inventoried mechanically by:

```sh
git diff aa834e93901214958e2f0506838893400aae7066..wasm-port --stat
```

Upstream base: `aa834e9390` (bleed, 2026-07). Rule of the port: **no browser
conditionals in core gameplay code** — the engine gains capability seams
(`Platform.SupportsThreads`, factories, pumps) that stay desktop-neutral; anything
browser-specific lives in the port-owned projects below.

## Port-owned code (entirely new)

| Path | What it is |
|---|---|
| `OpenRA.Browser/` | wasm host app: boot modes (`rules`/`game`/`fontsmoke`), dev content intake, rAF pump, tick telemetry, JS probes; `wwwroot/` incl. the S3 WebGL2+shroud and S4 audio gate pages |
| `OpenRA.Platforms.Browser/` | browser platform backend (`IPlatform`): NullPlatform (headless/CI) and the WebGL2 backend as it lands |
| `OpenRA.Test/OpenRA.Game/GameStepperTest.cs` | scheduler decision coverage |
| `OpenRA.Test/OpenRA.Game/InMemoryConnectionTest.cs` | golden wire-framing coverage |
| `OpenRA.Test/OpenRA.Game/ReplayDeterminismTest.cs` | fixed-seed TCP↔in-memory sync-hash comparison (explicit) |
| `OpenRA.Test/FontMetrics/` | standalone FreeType↔StbTrueTypeSharp corpus tool |
| `OpenRA.Browser/tests/` | Playwright regression harness (chromium/firefox/webkit) + the node static server used for local serving |
| `Makefile` targets `browser`, `check-browser`, `serve-browser`, `devcontent-link`, `test-browser*` | build/serve/test the wasm bundle |

## Engine seams (small, desktop-neutral, upstream candidates)

- `OpenRA.Game/Platform.cs` — `Platform.SupportsThreads`; browser early-out in OS detection
- `OpenRA.Game/GameStepper.cs` (new) + `Game.cs` `Loop()` — scheduling extracted into a pure, tested stepper; desktop loop behavior unchanged
- `OpenRA.Game/Game.cs` — `PlatformFactory`, `InitializeHosted`, `State`, in-process server wiring, LOH-compaction guard
- `OpenRA.Game/Server/Server.cs` + `Server/Connection.cs` — cooperative (thread-free, socket-free) server mode: `Step()`, `ConnectInMemoryClient()`, optional fixed seed
- `OpenRA.Game/Network/Connection.cs` + `Network/InMemoryLink.cs` (new) — `NetworkConnection` transport split: `TcpNetworkConnection` / `InMemoryNetworkConnection`, byte-identical framing
- `OpenRA.Game/Network/WebSocketConnection.cs` (new) — third `NetworkConnection` transport (a browser client's path to a desktop server through a WebSocket↔TCP relay); uses only the existing `PumpTransport`/`SendBytes`/`DisposeTransport` seam and `ClientWebSocket` (desktop-.NET compatible); `WsFrameAssembler` reassembles the length-prefixed server stream across WS message boundaries. Inert until a client selects it.
- `OpenRA.Game/Game.cs` — `ConnectionFactory` hook consulted in `JoinServer` (mirrors the `PlatformFactory` precedent); null on desktop
- `OpenRA.Game/Game.cs` + `Network/UnitOrders.cs` — `HandshakeModOverride` / `HandshakeVersionOverride` (null default): let a browser client present a target build's mod/version in the handshake so it can join OTHER (upstream) OpenRA servers. Toggled off unless the host sets `Host.ModId` / `Host.ModVersion`; desktop and native browser behaviour are byte-unchanged (`?? mod.Id` / `?? mod.Metadata.Version`), and `OrdersProtocol` is untouched. **Handshake-only**: a playable cross-build match still requires the browser built rules/sim-compatible with the target release (our port changes zero gameplay, so this is build-alignment, not code); a mismatch is caught by OpenRA's normal sync hashes and reported as an out-of-sync game, never silent corruption. Verified by `tests/p9-handshake.mjs` (matching version accepted, bogus version rejected).
- `OpenRA.Game/Network/ConnectionTarget.cs` — `FirstEndpoint` accessor so the host can build a `ws://` URI without DNS resolution or `ToString` parsing (IPv6-safe); desktop-neutral
- `OpenRA.Game/Settings.cs` — `Debug.InProcessServer`, `Debug.ServerRandomSeed`
- `OpenRA.Game/ObjectCreator.cs` — `RegisterAssembly` (hosts without disk-loadable assemblies)
- `OpenRA.Game/Support/Log.cs`, `GameRules/Ruleset.cs`, `Map/MapDirectoryTracker.cs` — threadless/browser guards
- `OpenRA.Game/Map/MapCache.cs` — minimap preview generation honors `Platform.SupportsThreads`: desktop keeps the existing threaded loader; threadless hosts drain a coalesced preview queue one map per `RunAfterTick` (deterministic, non-blocking — the graphical Skirmish lobby previously threw `PlatformNotSupportedException` in the browser)
- `OpenRA.Mods.Common/DiscordService.cs` — named-pipe guard
- `OpenRA.Game/Properties/AssemblyInfo.cs` (new) — `InternalsVisibleTo` for tests and the host
- Analyzer suppressions: `FieldLoader.cs` (IDE0301), `OpenRA.Utility/Program.cs` (CA1064)

## Assets — legal boundary (verified)

Two distinct asset classes, and the port keeps them strictly separated.

**1. OpenRA's own content — free, ships in the bundle.** The engine, mod rules
(MiniYAML), and OpenRA's own authored artwork (UI chrome, cursors, some sprites,
ambient/notification audio in `mods/*/bits/` and `mods/*/maps/`, small tilesets)
are GPL/CC-licensed by the OpenRA project. This port **modified none of it** —
`git diff aa834e93..wasm-port -- '*.mix' '*.aud' '*.shp' '*.vqa' '*.wav'` is
empty, so the ~3 MB of committed content is byte-for-byte upstream OpenRA's
published footing. `mods/ra-content/installer/` holds only freeware *installer
definitions* (mirror URLs like `openra.net/packages/ra-base-mirrors.txt`), not
content.

**2. Westwood/EA's Red Alert content — freeware, NEVER committed or bundled.**
The ~20 MB of original game data the player actually sees (unit sprites, EVA
voice lines, music, the `allies.mix`/`conquer.mix`/… packages) is EA's
copyright, released as *freeware* for personal download-and-play in 2008 — free
to install and play, **not** public domain, GPL, or cleared for a commercial web
service to host/stream. It is gitignored under `Support/Content/ra/v2`, fetched
at runtime (`FetchDevContent`, gated on `Host.BaseUrl`, dev-only), and lives only
in the browser VFS. It is **not** in `bin-browser/AppBundle` (0 EA `.mix`
packages in the deployable) and never in git.

**The one open legal decision — public deployment content delivery.** Hosting
EA's freeware assets from your own (possibly commercial) domain is untested and
the flagged risk. The local `devcontent` route is dev-only and must not be the
production path. Safe options, cleanest first:
- **Public demo on openly-licensed content** (an OpenHV-style free content mod)
  with Red Alert kept as **user-supplied** content — engine + branding are
  unencumbered, only EA assets carry the constraint, so this is fully in the
  clear.
- **User-supplied**: the player provides their own freeware files (upload / local
  pick), mirroring desktop OpenRA's install-it-yourself model.
- **Fetch from the freeware mirrors at runtime** like desktop OpenRA (CORS
  permitting) — closest to upstream, but "we serve it" is the part to get advice
  on before shipping.

Bottom line: the repo and every deployable are on the **same asset footing as
upstream OpenRA** and carry **no EA content**; the only thing to decide before a
public launch is which of the above content-delivery paths to offer.

### First-run auto-installer (`BrowserContentInstaller`)

`OpenRA.Browser/BrowserContentInstaller.cs` + `wwwroot/openra-content.js` install
the freeware on first run and cache it, so the content path is "install once,
forget". It fetches the upstream **quick-install** archive (base + Aftermath +
desert — all three are `Required`) from a configurable `Host.ContentSource`
(no default mirror is embedded — the source is a deployment knob), verifies it
against the checksum + path allowlist read from the bundled
`mods/ra-content/installer/downloads.yaml`, and extracts only the allowlisted
paths with zip-bomb/traversal/encryption guards into a staged dir that atomically
swaps into `/openra/user/Content/ra/v2`, flushed to IndexedDB before init. Boot
priority: restored content → `Host.ContentSource` auto-install → dev `devcontent`
fallback. With no resolvable source, `openra-content.js` prompts for the archive
with a file picker and feeds the selected blob through the identical verifier.
Verified end-to-end (`tests/p8-install.mjs`, `tests/p8-picker.mjs`): both the
same-origin auto-install and the picker/blob fallback install 39 files, boot into
a playable skirmish, and reload with zero content refetch. Because CORS blocks
the real freeware zip mirrors, a public auto-install needs a CORS-enabled source
(thin relay or same-origin) — the picker fallback needs none.

## Browser test harness

`OpenRA.Browser/tests/` holds a Playwright suite that drives the published bundle
in real browser engines. One-time setup, then the day-to-day loop:

```sh
make test-browser-install   # npm install + playwright browser downloads
make test-browser           # publish + relink devcontent + run the suite on chromium
make test-browser-all       # same, on chromium + firefox + webkit
```

### Browser support matrix (interpreted dev build)

| Engine | Boot | Render | Input | Audio | Persistence | Determinism oracle |
|---|---|---|---|---|---|---|
| Chromium | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (~37s) |
| WebKit / Safari | ✓ (9.6s) | ✓ | ✓ | ✓ | — | chromium-only |
| Firefox | ✓ (slow, ~70s) | ✓ | ✓ | ✓ | ✓ | too slow (interpreted) |

All three engines boot, render, take mouse/keyboard input, and play audio. The
determinism oracle (a 200-frame replay) is scoped to Chromium — interpreted wasm
on Firefox can't finish it inside the test budget; the shipping AOT config would.
Firefox boot is markedly slower than Chromium/WebKit under the interpreter.

`make devcontent-link` re-creates the `bin-browser/AppBundle/devcontent` symlink
after every publish (publishing can recreate `AppBundle`); the suite fails with a
clear error if `Support/Content/ra/v2` has not been populated. Specs assert
through the `globalThis.ora` probe exports (`Program.cs` product exports plus the
test-only probes in `Program.Probes.cs`) and through element screenshots of the
canvas — `preserveDrawingBuffer: false` means pixels must be captured from the
compositor, never via `readPixels` after present.

## Desktop-vs-wasm determinism oracle

Cross-runtime lockstep safety is proven by recording the *same* fixed-seed solo
game on desktop and in the browser and comparing the replay streams offline,
frame by frame (orders and sync hashes) — replays contain orders only, never
game assets, so the fixtures are committable.

```sh
# 1. Desktop half (fixtures/oracle-desktop.orarep): run ~2 minutes, then quit.
./launch-game.sh Game.Mod=ra Launch.Map=Siberian-Pass.oramap \
  Debug.ServerRandomSeed=424242 Player.Name=Commander \
  Engine.SupportDir=/tmp/oracle-support   # fresh dir + Content/ra/v2 link, so
                                          # local settings cannot skew options

# 2. Browser half (fixtures/oracle-browser.orarep): same map/seed/name.
cd OpenRA.Browser/tests && node tools/record-oracle.mjs --frames 200

# 3. Compare (both halves must be >= OPENRA_DETERMINISM_FRAMES frames):
OPENRA_DESKTOP_REPLAY=OpenRA.Browser/tests/fixtures/oracle-desktop.orarep \
OPENRA_BROWSER_REPLAY=OpenRA.Browser/tests/fixtures/oracle-browser.orarep \
OPENRA_RANDOM_SEED=424242 OPENRA_DETERMINISM_FRAMES=200 \
dotnet test bin/OpenRA.Test.dll --test-adapter-path:. \
  --filter "FullyQualifiedName~DesktopAndBrowserReplays"
```

A mismatch is a lockstep-desync bug in the wasm runtime portability layer and
blocks all multiplayer work until diagnosed (enable `Debug.EnableSyncReports`).
