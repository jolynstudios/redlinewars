import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	consumeCreateBudget,
	orderedPlacementCandidates,
	roomLifecycleExpiry,
} from './placement-policy.mjs';

const protocol = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'protocol.json'), 'utf8'));

test('release lifecycle constants are pinned to 90 seconds and three hours', () => {
	assert.equal(protocol.timeouts.claimTtlSeconds, 90);
	assert.equal(protocol.timeouts.placedMatchMaxLifetimeSeconds, 3 * 60 * 60);
});

test('donated candidates remain ordered before the owner fallback tier', () => {
	const donated = [{ id: 'donated-fast' }, { id: 'donated-slow' }];
	const owner = [{ id: 'owner-fast' }, { id: 'owner-slow' }];
	assert.deepEqual(orderedPlacementCandidates(donated, owner, true).map(n => n.id),
		['donated-fast', 'donated-slow', 'owner-fast', 'owner-slow']);
	assert.deepEqual(orderedPlacementCandidates(donated, owner, false).map(n => n.id),
		['donated-fast', 'donated-slow']);
});

test('create budget is exactly three attempts in a fixed ten-minute ipKey window', () => {
	const windows = new Map();
	const tenMinutes = 10 * 60_000;
	const start = 123_000;
	for (let attempt = 1; attempt <= 3; attempt++)
		assert.deepEqual(consumeCreateBudget(windows, '2001:db8::/64', start + attempt - 1, tenMinutes, 3),
			{ allowed: true, retryAfterMs: 0 });
	assert.deepEqual(consumeCreateBudget(windows, '2001:db8::/64', start + tenMinutes - 1, tenMinutes, 3),
		{ allowed: false, retryAfterMs: 1 });
	assert.deepEqual(consumeCreateBudget(windows, 'other-ip', start + tenMinutes - 1, tenMinutes, 3),
		{ allowed: true, retryAfterMs: 0 }, 'budgets are isolated by ipKey');
	assert.deepEqual(consumeCreateBudget(windows, '2001:db8::/64', start + tenMinutes, tenMinutes, 3),
		{ allowed: true, retryAfterMs: 0 }, 'the exact ten-minute boundary resets the window');
});

test('placed-room claim TTL is exactly 90 seconds and applies only while unclaimed', () => {
	const room = { hostKey: 'a'.repeat(32), state: 'reserved', reservedAt: 10_000, createdAt: 1_000 };
	assert.equal(roomLifecycleExpiry(room, 99_999, 90_000, 10_800_000), null);
	assert.equal(roomLifecycleExpiry(room, 100_000, 90_000, 10_800_000), 'claim-ttl');
	assert.equal(roomLifecycleExpiry({ ...room, state: 'lobby' }, 100_000, 90_000, 10_800_000), null);
	assert.equal(roomLifecycleExpiry({ ...room, hostKey: null }, 100_000, 90_000, 10_800_000), 'claim-ttl',
		'the existing local creator TTL remains intact');
});

test('placed-match lifetime is an absolute three hours in every room state', () => {
	const max = 3 * 60 * 60_000;
	for (const state of ['booting', 'reserved', 'lobby', 'playing']) {
		const room = { hostKey: 'b'.repeat(32), state, reservedAt: 5_000, createdAt: 1_000 };
		assert.equal(roomLifecycleExpiry(room, 1_000 + max - 1, 90_000, max),
			state === 'reserved' ? 'claim-ttl' : null);
		assert.equal(roomLifecycleExpiry(room, 1_000 + max, 90_000, max), 'max-lifetime');
	}
	assert.equal(roomLifecycleExpiry({ hostKey: null, state: 'playing', createdAt: 1_000 }, 1_000 + max, 90_000, max), null);
});
