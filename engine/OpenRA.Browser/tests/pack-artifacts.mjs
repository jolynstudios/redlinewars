// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// Packs each match's publishable artifact set into the public, immutable
// layout used for gh-pages/tarball publication: <out>/<label>/ per match
// plus a top-level index.md. Only the reviewable result set is published
// (metrics.json, outcome.json, scorecard.md, log.jsonl, final.png,
// *.orarep replays, and era-lock.json when present); working files such as
// shot-*.png and winner.txt deliberately stay behind. Every pack carries a
// MANIFEST.json with the sha256 of each published file plus the match's
// era lock (BENCHMARK.md: results from different eras must never be pooled)
// so third parties can verify nothing changed after packing — the packer
// re-hashes everything it wrote before exiting for the same reason.
// Output is deterministic (no timestamps, codepoint-sorted index), so a
// --force re-run over unchanged inputs reproduces byte-identical packs.
// Usage: node pack-artifacts.mjs <matchDir...> --out <dir> [--force]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The publishable set, in manifest/index order. Everything else in a match
// dir is working state and must not leak into a public pack.
const FixedArtifacts = ['metrics.json', 'outcome.json', 'scorecard.md', 'log.jsonl', 'final.png'];
const EraLockFile = 'era-lock.json';
const ManifestName = 'MANIFEST.json';

const usage = 'Usage: node pack-artifacts.mjs <matchDir...> --out <dir> [--force]';
const argumentError = message => {
	console.error(`${message}\n${usage}`);
	process.exit(2);
};

// Packs are publication artifacts: an unknown flag must never fall through
// to defaults and silently publish the wrong layout (same policy as
// match-runner and ladder-runner).
const valueFlags = new Set(['out']);
const booleanFlags = new Set(['force']);
const flags = new Map();
const matchDirArgs = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const token = args[i];
	if (!token.startsWith('--')) {
		matchDirArgs.push(token);
		continue;
	}

	const name = token.slice(2);
	if (name.length === 0 || (!valueFlags.has(name) && !booleanFlags.has(name))) {
		argumentError(`Unknown flag ${token}.`);
	}

	if (flags.has(name)) {
		argumentError(`Flag ${token} was supplied more than once.`);
	}

	if (valueFlags.has(name)) {
		if (i + 1 >= args.length) {
			argumentError(`Flag ${token} requires a value.`);
		}

		flags.set(name, args[++i]);
	} else {
		flags.set(name, true);
	}
}

if (matchDirArgs.length === 0) {
	argumentError('At least one <matchDir> is required.');
}

if (!flags.has('out')) {
	argumentError('--out <dir> is required.');
}

const force = flags.get('force') === true;
const outDir = path.resolve(flags.get('out'));

// The pack label doubles as the output directory name, so it must identify
// exactly one source match.
const matches = matchDirArgs.map(dir => {
	const source = path.resolve(dir);
	if (!existsSync(source) || !statSync(source).isDirectory()) {
		argumentError(`Match directory not found: ${dir}`);
	}

	return { source, label: path.basename(source) };
});

const labels = new Set();
for (const match of matches) {
	if (labels.has(match.label)) {
		argumentError(`Duplicate match label '${match.label}': pack labels must be unique.`);
	}

	labels.add(match.label);
}

