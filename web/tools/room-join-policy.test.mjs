import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canJoinFromRoomList } from '../src/ui/room-join-policy.ts'

test('a room-list Join never tears down a seat the player holds', () => {
	for (const phase of ['connecting', 'lobby', 'starting'])
		assert.equal(canJoinFromRoomList(phase, false), false, phase)
	for (const phase of ['idle', 'connecting', 'lobby', 'starting', 'playing', 'ended'])
		assert.equal(canJoinFromRoomList(phase, true), false, `${phase} while a join is under way`)
})

test('browsing stays open, including after a finished match left a stale phase', () => {
	assert.equal(canJoinFromRoomList('idle', false), true)
	// Play again after a network match starts a local skirmish without passing through idle.
	assert.equal(canJoinFromRoomList('playing', false), true)
	assert.equal(canJoinFromRoomList('ended', false), true)
})
