// Page-side twin of sim-worker.js. The simulation's Frame() pump stays in the
// worker. Snapshots arrive as transferred copies. Methods that the presentation
// reads every frame come from the worker's status cache; everything else is one
// postMessage round trip.

export function createPageBridge(worker) {
	const pending = new Map()
	const snapshots = []
	let sync = {}
	let seq = 1

	worker.addEventListener('message', event => {
		const message = event.data
		if (!message || typeof message !== 'object') return
		if (message.type === 'snapshot' && message.bytes) {
			snapshots.push(message.bytes)
			if (message.syncProbe != null) sync.GetSyncProbe = String(message.syncProbe)
			return
		}
		if (message.type === 'status') {
			sync = { ...sync, ...(message.values ?? {}) }
			return
		}
		if (message.type === 'result') {
			const slot = pending.get(message.id)
			if (!slot) return
			pending.delete(message.id)
			if (message.ok) slot.resolve(message.value)
			else slot.reject(new Error(String(message.value)))
			return
		}
		if (message.type === 'failed' || message.type === 'snapshotError')
			console.error('[sim]', message.error ?? message.message)
		if (message.type === 'stopped')
			console.info('[sim] stopped', message.reason)
	})

	const call = (method, args) => new Promise((resolve, reject) => {
		const id = seq++
		pending.set(id, { resolve, reject })
		worker.postMessage({ type: 'call', id, method, args })
	})
	// Page-level `ora` used to be the dotnet Program. The simulation now lives in
	// the worker, so the same names forward as raw program calls. Release gates
	// still wait on `globalThis.ora` before they touch the presentation.
	const ora = new Proxy({}, {
		get(_target, prop) {
			if (prop === 'then' || typeof prop !== 'string') return undefined
			return (...args) => new Promise((resolve, reject) => {
				const id = seq++
				pending.set(id, { resolve, reject })
				worker.postMessage({ type: 'raw', id, method: prop, args: args.filter(arg => typeof arg !== 'function') })
			})
		},
	})

	const cached = {
		pollSnapshot() { return snapshots.shift() ?? null },
		hostStatus: () => sync.hostStatus ?? 'stopped',
		getSyncProbe: () => sync.GetSyncProbe ?? '',
		getConnectionProbe: () => sync.GetConnectionProbe ?? '',
		getServerErrorProbe: () => sync.GetServerErrorProbe ?? '',
		getLobbyPlayersProbe: () => sync.GetLobbyPlayersProbe ?? '',
		getSupportPowers: () => sync.supportPowers ?? null,
		getSessionStatus: () => sync.sessionStatus ?? null,
	}

	const bridge = new Proxy(cached, {
		get(target, prop) {
			if (prop in target) return target[prop]
			// A `then` would make the bridge itself a thenable. Awaiting the bridge
			// promise would then post the runtime's resolve function into the worker.
			if (prop === 'then' || typeof prop !== 'string') return undefined
			return (...args) => call(prop, args.filter(arg => typeof arg !== 'function'))
		},
	})
	return { bridge, ora }
}
