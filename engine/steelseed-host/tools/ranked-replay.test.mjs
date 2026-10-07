import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { classifyReplayObservation, retainReplay } from './ranked-replay.mjs';
import { verifyRankedReplay } from './ranked-replay.mjs';
import { canonicalJson } from './ranked-claims.mjs';

const players = [
	{ outcome: 'won', disconnectFrame: null },
	{ outcome: 'lost', disconnectFrame: null },
];

test('ranked replay policy voids ambiguous transport termination and settles engine terminal first', () => {
	assert.deepEqual(classifyReplayObservation({ replayValid: true, terminal: true,
		players: players.map(p => ({ ...p, disconnectFrame: 42 })) }),
		{ status: 'void', reason: 'both-disconnected' });
	assert.deepEqual(classifyReplayObservation({ replayValid: true, terminal: true,
		terminalBeforeDisconnect: true, players: players.map(p => ({ ...p, disconnectFrame: 42 })) }),
		{ status: 'settled', terminationReason: 'gameover' });
	assert.deepEqual(classifyReplayObservation({ replayValid: true, terminal: true,
		players: [{ outcome: 'won', disconnectFrame: null }, { outcome: 'lost', disconnectFrame: 42 }] }),
		{ status: 'settled', terminationReason: 'disconnect-forfeit' });
});

test('ranked replay custody writes hash and pending settlement metadata', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-replay-'));
	try {
		const replayFile = path.join(root, 'match.orarep');
		const roomDir = path.join(root, 'custody');
		fs.writeFileSync(replayFile, 'same-engine-replay');
		const result = retainReplay({ replayFile, roomDir,
			roomClaim: { matchId: 'm1', nonce: 'n1', simBuild: 'build-1' },
			observation: { replayValid: true, terminal: true,
				players: [{ outcome: 'won', disconnectFrame: null }, { outcome: 'lost', disconnectFrame: null }] } });
		assert.equal(result.status, 'settled');
		const custody = JSON.parse(fs.readFileSync(path.join(roomDir, 'ranked-custody.json'), 'utf8'));
		assert.equal(custody.replaySha256, result.replaySha256);
		assert.equal(custody.matchId, 'm1');
		assert.equal(custody.terminationReason, 'gameover');
		// Windows exposes synthetic mode bits and does not implement POSIX file
		// permissions. The production custody service is Linux/systemd; assert the
		// owner-only contract everywhere the platform can actually enforce it.
		if (process.platform !== 'win32')
			assert.equal((fs.statSync(path.join(roomDir, 'ranked-custody.json')).mode & 0o777), 0o600);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('ranked replay gate signs settled output only after local sim/rules pins and seat binding', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-replay-gate-'));
	try {
		const replayFile = path.join(root, 'match.orarep');
		fs.writeFileSync(replayFile, 'replay-bytes');
		const claim = { kid: 'test', matchId: 'm2', nonce: 'n2', simBuild: 'build-2', mapUid: 'map-2', rulesHash: 'rules-2',
			issuedAt: 10, participants: [{ userId: 'u1', seat: 1, team: 1, clientIndex: 1 }, { userId: 'u2', seat: 2, team: 2, clientIndex: 2 }] };
		const key = crypto.generateKeyPairSync('ed25519');
		const privateKey = key.privateKey.export({ format: 'pem', type: 'pkcs8' });
		const fixture = path.join(import.meta.dirname, 'ranked-replay-fixture-verifier.mjs');
		const settled = await verifyRankedReplay({ replayFile, claim, verifier: process.execPath, verifierArgs: [fixture],
			privateKey, localSimBuild: 'build-2', localRulesHash: 'rules-2', endedAt: 20,
			verifierEnv: { STEELSEED_FIXTURE_SCHEMA: 'pascal' } });
		assert.equal(settled.receipt.status, 'settled');
		assert.ok(settled.signature);
		const unsigned = { ...settled.receipt }; delete unsigned.signature;
		assert.equal(crypto.verify(null, Buffer.from(canonicalJson(unsigned)), key.publicKey, Buffer.from(settled.signature, 'base64url')), true);
		const wrongBuild = await verifyRankedReplay({ replayFile, claim, verifier: process.execPath, verifierArgs: [fixture],
			privateKey, localSimBuild: 'wrong', localRulesHash: 'rules-2', endedAt: 20 });
		assert.equal(wrongBuild.receipt.status, 'void');
		assert.equal(wrongBuild.receipt.reason, 'wrong-build');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('ranked receipt signing accepts only a protected key file and embeds the signature', {
	skip: process.platform === 'win32' ? 'POSIX key-file modes are enforced by the Linux owner-node service' : false,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-replay-keyfile-'));
	try {
		const replayFile = path.join(root, 'match.orarep');
		const keyFile = path.join(root, 'receipt-key.pem');
		fs.writeFileSync(replayFile, 'replay-bytes');
		const claim = { kid: 'file-key', matchId: 'm3', nonce: 'n3', simBuild: 'build-3', mapUid: 'map-3', rulesHash: 'rules-3',
			participants: [{ userId: 'u1', seat: 1, team: 1, clientIndex: 1 }, { userId: 'u2', seat: 2, team: 2, clientIndex: 2 }] };
		const key = crypto.generateKeyPairSync('ed25519');
		fs.writeFileSync(keyFile, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
		const fixture = path.join(import.meta.dirname, 'ranked-replay-fixture-verifier.mjs');
		const signed = await verifyRankedReplay({ replayFile, claim, verifier: process.execPath, verifierArgs: [fixture],
			privateKeyFile: keyFile, localSimBuild: 'build-3', localRulesHash: 'rules-3' });
		assert.equal(signed.receipt.status, 'settled');
		assert.equal(signed.receipt.signature, signed.signature);
		const unsigned = { ...signed.receipt }; delete unsigned.signature;
		assert.equal(crypto.verify(null, Buffer.from(canonicalJson(unsigned)), key.publicKey, Buffer.from(signed.receipt.signature, 'base64url')), true);
		fs.chmodSync(keyFile, 0o644);
		const rejected = await verifyRankedReplay({ replayFile, claim, verifier: process.execPath, verifierArgs: [fixture],
			privateKeyFile: keyFile, localSimBuild: 'build-3', localRulesHash: 'rules-3' });
		assert.equal(rejected.receipt.status, 'void');
		assert.equal(rejected.receipt.reason, 'owner-infrastructure');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
