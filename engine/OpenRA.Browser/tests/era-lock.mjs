// Copyright (c) The OpenRA Developers and Contributors
// This file is part of OpenRA, which is free software. It is made
// available to you under the terms of the GNU General Public License
// as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. For more
// information, see COPYING.

// Era lock for the Red Alert benchmark. BENCHMARK.md pools results only
// within one harness generation (the "era"), but era discipline was prose,
// not mechanism: nothing could prove two results came from the same
// harness. The lock pins the era-defining surfaces: engineCommit pins the
// committed engine; per-file sha256 pins the model-facing harness surfaces
// that are served or interpreted as-is and can therefore drift without a
// commit (observation/action schema, seat prompts, knowledge sheet,
// provider validation and repair, browser controller with reflex and
// cadence defaults, agent-mode rules); doctrineHashes pins every
// assisted-track playbook including set membership, because an added or
// removed playbook is a new era, not a variant. lockHash covers all other
// fields so a hand-edited lock fails before it can vouch for anything.
// No timestamps: the same tree must produce a byte-identical lock.
// Usage:
//   node era-lock.mjs generate --era <label> [--out <path>]
//   node era-lock.mjs validate <lockfile>
// generate defaults --out to tests/<label>.lock.json. Exit codes: 0 lock
// written or lock matches; 1 drift (every drifted field is named) or a
// tree that cannot be pinned; 2 usage error, malformed/unsupported lock
// file, or environment fault (git unavailable).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EraFiles } from './era-surfaces.mjs';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const browserRoot = path.resolve(testsDir, '..');
const playbooksDir = path.join(browserRoot, 'agent-sidecar', 'knowledge', 'playbooks');

const usage = 'Usage: node era-lock.mjs generate --era <label> [--out <path>]\n' +
	'       node era-lock.mjs validate <lockfile>';

const argumentError = message => {
	console.error(`${message}\n${usage}`);
	process.exit(2);
};

const fatal = message => {
	console.error(`era-lock: ${message}`);
	process.exit(2);
};

const sha256 = data => createHash('sha256').update(data).digest('hex');
const HexHash = /^[0-9a-f]{64}$/;
const HexCommit = /^[0-9a-f]{40}$/;
// Era labels feed lock file names and match-runner --label values.
const Label = /^[A-Za-z0-9._-]+$/;

function hashFileOrNull(relPath) {
	try {
		return sha256(readFileSync(path.join(browserRoot, relPath)));
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR')
			return null;
		throw error;
	}
}

function gitHead() {
	// The era must anchor to a real commit id; anything else here is an
	// environment fault, never reported as drift.
	let output = '';
	try {
		output = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: browserRoot, encoding: 'utf8' });
	} catch (error) {
		fatal(`cannot resolve engineCommit (git rev-parse HEAD): ${error.message}`);
	}

	const commit = output.trim();
	if (!HexCommit.test(commit))
		fatal(`git rev-parse HEAD returned '${commit}', not a commit id.`);
	return commit;
}

function liveFiles() {
	const files = {};
	for (const relPath of [...EraFiles].sort())
		files[relPath] = hashFileOrNull(relPath);
	return files;
}

function liveDoctrines() {
	// Doctrine identity is the playbook id the runners take (--playbook1
	// soviet-armor): the basename without .md. README is documentation, not
	// a doctrine. null means the playbooks directory itself is gone, which
	// is distinct from a directory that merely has no playbooks.
	let names;
	try {
		names = readdirSync(playbooksDir);
	} catch (error) {
		if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
			return null;
		throw error;
	}

	const doctrines = {};
	for (const name of names.sort()) {
		if (!name.endsWith('.md') || /^readme\.md$/i.test(name))
			continue;
		doctrines[name.slice(0, -'.md'.length)] = sha256(readFileSync(path.join(playbooksDir, name)));
	}

	return doctrines;
}

