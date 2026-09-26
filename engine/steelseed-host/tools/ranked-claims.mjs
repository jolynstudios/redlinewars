// Ranked admission claims shared by the relay and the owner node.
//
// Claims are deliberately control-plane data. They never enter OpenRA orders
// or lobby strings. The account service owns the signing key; the relay only
// verifies and atomically consumes the participant nonce.
import crypto from 'node:crypto';

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
	}
	return value;
}

export function canonicalJson(value) {
	return JSON.stringify(canonical(value));
}

function b64(value) {
	return Buffer.from(value).toString('base64url');
}

function unb64(value) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
	try { return Buffer.from(value, 'base64url'); } catch { return null; }
}

export function signClaim(payload, secret) {
	if (typeof secret !== 'string' || secret.length < 16) throw new Error('ranked claim secret is missing or too short');
	const body = canonicalJson(payload);
	const mac = crypto.createHmac('sha256', secret).update(body).digest();
	return `${b64(body)}.${b64(mac)}`;
}

export function verifyClaim(token, secret) {
	if (typeof secret !== 'string' || secret.length < 16 || typeof token !== 'string') return null;
	const [encodedBody, encodedMac, extra] = token.split('.');
	if (!encodedBody || !encodedMac || extra !== undefined) return null;
	const body = unb64(encodedBody);
	const mac = unb64(encodedMac);
	if (!body || !mac || mac.length !== 32) return null;
	const expected = crypto.createHmac('sha256', secret).update(body).digest();
	if (!crypto.timingSafeEqual(mac, expected)) return null;
	let payload;
	try { payload = JSON.parse(body.toString('utf8')); } catch { return null; }
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
	return payload;
}

export function claimDigest(token) {
	return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function validRankedRoomClaim(claim, now = Date.now()) {
	return !!claim && claim.schema === 2 && claim.mode === 'ranked' && claim.tier === 'owner' &&
		typeString(claim.matchId, 128) && typeString(claim.roomId, 64) &&
		typeString(claim.nodeId, 64) && typeString(claim.simBuild, 64) &&
		typeString(claim.mapUid, 64) && typeString(claim.rulesHash, 128) &&
		typeString(claim.nonce, 128) && Number.isSafeInteger(claim.issuedAt) &&
		Number.isSafeInteger(claim.expiresAt) && claim.expiresAt > now &&
		claim.expiresAt > claim.issuedAt && /^[0-9a-f]{64}$/.test(String(claim.hostKeyHash ?? ''));
}

export function validParticipantClaim(claim, now = Date.now()) {
	const room = claim?.room ?? claim;
	return validRankedRoomClaim(room, now) &&
		typeString(claim.userId, 128) && Number.isInteger(claim.seat) && claim.seat >= 1 && claim.seat <= 8 &&
		Number.isInteger(claim.team) && claim.team >= 0 && claim.team <= 8 &&
		typeString(claim.participantNonce, 128) &&
		(claim.profileVersion === undefined || Number.isInteger(claim.profileVersion));
}

function typeString(value, max) {
	return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function hostKeyHash(hostKey) {
	return crypto.createHash('sha256').update(String(hostKey)).digest('hex');
}

export function randomHostKey() {
	return crypto.randomBytes(16).toString('hex');
}
