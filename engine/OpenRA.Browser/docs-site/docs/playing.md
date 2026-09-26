---
sidebar_position: 3
title: Playing locally
description: Build, serve, supply Red Alert content, launch games, and use browser-host URL parameters.
---

# Playing locally

The shortest path is one browser publish, one static server, and one URL. Run the commands from the repository root.

## Prerequisites

- .NET 8 SDK
- the .NET WebAssembly workload: `dotnet workload install wasm-tools`
- Node.js, used by the small static server
- a browser with WebGL2; Chromium is the primary acceptance target
- the OpenRA Red Alert quick-install archive, or an already populated `Support/Content/ra/v2`

The repository and published bundle intentionally contain no EA/Westwood game assets.

## Build, serve, open

```sh
make browser
node OpenRA.Browser/tests/server.mjs \
  --root bin-browser/AppBundle --port 8331
```

Then open:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2
```

`make serve-browser` is the combined build-and-serve convenience target; it uses
port 8321, which the automated harness also reserves. Port 8331 keeps manual
sessions separate from test runs.

On first run, one of three things happens:

1. previously installed content is restored from IndexedDB;
2. local development content is served from `Support/Content/ra/v2`; or
3. the page asks you to choose the OpenRA quick-install ZIP.

The installer verifies the archive and saves the allowed files before reloading. A deployment can instead set `Host.ContentSource` to a reviewed, CORS-accessible source. Do not treat the local `/devcontent/` route as a public deployment design.

## Controls and browser behavior

OpenRA's **Modern** control style is the default: select with left click and issue contextual commands with right click. Keyboard shortcuts and the normal in-game settings UI work. Your first click or key gesture unlocks audio, as required by browser autoplay policy.

The canvas fills the available viewport and chooses its render-buffer size at boot. If the browser window changes size, reload to rebuild the surface at the new dimensions. The **Debug** button exposes the boot and tick log without covering normal play when closed.

Settings and recorded replays are synchronized into IndexedDB periodically, when the page is hidden, and when it is closed. Clearing site data removes that browser-side support directory, including installed content.

## Useful launch URLs

Open the menu:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2
```

Launch a known non-Lua map directly:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2&Launch.Map=Siberian-Pass.oramap
```

Open the Agent-vs-Agent setup and spectator layout:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2&Host.AgentMode=1&Launch.Map=Siberian-Pass.oramap
```

Agent mode also needs the local sidecar. Follow [Battle your model](./battle-your-model) for the complete three-command path. Never put OpenRouter keys in a URL.

## URL parameter reference

`main.js` converts query parameters into OpenRA launch arguments. The two short browser parameters become host arguments; all other entries pass through as `Key=Value`.

| Parameter | Purpose |
| --- | --- |
| `mode=game` | Run the game. The default `rules` mode is an internal rules-loading spike, not the playable UI. |
| `platform=webgl2` | Use the visible browser platform. The default `null` platform is for headless probes. |
| `Launch.Map=<uid>` | Skip the menu and load a map directly. Use only maps that do not require Lua. |
| `Player.Name=<name>` | Set the normal OpenRA player name. |
| `Host.AgentMode=1` | Load the agent rules overlay and operator UI. This changes the rules checksum and requires a page reload to enter or leave. |
| `Host.ContentSource=<url>` | Install the verified Red Alert quick-install archive from a controlled source when no content is cached. |
| `Host.WsEndpoint=ws://…` | Send multiplayer traffic to an explicit WebSocket relay endpoint. |
| `Host.WsScheme=ws` or `wss` | Choose the scheme used when deriving a WebSocket endpoint from the normal server address. |
| `Host.ModId=<id>` / `Host.ModVersion=<version>` | Override handshake identity for compatibility testing. This does not make mismatched builds safe. |
| `Host.Explored=1` | Development/testing option that starts exported skirmishes explored and without fog. Do not use it for normal or benchmark play. |
| `Debug.ServerRandomSeed=<n>` | Fix the local-server seed for a reproducible test run. |

## Multiplayer bridge

Start or identify a compatible desktop OpenRA server, then run the fixed-target relay in another terminal:

```sh
make ws-relay LISTEN=127.0.0.1:8322 TARGET=127.0.0.1:1234
```

Open the browser with the relay selected:

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2&Host.WsEndpoint=ws://127.0.0.1:8322
```

Use the normal multiplayer UI to join the server. The relay binds to loopback by default and forwards to one configured TCP target; it is not an open proxy. For a hosted HTTPS page, use a secured `wss://` endpoint and an intentionally deployed bridge.

:::caution Before troubleshooting a match

Campaign missions and other Lua-scripted maps cannot run in this build. Multiplayer peers must use simulation-compatible rules. Resize and WebGL context-loss recovery require a reload. See [The browser port](./the-port) for the full limitations and support matrix.

:::

## Development checks

The narrow browser compile check is:

```sh
make check-browser
```

The Playwright suite needs a one-time browser install and then publishes its own bundle:

```sh
make test-browser-install
make test-browser
```

Use `make test-browser-all` to exercise Chromium, Firefox, and WebKit. The cross-runtime determinism oracle remains scoped to Chromium because interpreted Firefox cannot complete it within the present test budget.
