// Seat census (owner 2026-09-29: "if i open a room without me playing why
// does it count me as a player, when hosting in that mode?"). The engine's
// STEELSEED_ROOM line is the only seat truth on stdout — the node's
// connection count stays for liveness (reaper, drain), while the directory
// row counts seats. handleRoomLine owns the translation; these tests pin it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRoomCensus } from './roomhost.mjs';

const uid = char => char.repeat(40);
const freshRoom = (over = {}) => ({
	players: 0, seated: null, capacity: null, liveMap: null, censusSeen: false,
	state: 'booting', ranked: false, map: uid('a'), slots: 2, ...over,
});

test('a census while empty keeps the advertised size — the map is not arranged yet', () => {
	const room = freshRoom({ state: 'lobby' });
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=0 observers=0 slots=8 map=${uid('f')}`);
	assert.equal(room.seated, 0);
	assert.equal(room.capacity, null, 'an empty standing room must keep advertising its configured size, not the map width');
	assert.equal(room.liveMap, null);
	assert.equal(room.censusSeen, false);
});

test('a spectator joins: seated stays zero — the host without playing is not a player', () => {
	const room = freshRoom({ state: 'lobby' });
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=0 observers=1 slots=8 map=${uid('f')}`);
	assert.equal(room.seated, 0);
	assert.equal(room.censusSeen, true, 'any occupant makes the engine arrangement authoritative');
	assert.equal(room.capacity, 8);
	assert.equal(room.liveMap, uid('f'));
});

test('the admin resizes and re-maps: the census follows', () => {
	const room = freshRoom({ state: 'lobby' });
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=1 observers=0 slots=2 map=${uid('f')}`);
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=1 observers=0 slots=5 map=${uid('b')}`);
	assert.deepEqual([room.seated, room.capacity, room.liveMap], [1, 5, uid('b')]);
});

test('after the room empties the last arrangement survives', () => {
	const room = freshRoom({ state: 'lobby' });
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=1 observers=0 slots=5 map=${uid('b')}`);
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=0 observers=0 slots=5 map=${uid('b')}`);
	assert.deepEqual([room.seated, room.capacity, room.liveMap], [0, 5, uid('b')]);
});

test('re-delivering an unchanged census moves nothing — no registry churn per sync', () => {
	const room = freshRoom({ state: 'lobby' });
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=1 observers=0 slots=2 map=${uid('f')}`);
	const before = { ...room };
	applyRoomCensus(room, `[ts] STEELSEED_ROOM seated=1 observers=0 slots=2 map=${uid('f')}`);
	assert.deepEqual({ ...room }, before);
});
