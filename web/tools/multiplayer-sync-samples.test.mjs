import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncSamples } from './multiplayer-sync-samples.mjs';

test('offset sampling with a shared tick counts one match', () => {
	const s = createSyncSamples();
	// Client A saw tick 100 with hash 42; client B sampled tick 99 first, then
	// tick 100. The shared tick must match despite offset histories.
	s.add(0, [{ tick: 100, hash: 42 }]);
	s.add(1, [{ tick: 99, hash: 1 }, { tick: 100, hash: 42 }]);
	assert.deepEqual(s.result(), { matchedTicks: 1, mismatches: 0 });
	// The compared tick cannot be counted twice by a later duplicate probe.
	s.add(0, [{ tick: 100, hash: 42 }]);
	s.add(1, [{ tick: 100, hash: 42 }]);
	assert.deepEqual(s.result(), { matchedTicks: 1, mismatches: 0 });
});

test('disjoint histories produce zero matching ticks', () => {
	const s = createSyncSamples();
	s.add(0, [{ tick: 5, hash: 1 }, { tick: 6, hash: 2 }]);
	s.add(1, [{ tick: 7, hash: 3 }, { tick: 8, hash: 4 }]);
	assert.deepEqual(s.result(), { matchedTicks: 0, mismatches: 0 });
});

test('same tick with unequal hashes throws with tick and both hashes', () => {
	const s = createSyncSamples();
	s.add(0, [{ tick: 12, hash: 0xDEAD }]);
	assert.throws(
		() => s.add(1, [{ tick: 12, hash: 0xBEEF }]),
		/tick 12.*clientA=57005.*clientB=48879/);
});

test('malformed samples are rejected', () => {
	const s = createSyncSamples();
	assert.throws(() => s.add(0, [{ tick: -1, hash: 1 }]), /malformed/);
	assert.throws(() => s.add(0, [{ tick: 1.5, hash: 1 }]), /malformed/);
	assert.throws(() => s.add(0, [{ tick: 1, hash: -1 }]), /malformed/);
	assert.throws(() => s.add(2, [{ tick: 1, hash: 1 }]), /invalid clientIndex/);
	assert.throws(() => s.add(0, 'nope'), /array/);
});

test('unmatched ticks evict oldest beyond the pending cap', () => {
	const s = createSyncSamples({ maxPendingTicks: 4 });
	// Client A runs ahead: ticks 0..5 land with no counterpart on client B.
	for (let tick = 0; tick < 10; tick++)
		s.add(0, [{ tick, hash: tick }]);
	// Only the most recent 4 survive; earlier ticks were evicted.
	s.add(1, [{ tick: 0, hash: 0 }]); // too old to match A's history
	assert.deepEqual(s.result(), { matchedTicks: 0, mismatches: 0 });
	// A recent tick still matches.
	s.add(1, [{ tick: 9, hash: 9 }]);
	assert.deepEqual(s.result(), { matchedTicks: 1, mismatches: 0 });
});
