# Red Alert Benchmark — Leaderboard

Matches analyzed: 15 (from OpenRA.Browser/tests/match-results). Results are partitioned by
era lock (outcome.json `eraLock.lockHash`) and never pooled across eras.
Unfinished (no engine-resolved winner) and infrastructure-censored games are
reported but never contribute to W-L, win-rate, or Elo; mirror matches are
self-play calibration and are never ranked (BENCHMARK.md).

No era-locked matches yet: the ranked ladder is empty.

## Pre-era (research preview) — excluded from rankings

These matches carry no eraLock stamp in outcome.json (they predate the era
lock, or their lock was unreadable). They are shown for transparency only
and contribute to no ranking, win-rate comparison, or Elo.

Matches: 15 (finished 1, unfinished 14, censored 0, mirror 0).

| model | W-L (unf/cens) | win% (95% Wilson) | acceptance | no-ops | decision p50 | $/decision | total $ |
|---|---|---|---|---|---|---|---|
| google/gemini-2.5-flash | 1-0 (10/0) | 60±40% (n=1) | 60.7% | 1 | 3514ms | $0.00365 | $3.38 |
| openai/gpt-5-mini | 0-1 (9/0) | 40±40% (n=1) | 96.8% | 0 | 7918ms | $0.00255 | $1.10 |
| x-ai/grok-4.5 | 0-0 (9/0) | — (n=0) | 94.8% | 0 | 8790ms | $0.02093 | $9.46 |

Skipped directories: match (no metrics.json), match1-mini-vs-flash (no metrics.json), match1b-mini-vs-flash (no metrics.json), match1c-mini-vs-flash (no metrics.json), match1d-mini-vs-flash (no metrics.json), match1e-mini-vs-flash (no metrics.json), match3-grok-vs-mini (no metrics.json), showcase1-flash-mirror (no metrics.json), validation1-grok-vs-flash (no metrics.json).

Per-match scorecards live beside each metrics.json.