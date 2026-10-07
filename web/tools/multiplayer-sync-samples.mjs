// Pure tick-indexed sync-hash comparison for the multiplayer desync gate.
// The real gate (multiplayer-desyncgate.mjs) feeds page samples in each
// second; this module owns the bounded merge so the gate's completion
// predicate stays testable without a browser.
export function createSyncSamples({ maxPendingTicks = 4096 } = {}) {
	const pending = [new Map(), new Map()]; // clientIndex -> tick -> hash
	const compared = new Set();
	const mismatches = [];

	function evictOldest(map) {
		if (map.size <= maxPendingTicks) return;
		for (const tick of map.keys()) {
			map.delete(tick);
			if (map.size <= maxPendingTicks) break;
		}
	}

	return {
		add(clientIndex, samples) {
			if (clientIndex !== 0 && clientIndex !== 1)
				throw new Error(`invalid clientIndex ${clientIndex}`);
			if (!Array.isArray(samples))
				throw new Error('samples must be an array');
			for (const sample of samples) {
				if (!sample || !Number.isInteger(sample.tick) || sample.tick < 0)
					throw new Error(`malformed sample: ${JSON.stringify(sample)}`);
				if (!Number.isInteger(sample.hash) || sample.hash < 0 || sample.hash > 0xFFFFFFFF)
					throw new Error(`malformed hash: ${JSON.stringify(sample)}`);
				const map = pending[clientIndex];
				if (!map.has(sample.tick)) map.set(sample.tick, sample.hash);
			}
			// Compare every tick now present on both sides exactly once.
			const [a, b] = pending;
			const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
			for (const [tick, hashA] of smaller) {
				if (!larger.has(tick) || compared.has(tick)) continue;
				const hashB = larger.get(tick);
				if (hashA !== hashB)
					mismatches.push({ tick, hashA, hashB });
				compared.add(tick);
				smaller.delete(tick);
				larger.delete(tick);
			}
			for (const map of pending) evictOldest(map);
			if (mismatches.length > 0) {
				const first = mismatches[0];
				throw new Error(
					`sync hash mismatch at tick ${first.tick}: clientA=${first.hashA} clientB=${first.hashB}`);
			}
		},
		result() {
			return { matchedTicks: compared.size, mismatches: mismatches.length };
		},
	};
}