// lockHash covers a canonical serialization (recursively sorted keys, no
// whitespace) of every field except lockHash itself: reformatting the lock
// file cannot change its identity, but any value edit must.
function canonical(value) {
	if (Array.isArray(value))
		return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object')
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

const lockHashOf = lock => sha256(canonical({
	schemaVersion: lock.schemaVersion,
	era: lock.era,
	engineCommit: lock.engineCommit,
	files: lock.files,
	doctrineHashes: lock.doctrineHashes
}));

function generate(rest) {
	// A misspelled flag must never fall through and silently pin the wrong
	// thing: unknown, duplicate, and valueless flags are all hard errors.
	const valueFlags = new Set(['era', 'out']);
	const parsed = new Map();
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (!token.startsWith('--') || token.length === 2)
			argumentError(`Unexpected argument '${token}'.`);

		const name = token.slice(2);
		if (!valueFlags.has(name))
			argumentError(`Unknown flag ${token}.`);

		if (parsed.has(name))
			argumentError(`Flag ${token} was supplied more than once.`);

		const value = rest[++i];
		if (value == null || value.startsWith('-'))
			argumentError(`Flag ${token} requires a non-flag value.`);

		parsed.set(name, value);
	}

	if (!parsed.has('era'))
		argumentError('--era is required.');

	const era = parsed.get('era');
	if (!Label.test(era))
		argumentError('--era must be letters, numbers, dot, underscore, or hyphen.');

	const outPath = parsed.has('out') ? path.resolve(parsed.get('out')) : path.join(testsDir, `${era}.lock.json`);

	const engineCommit = gitHead();
	const files = liveFiles();
	// An era pinned from a tree already missing named surfaces would certify
	// a broken harness; refuse instead of writing a lock full of holes.
	const missing = Object.keys(files).filter(key => files[key] == null);
	if (missing.length > 0) {
		console.error(`era-lock: refusing to pin ${era}: missing era surface(s): ${missing.join(', ')}`);
		process.exit(1);
	}

	const doctrineHashes = liveDoctrines();
	if (doctrineHashes == null || Object.keys(doctrineHashes).length === 0) {
		console.error(`era-lock: refusing to pin ${era}: no doctrine playbooks under ${playbooksDir} ` +
			'(the assisted track would be undefined).');
		process.exit(1);
	}

	const lock = { schemaVersion: 1, era, engineCommit, files, doctrineHashes };
	lock.lockHash = lockHashOf(lock);
	writeFileSync(outPath, `${JSON.stringify(lock, null, '\t')}\n`);
	console.log(`era-lock: wrote ${outPath}`);
	console.log(`era-lock: ${era} @ ${engineCommit}, ${Object.keys(files).length} files, ` +
		`${Object.keys(doctrineHashes).length} doctrines, lockHash ${lock.lockHash}`);
}

