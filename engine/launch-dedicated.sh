#!/bin/sh
# Dedicated server launcher for local multiplayer testing.
# legacy: used only by mp-twoclient/mp-shroudgate until T1.30.
#
# Mirrors upstream OpenRA's launch-dedicated.sh, adapted to this tree:
#   - resolves the engine dir from the script location (engine/),
#   - locates dotnet (PATH first, then $HOME/.dotnet),
#   - builds OpenRA.Server once if bin/OpenRA.Server.dll is missing,
#   - maps the env contract the test drivers use
#     (Name, Map, ListenPort, EnableSyncReports, EnableSingleplayer, Mod,
#     AdvertiseOnline) onto Server.* / Game.Mod launch arguments.
#
# The legacy mp test stack (issues/net-1, mp-* drivers, multiplayer.spec.ts)
# runs mod `steelseed` (engine/mods/steelseed, in-memory generated maps), so
# that is the default. The shipping wasm host instead runs the GENERATED
# assetless `ra` mod (steelseed-host/generated/mods/ra); pass Mod=ra and the
# launcher generates that mod via tools/build-ra-mod.mjs.
#
# MOD_SEARCH_PATHS is always exported ABSOLUTE: Platform.ResolvePath treats
# relative paths as relative to bin/, not the process cwd, so a bare "."
# Engine.EngineDir would make the default `./mods` search path miss.
#
# The specs spawn `sh launch-dedicated.sh` and kill the process GROUP, so the
# dotnet child must stay a direct child of this script; do not background it
# here. The C# side already restarts server instances between games; the shell
# loop below only guards process crashes.
#
# Readiness: this fork binds the listen socket AFTER ModData and the map
# catalog load (OpenRA.Server/Program.cs `new Server(...)`), so a successful
# TCP connect to ListenPort means the lobby is ready for joins. There are no
# upstream-style "Master server communication established" log lines here;
# the server log channel writes to dedicated-server.log, not stdout.

set -u

ENGINE_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ENGINE_DIR"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
    arm64)  HOST_ARCH="osx-arm64" ;;
    x86_64) HOST_ARCH="osx-x64" ;;
esac
BUNDLED_APPHOST="bin-standalone/$HOST_ARCH/OpenRA.Server"
if [ -x "$BUNDLED_APPHOST" ]; then
    # Packaged node: a self-contained .NET runtime ships inside the bundle.
    SERVER_RUNNER() { "$ENGINE_DIR/$BUNDLED_APPHOST" "$@"; }
else
    if command -v dotnet >/dev/null 2>&1; then
        DOTNET=dotnet
    elif [ -x "$HOME/.dotnet/dotnet" ]; then
        DOTNET="$HOME/.dotnet/dotnet"
    else
        echo "launch-dedicated: dotnet not found (PATH or \$HOME/.dotnet)" >&2
        exit 1
    fi
    if [ ! -f bin/OpenRA.Server.dll ]; then
        echo "launch-dedicated: bin/OpenRA.Server.dll missing, building..." >&2
        "$DOTNET" build OpenRA.Server/OpenRA.Server.csproj -c Release -nologo || exit 1
    fi
    SERVER_RUNNER() { "$DOTNET" bin/OpenRA.Server.dll "$@"; }
fi


MOD_ID="${Mod:-steelseed}"
RA_MOD_DIR="$ENGINE_DIR/steelseed-host/generated/mods/ra"
if [ "$MOD_ID" = "ra" ]; then
    if [ ! -f "$RA_MOD_DIR/mod.yaml" ]; then
        if command -v node >/dev/null 2>&1; then
            NODE_BIN=node
        elif [ -x /opt/homebrew/bin/node ]; then
            NODE_BIN=/opt/homebrew/bin/node
        elif [ -x /usr/local/bin/node ]; then
            NODE_BIN=/usr/local/bin/node
        else
            echo "launch-dedicated: node not found; required to generate the ra mod" >&2
            exit 1
        fi
        echo "launch-dedicated: generating assetless ra mod (steelseed-host/tools/build-ra-mod.mjs)..." >&2
        (cd "$ENGINE_DIR/steelseed-host" && "$NODE_BIN" tools/build-ra-mod.mjs) || exit 1
    fi
    MOD_SEARCH_PATHS="$ENGINE_DIR/steelseed-host/generated/mods"
else
    MOD_SEARCH_PATHS="$ENGINE_DIR/mods"
fi
export MOD_SEARCH_PATHS

SERVER_NAME="${Name:-OpenRA Dedicated Server}"
LISTEN_PORT="${ListenPort:-1234}"
MAP_UID="${Map:-}"
ADVERTISE_ONLINE="${AdvertiseOnline:-False}"
ENABLE_SINGLEPLAYER="${EnableSingleplayer:-True}"
ENABLE_SYNC_REPORTS="${EnableSyncReports:-False}"

echo "launch-dedicated: starting dedicated server (mod=$MOD_ID port=$LISTEN_PORT map=$MAP_UID search=$MOD_SEARCH_PATHS)" >&2

if [ "${ROOM_MODE:-0}" = "1" ]; then
    # Room-host mode: the room IS this server process. A crash must not be masked
    # by restarting into a fresh match — the connected client would lose its
    # frame stream and freeze ("simulation halted"), and the room entry would
    SERVER_RUNNER \
        "Engine.EngineDir=." \
        "Game.Mod=$MOD_ID" \
        "Server.Name=$SERVER_NAME" \
        "Server.ListenPort=$LISTEN_PORT" \
        "Server.AdvertiseOnline=$ADVERTISE_ONLINE" \
        "Server.EnableSingleplayer=$ENABLE_SINGLEPLAYER" \
        "Server.EnableSyncReports=$ENABLE_SYNC_REPORTS" \
        ${MAP_UID:+"Server.Map=$MAP_UID"}
    # No exec (bundled runner is a function), so exit explicitly: a crashed
    # room must not fall through into the restart loop.
    exit $?
fi

while true; do
    SERVER_RUNNER \
        "Engine.EngineDir=." \
        "Game.Mod=$MOD_ID" \
        "Server.Name=$SERVER_NAME" \
        "Server.ListenPort=$LISTEN_PORT" \
        "Server.AdvertiseOnline=$ADVERTISE_ONLINE" \
        "Server.EnableSingleplayer=$ENABLE_SINGLEPLAYER" \
        "Server.EnableSyncReports=$ENABLE_SYNC_REPORTS" \
        ${MAP_UID:+"Server.Map=$MAP_UID"}
    code=$?
    echo "launch-dedicated: server exited (code=$code), restarting in 2s..." >&2
    sleep 2
done
