#!/usr/bin/env node
// Isolated Ranked replay worker (T6.12).
//
// The room host is an untrusted producer. It may only atomically drop a job
// directory into `inbox`; it never receives the receipt key, settlement token,
// or write access to this worker's state. The worker first atomically claims a
// complete job into its private processing directory, validates the tiny job
// surface, and only then invokes the same-engine replay verifier.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRankedReplay } from './ranked-replay.mjs';
import { modTreeHash } from './sim-build-id.mjs';

const scriptFile = fileURLToPath(import.meta.url);
const JOB = /^[a-f0-9]{32}\.job$/;
const MAX_REPLAY_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;

function atomicJson(file, value, mode = 0o600) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
	const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
	try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	fs.renameSync(temp, file);
}

function readRegularFile(file, maxBytes) {
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('unsafe-job-file');
	return fs.readFileSync(file);
}

function moveTree(source, destination) {
	try { fs.renameSync(source, destination); }
	catch (error) {
		if (error.code !== 'EXDEV') throw error;
		fs.cpSync(source, destination, { recursive: true, errorOnExist: true });
		fs.rmSync(source, { recursive: true, force: true });
	}
}

function validateJob(jobDir) {
	const allowed = new Set(['job.json', 'replay.orarep']);
	const entries = fs.readdirSync(jobDir, { withFileTypes: true });
	if (entries.some(entry => !allowed.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()))
		throw new Error('unsafe-job-layout');
	const raw = readRegularFile(path.join(jobDir, 'job.json'), MAX_METADATA_BYTES);
	const job = JSON.parse(raw.toString('utf8'));
	if (job?.schema !== 1 || !job.claim || typeof job.claim !== 'object' || !Array.isArray(job.claim.participants))
		throw new Error('invalid-job-metadata');
	const replay = path.join(jobDir, 'replay.orarep');
	if (fs.existsSync(replay)) readRegularFile(replay, MAX_REPLAY_BYTES);
	return { job, replay: fs.existsSync(replay) ? replay : null };
}

function settlementUrlAllowed(value) {
	if (typeof value !== 'string' || value === '') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'));
	} catch { return false; }
}

export function workerConfig(env = process.env) {
	const configuredPoll = Number(env.REDLINE_RANKED_WORKER_POLL_MS ?? 1000);
	return {
		inbox: env.REDLINE_RANKED_INBOX ?? '/var/spool/steelthorn-ranked/inbox',
		claims: env.REDLINE_RANKED_CLAIMED ?? '/var/spool/steelthorn-ranked/processing',
		state: env.REDLINE_RANKED_WORKER_STATE ?? '/var/lib/steelthorn-ranked',
		privateKeyFile: env.REDLINE_RANKED_RECEIPT_PRIVATE_KEY_FILE,
		settlementUrl: env.REDLINE_RANKED_SETTLEMENT_URL,
		settlementToken: env.REDLINE_RANKED_WORKER_TOKEN,
		localSimBuild: env.REDLINE_RANKED_SIM_BUILD,
		localRulesHash: env.REDLINE_RANKED_RULES_HASH,
		engineRoot: env.REDLINE_ENGINE_DIR ?? path.resolve(path.dirname(scriptFile), '../..'),
		pollMs: Number.isFinite(configuredPoll) ? Math.max(250, configuredPoll) : 1000,
	};
}

export function assertEnginePin(config) {
	const buildFile = path.join(config.engineRoot, 'steelseed-host', 'generated', 'build.json');
	const build = JSON.parse(readRegularFile(buildFile, MAX_METADATA_BYTES).toString('utf8'));
	if (build?.schema !== 1 || typeof config.localSimBuild !== 'string' || build.simBuild !== config.localSimBuild)
		throw new Error('ranked worker sim build pin does not match the assembled engine');
	const modRoot = path.join(config.engineRoot, 'steelseed-host', 'generated', 'mods', 'ra');
	if (typeof build.modHash !== 'string' || modTreeHash(modRoot) !== build.modHash)
		throw new Error('ranked worker engine artifact hash mismatch');
	return build;
}