function validate(rest) {
	if (rest.length === 0)
		argumentError('validate requires a lock file path.');
	if (rest[0].startsWith('-'))
		argumentError(`Unknown flag ${rest[0]}.`);
	if (rest.length > 1)
		argumentError(`Unexpected argument '${rest[1]}'.`);

	const lockPath = path.resolve(rest[0]);
	let text = '';
	try {
		text = readFileSync(lockPath, 'utf8');
	} catch (error) {
		fatal(`cannot read ${lockPath}: ${error.message}`);
	}

	let lock;
	try {
		lock = JSON.parse(text);
	} catch (error) {
		fatal(`${lockPath} is not JSON: ${error.message}`);
	}

	// A lock that fails structural checks cannot vouch for anything, but it
	// is a malformed input (exit 2), not measured drift (exit 1).
	if (typeof lock !== 'object' || lock == null || Array.isArray(lock))
		fatal(`${lockPath}: top level must be a JSON object.`);
	if (lock.schemaVersion !== 1)
		fatal(`${lockPath}: unsupported schemaVersion ${JSON.stringify(lock.schemaVersion)} (expected 1).`);
	if (typeof lock.era !== 'string' || !Label.test(lock.era))
		fatal(`${lockPath}: 'era' must be a label of letters, numbers, dot, underscore, or hyphen.`);
	if (typeof lock.engineCommit !== 'string' || !HexCommit.test(lock.engineCommit))
		fatal(`${lockPath}: 'engineCommit' must be a 40-hex commit id.`);
	for (const group of ['files', 'doctrineHashes']) {
		const table = lock[group];
		if (typeof table !== 'object' || table == null || Array.isArray(table))
			fatal(`${lockPath}: '${group}' must be an object of sha256 hex values.`);
		for (const [key, value] of Object.entries(table)) {
			if (typeof value !== 'string' || !HexHash.test(value))
				fatal(`${lockPath}: ${group}["${key}"] is not a sha256 hex value.`);
		}
	}

	// File keys are joined against browserRoot when recomputed; a lock must
	// not be able to point the validator outside the repo.
	for (const key of Object.keys(lock.files)) {
		if (key.startsWith('/') || key.split('/').includes('..'))
			fatal(`${lockPath}: files["${key}"] is not a repo-relative path.`);
	}
	if (typeof lock.lockHash !== 'string' || !HexHash.test(lock.lockHash))
		fatal(`${lockPath}: 'lockHash' must be a sha256 hex value.`);
	const knownFields = ['schemaVersion', 'era', 'engineCommit', 'files', 'doctrineHashes', 'lockHash'];
	for (const key of Object.keys(lock)) {
		if (!knownFields.includes(key))
			fatal(`${lockPath}: unknown field '${key}'.`);
	}

	const drift = [];
	if (lockHashOf(lock) !== lock.lockHash)
		drift.push(`lockHash: recorded ${lock.lockHash}, recomputed ${lockHashOf(lock)} ` +
			'(the lock file was edited after generation)');

	const engineCommit = gitHead();
	if (engineCommit !== lock.engineCommit)
		drift.push(`engineCommit: locked ${lock.engineCommit}, live ${engineCommit}`);

	// Compare the union of locked and currently-named surfaces so a lock
	// from an older or newer named-file list still fails loudly instead of
	// silently skipping the difference.
	const files = liveFiles();
	for (const key of [...new Set([...Object.keys(lock.files), ...Object.keys(files)])].sort()) {
		const locked = key in lock.files ? lock.files[key] : null;
		const live = key in files ? files[key] : hashFileOrNull(key);
		if (locked !== live)
			drift.push(`files["${key}"]: locked ${locked ?? '(not in lock)'}, live ${live ?? '(missing on disk)'}`);
	}

	// Doctrine set membership is era identity: an unlisted playbook on disk
	// drifts exactly like a modified or deleted one.
	const doctrines = liveDoctrines() ?? {};
	for (const key of [...new Set([...Object.keys(lock.doctrineHashes), ...Object.keys(doctrines)])].sort()) {
		const locked = key in lock.doctrineHashes ? lock.doctrineHashes[key] : null;
		const live = key in doctrines ? doctrines[key] : null;
		if (locked !== live)
			drift.push(`doctrineHashes["${key}"]: locked ${locked ?? '(not in lock)'}, live ${live ?? '(missing on disk)'}`);
	}

	if (drift.length > 0) {
		console.error(`era-lock DRIFT: ${lockPath} does not match the live tree (${drift.length} field(s)):`);
		for (const line of drift)
			console.error(`  ${line}`);
		process.exit(1);
	}

	console.log(`era-lock OK: ${lock.era} @ ${lock.engineCommit} (${Object.keys(lock.files).length} files, ` +
		`${Object.keys(lock.doctrineHashes).length} doctrines)`);
}

const args = process.argv.slice(2);
if (args.length === 0)
	argumentError("A command ('generate' or 'validate') is required.");
if (args[0] === 'generate')
	generate(args.slice(1));
else if (args[0] === 'validate')
	validate(args.slice(1));
else
	argumentError(`Unknown command '${args[0]}'.`);
