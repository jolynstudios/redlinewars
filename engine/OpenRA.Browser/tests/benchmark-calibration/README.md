# Benchmark calibration fixtures

Everything in this directory is calibration tooling or test data, not a production benchmark default.

- `golden-adjudication-scenarios.json` contains model-blind deterministic ledger-event replays. They exercise all six raw adjudication components, unequal AUC intervals, irreversible losses, and terminal override.
- `calibration-map-inputs.json` contains reviewable candidate-generation parameters and manually proposed chokepoint seeds. The runner extracts resource and spawn anchors from each map archive and derives exact cells.
- `golden-score-v1.frozen-test.json` is a test-only frozen vector. It proves the production C# ledger and scorer wire together without freezing leaderboard calibration.
- `candidates/*.candidate.json` is reproducible runner output for human review. Candidate status is mandatory; the host never reads these files.

The input catalog may describe more than one reviewable map geometry, but candidate generation requires an
explicit `--map` and emits exactly one `candidateMaps` entry. The current benchmark pin is
`Siberian-Pass.oramap`; changing maps creates a new candidate/freeze lineage rather than an implicit runtime
default.

Run `node ../benchmark-calibration-runner.mjs --map Siberian-Pass.oramap` to print the current proposed bundle,
or add `--check candidates/benchmark-calibration-v1.candidate.json` to verify the reviewed candidate is still
reproducible.