export async function deliverOutbox(file, config, fetchImpl = fetch) {
	if (!settlementUrlAllowed(config.settlementUrl) || typeof config.settlementToken !== 'string' || config.settlementToken.length < 32)
		return false;
	let envelope;
	try { envelope = JSON.parse(readRegularFile(file, MAX_METADATA_BYTES).toString('utf8')); } catch { return false; }
	if (!envelope?.receipt || (envelope.nextAttemptAt ?? 0) > Date.now()) return false;
	try {
		const response = await fetchImpl(config.settlementUrl, {
			method: 'POST', headers: { 'content-type': 'application/json', 'x-ranked-worker-token': config.settlementToken },
			body: JSON.stringify({ receipt: envelope.receipt }), signal: AbortSignal.timeout(5000),
		});
		if (response.ok) { fs.rmSync(file, { force: true }); return true; }
		if (response.status >= 400 && response.status < 500) {
			const rejected = path.join(config.state, 'rejected', path.basename(file));
			atomicJson(rejected, { ...envelope, rejectedAt: Date.now(), status: response.status });
			fs.rmSync(file, { force: true });
			return false;
		}
		throw new Error(`settlement HTTP ${response.status}`);
	} catch (error) {
		const attempts = Math.min(12, Number(envelope.attempts ?? 0) + 1);
		atomicJson(file, { ...envelope, attempts, lastError: String(error.message).slice(0, 200),
			nextAttemptAt: Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8)) });
		return false;
	}
}

export async function flushOutbox(config, fetchImpl = fetch) {
	const root = path.join(config.state, 'outbox');
	let entries = [];
	try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
	for (const entry of entries)
		if (entry.isFile() && entry.name.endsWith('.json')) await deliverOutbox(path.join(root, entry.name), config, fetchImpl);
}

export async function processJob(jobName, config, { verify = verifyRankedReplay, fetchImpl = fetch } = {}) {
	if (!JOB.test(jobName)) return false;
	const source = path.join(config.inbox, jobName);
	const processing = path.join(config.claims, jobName);
	fs.mkdirSync(path.dirname(processing), { recursive: true, mode: 0o700 });
	if (!fs.existsSync(processing)) {
		try { fs.renameSync(source, processing); } catch (error) {
			if (error.code === 'ENOENT') return false;
			throw error;
		}
	}
	let result;
	try {
		const { job, replay } = validateJob(processing);
		result = await verify({ replayFile: replay, claim: job.claim, privateKeyFile: config.privateKeyFile,
			localSimBuild: config.localSimBuild, localRulesHash: config.localRulesHash, endedAt: job.endedAt });
	} catch (error) {
		// Malformed producer data must never make the worker execute an arbitrary
		// path. Preserve it privately for investigation; no unsigned substitute is
		// sent to the account service.
		atomicJson(path.join(processing, 'worker-error.json'), { error: String(error.message).slice(0, 200), at: Date.now() });
		const failed = path.join(config.state, 'failed', jobName);
		fs.mkdirSync(path.dirname(failed), { recursive: true, mode: 0o700 });
		moveTree(processing, failed);
		return false;
	}
	atomicJson(path.join(processing, 'ranked-receipt.json'), result);
	if (result?.receipt?.signature) {
		atomicJson(path.join(config.state, 'outbox', `${jobName.slice(0, -4)}.json`), {
			schema: 1, attempts: 0, nextAttemptAt: 0, receipt: result.receipt,
		});
	}
	const archive = path.join(config.state, 'archive', jobName);
	fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o700 });
	moveTree(processing, archive);
	await flushOutbox(config, fetchImpl);
	return true;
}

export async function scanInbox(config, dependencies) {
	let entries = [];
	try { entries = fs.readdirSync(config.inbox, { withFileTypes: true }); } catch { return; }
	for (const entry of entries)
		if (entry.isDirectory() && JOB.test(entry.name)) await processJob(entry.name, config, dependencies);
}

export async function recoverClaims(config, dependencies) {
	let entries = [];
	try { entries = fs.readdirSync(config.claims, { withFileTypes: true }); } catch { return; }
	for (const entry of entries)
		if (entry.isDirectory() && JOB.test(entry.name)) await processJob(entry.name, config, dependencies);
}

export async function runWorker(config = workerConfig()) {
	fs.mkdirSync(config.claims, { recursive: true, mode: 0o700 });
	for (const dir of ['archive', 'failed', 'outbox', 'rejected'])
		fs.mkdirSync(path.join(config.state, dir), { recursive: true, mode: 0o700 });
	if (!config.privateKeyFile) throw new Error('REDLINE_RANKED_RECEIPT_PRIVATE_KEY_FILE is required');
	assertEnginePin(config);
	for (;;) {
		await recoverClaims(config);
		await scanInbox(config);
		await flushOutbox(config);
		await new Promise(resolve => setTimeout(resolve, config.pollMs));
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile)
	await runWorker();
