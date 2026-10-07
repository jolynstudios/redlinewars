import test from 'node:test';
import assert from 'node:assert/strict';
import { rankedObserveServerBytes } from './ranked-binding.mjs';
import { signClaim } from './ranked-claims.mjs';

function dotnetString(value) {
	const bytes = Buffer.from(value, 'utf8');
	const out = [];
	let length = bytes.length;
	while (length >= 0x80) { out.push((length & 0x7f) | 0x80); length >>>= 7; }
	out.push(length);
	return Buffer.concat([Buffer.from(out), bytes]);
}

function syncInfoFrame(target) {
	const fields = Buffer.alloc(2);
	fields.writeUInt16LE(0x04);
	const packet = Buffer.concat([Buffer.alloc(4), Buffer.from([0xff]), dotnetString('SyncInfo'), fields, dotnetString(target)]);
	const header = Buffer.alloc(8);
	// OpenRA Server.CreateFrame length includes the 4-byte simulation frame,
	// but not the client index stored beside it in this header.
	header.writeInt32LE(packet.length, 0);
	header.writeInt32LE(0, 4);
	return Buffer.concat([header, packet]);
}

function roomFor(claim) {
	return { ranked: true, participantClaims: [claim], rankedBindings: new Map(), rankedBindingByClient: new Map(), rankedBindingError: null };
}

function claim(seat, team) {
	return signClaim({ schema: 2, mode: 'ranked', tier: 'owner', matchId: 'match', roomId: '0123456789abcdef',
		nodeId: 'node', simBuild: 'build', mapUid: 'a'.repeat(40), rulesHash: 'b'.repeat(64),
		issuedAt: 1, expiresAt: Date.now() + 60_000, nonce: `nonce-${seat}`, hostKeyHash: 'c'.repeat(64),
		userId: `user-${seat}`, seat, team, participantNonce: `participant-${seat}` }, 'binding-test-secret-0123456789');
}

test('ranked binding records server-assigned ClientIndex and validates slot seat/team', () => {
	const token = claim(1, 1);
	const room = roomFor(token);
	const channel = { claim: token, chanId: 4, observeBuffer: Buffer.alloc(0) };
	let closed = false;
	rankedObserveServerBytes(room, channel, Buffer.concat([Buffer.from([7, 0, 0, 0, 3, 0, 0, 0]), syncInfoFrame('Client@3:\n    Team: 1\n    Slot: Multi0\n')]), () => { closed = true; });
	assert.equal(closed, false);
	assert.deepEqual(room.rankedBindings.get(token), { chanId: 4, clientIndex: 3, seat: 1, team: 1 });
});

test('ranked binding voids swapped claims and reused server ClientIndex', () => {
	const swapped = claim(2, 1);
	const room = roomFor(swapped);
	const channel = { claim: swapped, chanId: 5, observeBuffer: Buffer.alloc(0) };
	let closed = false;
	rankedObserveServerBytes(room, channel, Buffer.concat([Buffer.from([7, 0, 0, 0, 3, 0, 0, 0]), syncInfoFrame('Client@3:\n    Team: 1\n    Slot: Multi0\n')]), () => { closed = true; });
	assert.equal(closed, true);
	assert.equal(room.rankedBindingError, 'ranked-seat-or-team-mismatch');

	const reused = claim(1, 1);
	const secondRoom = roomFor(reused);
	secondRoom.rankedBindingByClient.set(3, 'existing-claim');
	const second = { claim: reused, chanId: 6, observeBuffer: Buffer.alloc(0) };
	closed = false;
	rankedObserveServerBytes(secondRoom, second, Buffer.from([7, 0, 0, 0, 3, 0, 0, 0]), () => { closed = true; });
	assert.equal(closed, true);
	assert.equal(secondRoom.rankedBindingError, 'invalid-or-duplicate-client-index');

	const duplicateRoom = roomFor(reused);
	duplicateRoom.rankedBindings.set(reused, { chanId: 7, clientIndex: 2, seat: 1, team: 1 });
	const duplicate = { claim: reused, chanId: 8, observeBuffer: Buffer.alloc(0) };
	closed = false;
	rankedObserveServerBytes(duplicateRoom, duplicate, Buffer.from([7, 0, 0, 0, 4, 0, 0, 0]), () => { closed = true; });
	assert.equal(closed, true);
	assert.equal(duplicateRoom.rankedBindingError, 'duplicate-participant-claim');

	const malformedRoom = roomFor(claim(1, 1));
	const malformed = { claim: malformedRoom.participantClaims[0], chanId: 9, observeBuffer: Buffer.alloc(0) };
	closed = false;
	const oversized = Buffer.alloc(8);
	oversized.writeInt32LE(16 * 1024 * 1024 + 1, 0);
	rankedObserveServerBytes(malformedRoom, malformed, Buffer.concat([Buffer.from([7, 0, 0, 0, 4, 0, 0, 0]), oversized]), () => { closed = true; });
	assert.equal(closed, true);
	assert.equal(malformedRoom.rankedBindingError, 'invalid-server-frame');
});
