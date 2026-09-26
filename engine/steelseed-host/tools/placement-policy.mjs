// Placement lifecycle policy shared by the relay and room host. Keep the
// boundary arithmetic here so release gates can exercise the exact instants
// without sleeping for ten minutes or three hours.

export function orderedPlacementCandidates(donated, owner, allowOwner) {
	return allowOwner ? [...donated, ...owner] : [...donated];
}

export function consumeCreateBudget(windows, key, now, windowMs, limit) {
	let window = windows.get(key);
	if (!window || now - window.start >= windowMs) {
		window = { start: now, count: 0 };
		windows.set(key, window);
	}
	if (window.count >= limit)
		return { allowed: false, retryAfterMs: Math.max(0, window.start + windowMs - now) };
	window.count++;
	return { allowed: true, retryAfterMs: 0 };
}

export function roomLifecycleExpiry(room, now, claimTtlMs, placedMatchMaxLifetimeMs) {
	if (room.state === 'ending' || room.state === 'ended') return null;
	// A hostKey is the durable distinction between a relay-placed match and
	// local/standing rooms. The absolute cap wins if both boundaries coincide.
	if (room.hostKey && Number.isFinite(room.createdAt) && now - room.createdAt >= placedMatchMaxLifetimeMs)
		return 'max-lifetime';
	if (room.state === 'reserved' && Number.isFinite(room.reservedAt) && now - room.reservedAt >= claimTtlMs)
		return 'claim-ttl';
	return null;
}
