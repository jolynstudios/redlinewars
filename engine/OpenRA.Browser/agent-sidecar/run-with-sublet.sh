#!/bin/sh
# Run the agent sidecar against a local sublet proxy instead of openrouter.ai,
# so Agent matches are served by coding-plan subscriptions rather than metered
# credits.
#
#   SUBLET_URL   base URL of the running proxy   (default http://127.0.0.1:8788)
#   PORT         port for this sidecar           (default 4199)
#
# Pointing the sidecar here is configuration, not a patch — it already reads
# OPENROUTER_BASE_URL. The sidecar separately verifies which model actually
# answered and reports its resolved endpoint on /health, and benchmark runs
# refuse to start unless that endpoint is loopback, so a metered run cannot
# happen by pointing at the wrong port.
set -o errexit || exit $?

SIDECARDIR=$(dirname "$0")
SUBLET_URL=${SUBLET_URL:-http://127.0.0.1:8788}
PORT=${PORT:-4199}

if [ ! -f "$SIDECARDIR/dist/server.js" ]; then
	echo "sidecar is not built. Run: (cd $SIDECARDIR && npm ci && npm run build)" >&2
	exit 1
fi

# Fail loudly rather than starting a sidecar that will 502 on the first
# estimate. A silently-absent proxy is the failure mode worth spending a
# round-trip to rule out.
if ! curl -sf "$SUBLET_URL/healthz" > /dev/null 2>&1; then
	echo "no sublet proxy at $SUBLET_URL" >&2
	echo "start one with: (cd /path/to/sublet && bun run serve)" >&2
	exit 1
fi

# The sidecar sends `model` but never reads it back off the response, so a
# proxy-side model substitution would be invisible here and the leaderboard
# would credit the wrong entrant. sublet only substitutes when it has a default
# model configured; prove it does not, by asking for a model that cannot exist.
# The probe is refused before any backend is contacted, so it costs nothing.
probe=$(curl -s -o /dev/null -w '%{http_code}' \
	-X POST "$SUBLET_URL/v1/chat/completions" \
	-H 'Content-Type: application/json' \
	-d '{"model":"sublet/substitution-probe-does-not-exist","max_tokens":1,
	     "messages":[{"role":"user","content":"x"}]}')
if [ "$probe" != "400" ]; then
	echo "refusing to start: the proxy answered $probe for a nonexistent model." >&2
	echo "It should answer 400. Anything else means an unknown model is being" >&2
	echo "served by a substitute, which this sidecar cannot detect and which" >&2
	echo "would silently attribute a match to the wrong model." >&2
	echo "Start the proxy with: SUBLET_DEFAULT_MODEL= SUBLET_METERED_FALLBACK=0" >&2
	exit 1
fi

echo "substitution check: unknown models are refused (400), not substituted"
echo "sublet backends: $(curl -s "$SUBLET_URL/healthz" |
	sed -n 's/.*"backends":\[\([^]]*\)\].*/\1/p' | tr -d '"')"
echo "models:"
curl -s "$SUBLET_URL/v1/models" |
	tr ',' '\n' | sed -n 's/.*"id":"\([^"]*\)".*/  \1/p' | grep -v ':' || true
echo
echo "sidecar -> $SUBLET_URL/api/v1   listening on http://127.0.0.1:$PORT"
echo "Paste any non-empty string as the API key in the browser setup panel;"
echo "a loopback sublet does not check it."
echo

# Any real OPENROUTER_API_KEY in the shell is replaced, not cleared. Clearing
# it looks safer but breaks unattended runs: match-runner.mjs deliberately sends
# a sentinel instead of a credential, and the sidecar resolves that sentinel
# from this variable, so an empty one fails planning before tick 0. A visibly
# fake value satisfies the sentinel, is ignored by a loopback proxy, and could
# only ever earn a 401 from the real openrouter.ai — never a bill.
exec env -u openrouter \
	PORT="$PORT" \
	OPENROUTER_API_KEY='sublet-local-not-an-openrouter-key' \
	OPENROUTER_BASE_URL="$SUBLET_URL/api/v1" \
	node "$SIDECARDIR/dist/server.js"