// An output root nested inside a match dir (or the reverse) would hash and
// publish its own output; refuse rather than build a self-referential pack.
const contains = (parent, child) => {
	const relative = path.relative(parent, child);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

for (const match of matches) {
	if (contains(match.source, outDir) || contains(outDir, match.source)) {
		argumentError(`--out must not overlap a match directory: ${match.source}`);
	}
}

if (existsSync(outDir)) {
	if (!statSync(outDir).isDirectory()) {
		argumentError(`--out exists and is not a directory: ${outDir}`);
	}

	// Published packs are immutable by convention; replacing one must be a
	// deliberate act, not a side effect of a re-run.
	if (readdirSync(outDir).length > 0 && !force) {
		console.error(`Refusing to write into non-empty output directory ${outDir}. Pass --force to replace the packs it contains.`);
		process.exit(1);
	}
}

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');

// The era lock is the harness-version stamp that keeps results poolable only
// within one era. Prefer the dedicated era-lock.json written by the hardened
// runner; older matches may only carry an eraLock/era field inside
// metrics.json or outcome.json; pre-era matches pack with null plus a warning
// so the gap stays visible in the published manifest instead of being
// papered over.
const resolveEraLock = (match, metrics, outcome) => {
	const lockFile = path.join(match.source, EraLockFile);
	if (existsSync(lockFile)) {
		try {
			return JSON.parse(readFileSync(lockFile, 'utf8'));
		} catch {
			// A corrupt era lock must fail the pack: publishing the file while
			// recording eraLock=null would misrepresent the match's era.
			console.error(`${match.label}/${EraLockFile} is not valid JSON; refusing to pack a corrupt era lock.`);
			process.exit(1);
		}
	}

	return metrics?.eraLock ?? metrics?.match?.eraLock ?? metrics?.era ?? metrics?.match?.era
		?? outcome?.eraLock ?? outcome?.era ?? null;
};

// index.md needs a short era cell even when the lock is a full stamp object:
// use its declared id when present, otherwise fingerprint the canonical JSON
// so identical locks collapse to the same cell and different locks never do.
const eraLabel = lock => {
	if (lock == null) {
		return null;
	}

	if (typeof lock !== 'object') {
		return String(lock);
	}

	const id = lock.era ?? lock.id ?? lock.name ?? lock.label;
	if (id != null) {
		return String(id);
	}

	return `sha256:${sha256(Buffer.from(JSON.stringify(lock), 'utf8')).slice(0, 12)}`;
};

// Table cells must stay single-line and must not break the markdown table;
// long terminal statuses get clipped, not dropped.
const cell = value => {
	if (value == null || String(value).trim() === '') {
		return '—';
	}

	const flat = String(value).replace(/\s+/g, ' ').trim();
	const clipped = flat.length > 96 ? `${flat.slice(0, 95)}…` : flat;
	return clipped.replaceAll('|', '\\|');
};

const written = [];
const rows = [];

for (const match of matches) {
	const names = [];
	const missing = [];
	for (const name of FixedArtifacts) {
		if (existsSync(path.join(match.source, name))) {
			names.push(name);
		} else {
			missing.push(name);
		}
	}

	if (existsSync(path.join(match.source, EraLockFile))) {
		names.push(EraLockFile);
	}

	const replays = readdirSync(match.source, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith('.orarep'))
		.map(entry => entry.name)
		.sort();
	names.push(...replays);

	if (names.length === 0) {
		argumentError(`No publishable artifacts found in ${match.source}; is it a match-results directory?`);
	}

	if (missing.length > 0) {
		console.error(`warning: ${match.label} is missing ${missing.join(', ')}; packing what exists and recording the gap in ${ManifestName}.`);
	}

	// Hash the same bytes that get written so the manifest provably describes
	// the pack, not the (possibly changing) source dir.
	const buffers = new Map(names.map(name => [name, readFileSync(path.join(match.source, name))]));

	// Index columns degrade to '—' on malformed JSON, but the raw bytes are
	// still published and hashed: the pack is evidence, not interpretation.
	const parseJsonArtifact = name => {
		if (!buffers.has(name)) {
			return null;
		}

		try {
			return JSON.parse(buffers.get(name).toString('utf8'));
		} catch {
			console.error(`warning: ${match.label}/${name} is not valid JSON; index columns from it will be empty.`);
			return null;
		}
	};

	const metrics = parseJsonArtifact('metrics.json');
	const outcome = parseJsonArtifact('outcome.json');
	const eraLock = resolveEraLock(match, metrics, outcome);
	if (eraLock == null) {
		console.error(`warning: ${match.label} carries no era lock; MANIFEST.json records eraLock=null.`);
	}

	// Matches that predate metrics.json still have a booted line and state
	// lines in log.jsonl; the index should not go blank just because the
	// metrics engine never ran. A torn final line is expected on crashed
	// matches and is skipped, not fatal.
	const logInfo = { model1: null, model2: null, spend: null, state: null, status: null };
	if (buffers.has('log.jsonl')) {
		for (const line of buffers.get('log.jsonl').toString('utf8').split('\n')) {
			if (line.trim() === '') {
				continue;
			}

			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.kind === 'booted') {
				logInfo.model1 ??= entry.model1 ?? null;
				logInfo.model2 ??= entry.model2 ?? null;
			} else if (entry.kind === 'state') {
				logInfo.spend = entry.spend ?? logInfo.spend;
				logInfo.state = entry.state ?? logInfo.state;
				logInfo.status = entry.status ?? logInfo.status;
			}
		}
	}

	const model1 = metrics?.match?.model1 ?? logInfo.model1;
	const model2 = metrics?.match?.model2 ?? logInfo.model2;
	const models = model1 != null || model2 != null ? `${model1 ?? '?'} vs ${model2 ?? '?'}` : null;

	// Same precedence as leaderboard.mjs: the runner's detected winner
	// (outcome.json, surfaced as metrics.match.winner) beats the manual
	// winner.txt sidecar kept by pre-detection overnight matches. winner.txt
	// informs the index but is not part of the published set.
	const winnerFile = path.join(match.source, 'winner.txt');
	const winnerAgent = outcome?.winner ?? metrics?.match?.winner
		?? (existsSync(winnerFile) ? readFileSync(winnerFile, 'utf8').trim() : null);
	const agentModels = { agent1: model1, agent2: model2 };
	const winner = winnerAgent == null ? null
		: agentModels[winnerAgent] != null ? `${winnerAgent} (${agentModels[winnerAgent]})` : String(winnerAgent);

	const outcomeText = outcome?.how ?? metrics?.match?.terminalStatus ?? outcome?.terminalStatus
		?? logInfo.status ?? metrics?.match?.terminalState ?? logInfo.state;
	const spend = typeof metrics?.match?.totalSpendUsd === 'number'
		? `$${metrics.match.totalSpendUsd.toFixed(4)}`
		: logInfo.spend;

	const destDir = path.join(outDir, match.label);
	if (force) {
		// --force replaces only the packs being written (and index.md below);
		// unrelated entries in the output root are never deleted. Clearing the
		// whole pack dir first keeps re-runs idempotent: files that left the
		// source set must not survive from an earlier pack.
		rmSync(destDir, { recursive: true, force: true });
	}

	mkdirSync(destDir, { recursive: true });
	const files = names.map(name => {
		const buffer = buffers.get(name);
		const digest = sha256(buffer);
		const destination = path.join(destDir, name);
		writeFileSync(destination, buffer);
		written.push({ destination, sha256: digest, label: match.label, name });
		return { name, bytes: buffer.length, sha256: digest };
	});

	const manifest = {
		schemaVersion: 1,
		label: match.label,
		eraLock,
		files,
		missing
	};
	writeFileSync(path.join(destDir, ManifestName), `${JSON.stringify(manifest, null, '\t')}\n`);

	rows.push({
		label: match.label,
		models,
		outcome: outcomeText,
		winner,
		spend,
		era: eraLabel(eraLock),
		fileCount: files.length,
		missingCount: missing.length
	});
}

