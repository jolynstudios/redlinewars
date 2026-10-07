// Owner-node replay custody and settlement policy.
//
// This module never calculates combat or victory in JavaScript. It validates
// the verifier's engine-produced observation, applies only the outer
// infrastructure policy, and writes immutable custody metadata next to the
// replay. The actual state observation must come from the same-engine replay
// worker.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson } from './ranked-claims.mjs';

const execFileAsync = promisify(execFile);

const RID_MAP = {
	'darwin-arm64': 'osx-arm64', 'darwin-x64': 'osx-x64',
	'win32-x64': 'win-x64', 'win32-arm64': 'win-x64',
	'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64',
};

// The verifier is part of the node's native bundle, not a JavaScript fallback.
// Release assemblies place it beside the self-contained server; developer
// builds also expose the framework-dependent output under openra/bin.
export function resolveRankedVerifier(root = process.env.REDLINE_ENGINE_DIR ?? process.cwd()) {
	if (typeof process.env.REDLINE_RANKED_VERIFIER === 'string' && process.env.REDLINE_RANKED_VERIFIER.length > 0)
		return process.env.REDLINE_RANKED_VERIFIER;
	const rid = RID_MAP[`${process.platform}-${process.arch}`];
	if (!rid) return null;
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const candidates = [
		path.join(root, 'bin-standalone', rid, 'ranked-replay-verifier', `Steelseed.RankedReplayVerifier${suffix}`),
		path.join(root, 'bin', 'ranked-replay-verifier', `Steelseed.RankedReplayVerifier${suffix}`),
		path.join(root, 'openra', 'bin', 'ranked-replay-verifier', `Steelseed.RankedReplayVerifier${suffix}`),
	];
	return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

export const VOID_REASONS = new Set([
	'desync', 'owner-infrastructure', 'both-disconnected', 'invalid-replay', 'incomplete', 'ambiguous',
	'wrong-map', 'wrong-build', 'wrong-rules', 'roster-unbound', 'verifier-unavailable', 'verifier-error',
]);

export function replaySha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function voidReceipt(claim, replayHash, reason, endedAt) {
	return {
		schema: 1,
		kid: claim?.kid ?? null,
		matchId: claim?.matchId ?? null,
		roomNonce: claim?.nonce ?? null,
		simBuild: claim?.simBuild ?? null,
		mapUid: claim?.mapUid ?? null,
		rulesHash: claim?.rulesHash ?? null,
		replaySha256: replayHash,
		startedAt: claim?.startedAt ?? claim?.issuedAt ?? null,
		endedAt,
		finalTick: 0,
		status: 'void',
		reason,
		players: (claim?.participants ?? []).map(player => ({
			userId: player.userId, seat: player.seat, clientIndex: player.clientIndex ?? null,
			team: player.team, outcome: 'void', disconnectFrame: null, surrendered: false,
		})),
	};
}

function readReceiptPrivateKey(privateKey, privateKeyFile) {
	// Production custody uses a protected file. The direct key argument remains
	// available to isolated tests, but the ambient multiline secret env is not
	// accepted as a production default.
	if (privateKeyFile) {
		const stat = fs.statSync(privateKeyFile);
		if ((stat.mode & 0o077) !== 0) throw new Error('ranked receipt key file is group/world accessible');
		return fs.readFileSync(privateKeyFile, 'utf8').trim();
	}
	return privateKey ?? null;
}

function signReceipt(receipt, privateKey) {
	if (!privateKey) return null;
	try {
		return crypto.sign(null, Buffer.from(canonicalJson(receipt)), crypto.createPrivateKey(privateKey)).toString('base64url');
	} catch { return null; }
}

// Run the actual same-engine verifier. This adapter performs only pin and
// receipt assembly work; it never turns replay metadata or transport state
// into an outcome. A missing verifier, local rules pin, or seat binding is a
// signed void receipt rather than a guessed result.
export async function verifyRankedReplay({ replayFile, claim, verifier = resolveRankedVerifier(),
	privateKey, privateKeyFile = process.env.REDLINE_RANKED_RECEIPT_PRIVATE_KEY_FILE, localSimBuild = process.env.REDLINE_RANKED_SIM_BUILD,
	localRulesHash = process.env.REDLINE_RANKED_RULES_HASH, verifierArgs = [], verifierEnv = {}, endedAt = Date.now() } = {}) {
	const replayHash = typeof replayFile === 'string' && fs.existsSync(replayFile) ? replaySha256(replayFile) : null;
	let receipt;
	if (!replayHash) receipt = voidReceipt(claim, replayHash, 'invalid-replay', endedAt);
	else if (typeof verifier !== 'string' || verifier.length === 0) receipt = voidReceipt(claim, replayHash, 'verifier-unavailable', endedAt);
	else if (typeof localSimBuild !== 'string' || localSimBuild !== claim?.simBuild) receipt = voidReceipt(claim, replayHash, 'wrong-build', endedAt);
	else if (typeof localRulesHash !== 'string' || localRulesHash !== claim?.rulesHash) receipt = voidReceipt(claim, replayHash, 'wrong-rules', endedAt);
	else {
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'steelseed-ranked-verify-'));
		const claimFile = path.join(tempRoot, 'claim.json');
		try {
			fs.writeFileSync(claimFile, `${JSON.stringify({ ...claim, participants: claim.participants ?? [] })}\n`, { mode: 0o600 });
			let result;
			try {
				const output = await execFileAsync(verifier, [...verifierArgs, '--replay', replayFile, '--claim', claimFile], {
					env: { ...process.env, ...verifierEnv, REDLINE_RANKED_RULES_HASH: localRulesHash },
					maxBuffer: 2 * 1024 * 1024, timeout: 180_000, killSignal: 'SIGKILL',
				});
				result = JSON.parse(output.stdout.trim().split('\n').at(-1));
			} catch (error) {
				try { result = JSON.parse(String(error.stdout ?? '').trim().split('\n').at(-1)); }
				catch { result = { status: 'void', reason: 'verifier-error' }; }
			}
			const resultStatus = result?.Status ?? result?.status;
			const resultReason = result?.Reason ?? result?.reason;
			const resultReplayHash = result?.ReplaySha256 ?? result?.replaySha256;
			if (!result || resultStatus !== 'settled') receipt = voidReceipt(claim, replayHash, resultReason ?? 'incomplete', endedAt);
			else if (resultReplayHash && resultReplayHash !== replayHash) receipt = voidReceipt(claim, replayHash, 'invalid-replay', endedAt);
			else {
				const expected = new Map((claim.participants ?? []).filter(p => Number.isInteger(p.clientIndex)).map(p => [p.clientIndex, p]));
				const rawPlayers = Array.isArray(result.Players) ? result.Players : Array.isArray(result.players) ? result.players : [];
				if (rawPlayers.length < 2 || rawPlayers.some(p => !expected.has(p.ClientIndex ?? p.clientIndex)))
					receipt = voidReceipt(claim, replayHash, 'roster-unbound', endedAt);
				else receipt = {
					...voidReceipt(claim, replayHash, null, endedAt),
					finalTick: result.FinalTick ?? result.finalTick ?? 0,
					status: 'settled',
					terminationReason: result.TerminationReason ?? result.terminationReason ?? 'gameover',
					players: rawPlayers.map(raw => {
						const clientIndex = raw.ClientIndex ?? raw.clientIndex;
						const p = expected.get(clientIndex);
						return { userId: p.userId, seat: p.seat, clientIndex, team: p.team,
							outcome: raw.Outcome ?? raw.outcome, disconnectFrame: raw.DisconnectFrame ?? raw.disconnectFrame ?? null,
							surrendered: raw.Surrendered ?? raw.surrendered === true };
					}),
				};
			}
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	}
	let signingKey = null;
	try { signingKey = readReceiptPrivateKey(privateKey, privateKeyFile); }
	catch { receipt = voidReceipt(claim, replayHash, 'owner-infrastructure', endedAt); }
	const signature = signReceipt(receipt, signingKey);
	if (receipt.status === 'settled' && !signature)
		receipt = voidReceipt(claim, replayHash, 'owner-infrastructure', endedAt);
	const finalSignature = signReceipt(receipt, signingKey);
	// The account service accepts the signed receipt as the request payload. Keep
	// the detached field for node custody/tooling, but embed the same signature
	// in `receipt` so forwarding cannot accidentally drop it.
	return { receipt: finalSignature ? { ...receipt, signature: finalSignature } : receipt,
		signature: finalSignature, algorithm: 'ed25519', keyId: claim?.kid ?? null };
}

