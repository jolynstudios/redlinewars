import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { assertEnginePin, deliverOutbox, processJob, recoverClaims } from './ranked-worker.mjs';

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-worker-'));
	const config = {
		inbox: path.join(root, 'spool', 'inbox'), claims: path.join(root, 'spool', 'processing'),
		state: path.join(root, 'state'), privateKeyFile: path.join(root, 'receipt.pem'),
		settlementUrl: 'http://127.0.0.1:8787/api/ranked/settlements', settlementToken: 'x'.repeat(32),
		localSimBuild: 'build-1', localRulesHash: 'a'.repeat(64),
	};
	for (const dir of [config.inbox, config.claims, config.state]) fs.mkdirSync(dir, { recursive: true });
	return { root, config, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function job(config, name = `${'1'.repeat(32)}.job`) {
	const dir = path.join(config.inbox, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ schema: 1, endedAt: 2,
		claim: { kid: 'k', matchId: 'match-1', nonce: 'nonce-1', simBuild: 'build-1', rulesHash: 'a'.repeat(64), participants: [{ userId: 'u1' }, { userId: 'u2' }] } }));
	fs.writeFileSync(path.join(dir, 'replay.orarep'), 'orders');
	return name;
}

describe('isolated Ranked worker', () => {
	test('pins the verifier to the assembled sim build and generated mod hash', () => {
		const engineRoot = path.resolve(import.meta.dirname, '../..');
		const build = JSON.parse(fs.readFileSync(path.join(engineRoot, 'steelseed-host/generated/build.json'), 'utf8'));
		assert.equal(assertEnginePin({ engineRoot, localSimBuild: build.simBuild }).simBuild, build.simBuild);
		assert.throws(() => assertEnginePin({ engineRoot, localSimBuild: 'wrong' }), /sim build pin/);
	});

	test('atomically claims a complete job, archives verifier-owned output and settles from a durable outbox', async () => {
		const f = fixture();
		try {
			const name = job(f.config); let verified = 0; let delivered = 0;
			const ok = await processJob(name, f.config, {
				verify: async args => {
					verified += 1;
					assert.equal(fs.readFileSync(args.replayFile, 'utf8'), 'orders');
					assert.equal(args.localSimBuild, 'build-1');
					return { receipt: { schema: 1, matchId: 'match-1', signature: 'signed' } };
				},
				fetchImpl: async (_url, request) => {
					delivered += 1; assert.equal(request.headers['x-ranked-worker-token'], 'x'.repeat(32));
					return { ok: true, status: 200 };
				},
			});
			assert.equal(ok, true); assert.equal(verified, 1); assert.equal(delivered, 1);
			assert.equal(fs.existsSync(path.join(f.config.inbox, name)), false);
			assert.equal(fs.existsSync(path.join(f.config.claims, name)), false);
			assert.equal(fs.existsSync(path.join(f.config.state, 'archive', name, 'ranked-receipt.json')), true);
			assert.deepEqual(fs.readdirSync(path.join(f.config.state, 'outbox')), []);
		} finally { f.close(); }
	});

	test('rejects symlinks without invoking the verifier', async () => {
		const f = fixture();
		try {
			const name = job(f.config, `${'2'.repeat(32)}.job`);
			fs.symlinkSync('/etc/passwd', path.join(f.config.inbox, name, 'extra'));
			let called = false;
			assert.equal(await processJob(name, f.config, { verify: async () => { called = true; } }), false);
			assert.equal(called, false);
			assert.equal(fs.existsSync(path.join(f.config.state, 'failed', name, 'worker-error.json')), true);
		} finally { f.close(); }
	});

	test('recovers an atomically claimed job after restart', async () => {
		const f = fixture();
		try {
			const name = job(f.config, `${'3'.repeat(32)}.job`);
			fs.renameSync(path.join(f.config.inbox, name), path.join(f.config.claims, name));
			await recoverClaims(f.config, { verify: async () => ({ receipt: { signature: 'signed' } }), fetchImpl: async () => ({ ok: true, status: 200 }) });
			assert.equal(fs.existsSync(path.join(f.config.state, 'archive', name)), true);
		} finally { f.close(); }
	});

	test('keeps transient settlement failures in outbox with backoff', async () => {
		const f = fixture();
		try {
			const file = path.join(f.config.state, 'outbox', 'job.json');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ receipt: { signature: 'signed' }, attempts: 0, nextAttemptAt: 0 }));
			assert.equal(await deliverOutbox(file, f.config, async () => ({ ok: false, status: 503 })), false);
			const retry = JSON.parse(fs.readFileSync(file, 'utf8'));
			assert.equal(retry.attempts, 1); assert.ok(retry.nextAttemptAt > Date.now());
		} finally { f.close(); }
	});
});
