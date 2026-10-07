# OpenRA Agent sidecar

This port-owned Node service runs the two dynamic Mastra agents used by browser
Agent matches. It forwards one bounded, structured request at a time to
OpenRouter and never stores or logs credentials, prompts, observations, or raw
provider errors.

```sh
cd OpenRA.Browser/agent-sidecar
npm ci
npm run build
npm start
```

The default endpoint is `http://127.0.0.1:4112`. Production deployments must
put the service behind the same HTTPS origin as the browser host and set
`OPENRA_ALLOWED_ORIGINS` to an explicit comma-separated allowlist. Loopback
HTTP origins are accepted for local development only.

## Run an Agent vs Agent match locally

Build and serve the browser in a second terminal from the repository root:

```sh
export PATH="$HOME/.dotnet:$PATH"
make browser
node OpenRA.Browser/tests/server.mjs --root bin-browser/AppBundle --port 8331
```

Open this URL (the non-Lua launch map avoids the browser port's deferred Lua
work while the Agent host replaces it with the selected skirmish map):

```text
http://127.0.0.1:8331/?mode=game&platform=webgl2&Host.AgentMode=1&Launch.Map=Siberian-Pass.oramap
```

In the setup panel:

1. Leave the sidecar URL at `http://127.0.0.1:4112`.
2. Paste an OpenRouter key into the password field. Leave Agent 2's key blank
   to share it, or provide a separate key for that side.
3. Choose two OpenRouter model ids and edit the prompts if desired.
4. Review **Estimate cost** and the pre-filled `$2.00` hard cap, then start.
5. Watch both plain-text thought feeds and live spend. **Stop** clears the keys
   and ends the match immediately.

Enter keys only in the browser setup panel. Do not put them in URLs, command
lines, environment variables, prompts, logs, bug reports, or replay files.
## Run on subscriptions instead of metered credits

A match costs real OpenRouter credits — roughly $0.65–$1.53 at 50–200 decisions.
[sublet](https://github.com/proofofwork-agency/sublet) is a local proxy that
answers the same OpenRouter wire format from Claude Max, ChatGPT/Codex, z.ai and
Grok coding plans, so a match runs against a subscription you already pay for.

Start the proxy in benchmark mode, then this sidecar pointed at it:

```sh
cd /path/to/sublet && SUBLET_DEFAULT_MODEL= SUBLET_METERED_FALLBACK=0 bun run serve
cd OpenRA.Browser/agent-sidecar && ./run-with-sublet.sh
```

**Those two variables are not optional for a benchmark run.** By default sublet
serves an unknown model id on a default model and reports `substituted_for` in
the response. This sidecar sends `model` but never reads it back, so a
substitution would be invisible here and the leaderboard would credit one model
for a match another model played. Emptying `SUBLET_DEFAULT_MODEL` turns that
into a 400; `SUBLET_METERED_FALLBACK=0` stops any fall-through to billed
openrouter.ai.

`run-with-sublet.sh` proves both before it starts: it asks the proxy for a model
that cannot exist and refuses to run unless the answer is 400. The probe is
rejected before any backend is contacted, so it costs nothing. It also refuses
to start if the proxy is down, rather than leaving a sidecar that 502s on the
first estimate, and clears `OPENROUTER_API_KEY` from the environment it passes
on.

Then in the browser setup panel:

1. Set the sidecar URL to `http://127.0.0.1:4199`.
2. Paste any non-empty string as the key. A loopback proxy does not check it,
   and no real credential leaves your machine.
3. Use the proxy's model ids — `x-ai/grok-4.5`, `z-ai/glm-5.2`,
   `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`,
   `anthropic/claude-haiku-4.5`, `openai/gpt-5.6-sol`. Prefix one with a route
   (`zai:z-ai/glm-5.2`) to pin a specific backend.

Do not judge routing by asking a model what it is. Probed through this proxy,
GLM-5.2 answers "Claude 3" — models are unreliable narrators about their own
identity. The route is what the response's `model` field and an explicit
backend prefix say it is.

**Pointing the sidecar at the proxy is configuration** — it already reads
`OPENROUTER_BASE_URL`, so no patch is needed for that.

The sidecar *did* change for a different reason, and it is the reason the
paragraph above matters. It now reads the served model back out of the provider
response, canonicalizes a route-prefixed request so `grok:x-ai/grok-4.5`
compares equal to `x-ai/grok-4.5`, and rejects a missing, mismatched or
substituted id as an infrastructure failure rather than a model result. It also
reports its resolved provider endpoint on `/health`, and the match runner
refuses to start against a non-loopback one. Without that, a proxy that resolved
an unknown slug to a default model would publish a rating for a model that never
played, and nothing in the evidence would show it.

Because the sidecar's sources are pinned by the era lock
(`tests/benchmark-lockstep-v1.lock.json`, 53 surfaces), that change is
era-defining and the lock was re-minted with it. That is the correct cost: the
alternative was an era whose results cannot be trusted to name their own
contestants.

Two things behave differently from openrouter.ai and matter when reading
results. `usage.cost` is still populated, but it is now what the call *would*
have cost metered, so the `$2.00` hard cap keeps working as a runaway-loop
circuit breaker on spend that is actually zero. And the reported prompt-token
count for Anthropic-routed models is markedly higher than for the others,
because the proxy carries structured-output schemas as a tool on that path;
compare cost across models with that in mind.

The default observation mode respects each player's fog; omniscient
observations require the explicit research-mode checkbox and are marked in
replay telemetry. Agent mode is skirmish-only and must not be used for the
normal browser-to-desktop multiplayer handshake because its rules overlay has
a deliberately different checksum.

## Regenerate the RA rules reference

The sidecar prepends a compact ground-truth rules reference to every agent's
instructions. Regenerate it after RA rule or weapon changes from the repository
root:

```sh
make all && ./utility.sh ra --extract-agent-knowledge > OpenRA.Browser/agent-sidecar/knowledge/ra-knowledge.md
./utility.sh ra --extract-agent-knowledge arsenal > OpenRA.Browser/agent-sidecar/knowledge/ra-arsenal.json
node OpenRA.Browser/tests/arsenal-gate.mjs --regen-check
```

The Markdown file is the compact prompt sheet. The JSON artifact is the
machine-readable, rules-derived arsenal and counter graph; it includes hashes
of every source rules/weapon file plus source-line references for auditability.
Review both generated diffs and rerun the sidecar tests before committing them.