export function classifyReplayObservation(observation) {
	if (!observation || typeof observation !== 'object') return { status: 'void', reason: 'invalid-replay' };
	if (observation.desync === true) return { status: 'void', reason: 'desync' };
	if (observation.ownerInfrastructureHealthy === false) return { status: 'void', reason: 'owner-infrastructure' };
	if (observation.replayValid !== true) return { status: 'void', reason: 'invalid-replay' };
	if (observation.terminal !== true || !Array.isArray(observation.players) || observation.players.length < 2)
		return { status: 'void', reason: 'incomplete' };
	if (observation.ambiguous === true) return { status: 'void', reason: 'ambiguous' };
	if (observation.players.some(player => !['won', 'lost'].includes(player?.outcome)))
		return { status: 'void', reason: 'ambiguous' };
	const surrendered = observation.players.find(player => player.surrendered === true);
	const dropped = observation.players.filter(player => player.disconnectFrame !== null && player.disconnectFrame !== undefined);
	// A terminal engine frame is authoritative even when a later transport
	// close is present. This is the distinction between a completed match and
	// a connection failure observed after the result was already recorded.
	if (observation.terminalBeforeDisconnect === true)
		return { status: 'settled', terminationReason: surrendered ? 'surrender' : 'gameover' };
	if (observation.players.every(player => player?.disconnectFrame !== null && player?.disconnectFrame !== undefined))
		return { status: 'void', reason: 'both-disconnected' };
	if (surrendered) return { status: 'settled', terminationReason: 'surrender' };
	if (dropped.length === 1) return { status: 'settled', terminationReason: 'disconnect-forfeit' };
	return { status: 'settled', terminationReason: 'gameover' };
}

export function retainReplay({ replayFile, roomDir, roomClaim, observation, endedAt = Date.now() }) {
	if (typeof replayFile !== 'string' || typeof roomDir !== 'string') throw new TypeError('replay custody paths are required');
	if (!fs.existsSync(replayFile)) return { status: 'void', reason: 'invalid-replay' };
	const classification = classifyReplayObservation(observation);
	const replayHash = replaySha256(replayFile);
	const custody = {
		schema: 1,
		matchId: roomClaim?.matchId ?? null,
		roomNonce: roomClaim?.nonce ?? null,
		simBuild: roomClaim?.simBuild ?? null,
		replaySha256: replayHash,
		endedAt,
		...classification,
	};
	fs.mkdirSync(roomDir, { recursive: true });
	const custodyPath = path.join(roomDir, 'ranked-custody.json');
	fs.writeFileSync(custodyPath, `${JSON.stringify(custody)}\n`, { mode: 0o600 });
	return { ...custody, custodyPath };
}
