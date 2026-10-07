// Test fixture readiness: only a refused connection is a startup condition.
// An HTTP error, invalid manifest or expired deadline fails the gate.
import { setTimeout as delay } from 'node:timers/promises'

export async function fixtureManifest(url, { timeoutMs = 10000, pollMs = 100, fetchManifest = fetch } = {}) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		try {
			const response = await fetchManifest(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
			if (!response.ok) throw new Error(`Fixture manifest HTTP ${response.status}: ${url}`)
			const build = await response.json()
			if (typeof build.simBuild !== 'string' || !build.simBuild) throw new Error(`Invalid fixture build manifest: ${url}`)
			return build
		} catch (error) {
			if (error.cause?.code !== 'ECONNREFUSED' || Date.now() >= deadline) throw error
			await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())))
		}
	}
}