// Codepoint sort, not localeCompare: the index must be byte-identical no
// matter which machine or locale produced it.
rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

const index = [
	'# Match artifact packs',
	'',
	'Immutable benchmark artifacts packed by tests/pack-artifacts.mjs for publication.',
	`Each pack directory carries a ${ManifestName} listing the sha256 of every published`,
	'file plus the era lock in force when the match ran; packs from different eras must',
	'never be pooled into one ladder (see BENCHMARK.md).',
	'',
	'| label | models | outcome | winner | spend | era |',
	'|---|---|---|---|---|---|',
	...rows.map(row =>
		`| ${cell(row.label)} | ${cell(row.models)} | ${cell(row.outcome)} | ${cell(row.winner)} | ${cell(row.spend)} | ${cell(row.era)} |`),
	''
].join('\n');

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'index.md'), index);

// The manifest is only worth publishing if it verifiably matches the bytes
// on disk; re-hash everything written before claiming success.
for (const record of written) {
	const actual = sha256(readFileSync(record.destination));
	if (actual !== record.sha256) {
		console.error(`Post-write verification failed for ${record.label}/${record.name}: manifest ${record.sha256}, on disk ${actual}.`);
		process.exit(1);
	}
}

for (const row of rows) {
	const gap = row.missingCount > 0 ? ` (${row.missingCount} expected artifact(s) missing)` : '';
	console.log(`packed ${row.label}: ${row.fileCount} file(s)${gap}, era ${row.era ?? 'unknown'}`);
}

console.log(`Wrote ${rows.length} pack(s) and index.md to ${outDir}; all manifest hashes verified.`);
