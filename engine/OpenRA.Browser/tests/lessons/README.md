# Lessons files (learned-series track)

Cross-match memory for `match-runner.mjs --lessons on`: after each match the
model rereads its own match report through the sidecar's `/api/reflect`
endpoint and rewrites its lessons file here; the next `--lessons on` match
injects that file back into the same model's seat prompt.

## File name

One file per model: `<slug>.md`, where the slug is the OpenRouter model id
with every `/` and `.` replaced by `-`:

- `openai/gpt-5-mini` -> `openai-gpt-5-mini.md`
- `google/gemini-2.5-flash` -> `google-gemini-2-5-flash.md`

Files are keyed by model, not by seat: a `--mirror` match reflects twice into
the same file, and the second seat's rewrite wins.

## Format

Plain UTF-8 text (markdown welcome), authored entirely by the model —
imperative, match-grounded lessons, never a playbook restatement. Bounds:

- The sidecar writes at most 2200 characters (`MaxLessonsChars` in
  `agent-sidecar/src/server.ts`).
- The runner reads at most 2500 characters (the reflect contract's
  `priorLessons` cap in `agent-sidecar/src/contracts.ts`) and appends the
  content to the seat prompt AFTER the playbook, under the header
  `LESSONS FROM YOUR PAST MATCHES (self-written, may be stale):`, with the
  combined prompt clamped to the panel's 7800-character bound.

## Lifecycle

- `--lessons on`: read at match start (if the file exists), injected, then
  rewritten atomically (temp file + rename) after the match terminal.
  Reflect failures are logged as `reflect-error` in `log.jsonl` and never
  fail the match.
- `--lessons control`: never read or written — the fresh-context baseline
  that BENCHMARK.md requires every learned-series result to be paired with.
- `--lessons off` (default): the loop is disabled entirely.

Every match's `outcome.json` records `lessonsMode` plus `lessonsInjected`
(per seat, the sha256 hex of the exact injected text, or null), so any
learned-series result can be audited against this directory's history.
Deleting a file resets that model's cross-match memory.
