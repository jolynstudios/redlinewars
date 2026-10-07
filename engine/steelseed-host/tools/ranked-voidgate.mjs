#!/usr/bin/env node
// T6.13 negative gate: admission/replay settlement must void anything the
// same-engine verifier cannot prove. It is intentionally independent of the
// browser and account service.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyRankedReplay } from './ranked-replay.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-voidgate-'));
const fixture = path.join(import.meta.dirname, 'ranked-replay-fixture-verifier.mjs');
const replayFile = path.join(root, 'match.orarep');
fs.writeFileSync(replayFile, 'fixture-replay');
const key = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
const claim = { kid: 'gate', matchId: 'gate-match', nonce: 'gate-nonce', simBuild: 'gate-build', mapUid: 'gate-map', rulesHash: 'gate-rules',
	issuedAt: 1, participants: [{ userId: 'a', seat: 1, team: 1, clientIndex: 1 }, { userId: 'b', seat: 2, team: 2, clientIndex: 2 }] };
const cases = ['desync', 'invalid-replay', 'incomplete', 'both-disconnected', 'ambiguous', 'surrender', 'disconnect-forfeit'];
try {
	for (const mode of cases) {
		const result = await verifyRankedReplay({ replayFile, claim, verifier: process.execPath, verifierArgs: [fixture], verifierEnv: { STEELSEED_FIXTURE_RESULT: mode },
			privateKey: key, localSimBuild: 'gate-build', localRulesHash: 'gate-rules' });
		if (mode === 'surrender' || mode === 'disconnect-forfeit') assert.equal(result.receipt.status, 'settled');
		else assert.equal(result.receipt.status, 'void');
	}
	for (const [field, value] of [['localSimBuild', 'wrong-build'], ['localRulesHash', 'wrong-rules']]) {
		const result = await verifyRankedReplay({ replayFile, claim, verifier: process.execPath, verifierArgs: [fixture], privateKey: key,
			localSimBuild: field === 'localSimBuild' ? value : 'gate-build', localRulesHash: field === 'localRulesHash' ? value : 'gate-rules' });
		assert.equal(result.receipt.status, 'void');
	}
	console.log('ranked-voidgate PASS');
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
