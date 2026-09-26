// STEELSEED — simulation worker host.
//
// The mono-wasm OpenRA runtime boots HERE, off the presentation main thread, so a
// long simulation tick (map generation, a pathfinder flood) can never freeze input,
// camera or the compositor. The presentation keeps its old bridge contract through
// the proxy in main.js; from the app's point of view only the latency of the
// RPC-shaped methods changes (one postMessage round trip).
//
// Message protocol (see the proxy twin in main.js):
//   in  {type:'init', query:string}          page search string, forwarded as launch args
//   in  {type:'call', id, method, args}      bridge method (openra-steelseed-bridge.js)
//   in  {type:'raw',  id, method, args}      raw [JSExport] passthrough (globalThis.ora)
//   out {type:'ready'}
//   out {type:'snapshot', bytes}             copied out of the wasm heap, transferred
//   out {type:'snapshotError', message}
//   out {type:'result', id, ok, value}
//   out {type:'status', values}              sync-cache feed for the proxy (250 ms)
//   out {type:'stopped', reason} | {type:'failed', error}
//
// Workers have no requestAnimationFrame: the pump is timer-driven. StepUntilIdle
// advances the sim against real time, so a 10 ms cadence is a finer-grained version
// of the old rAF pump, not a different clock.

import { dotnet } from './_framework/dotnet.js'
import { createSteelseedBridge } from './openra-steelseed-bridge.js'
import { installMpSocket } from './openra-mp-socket.js'
import { launchArgsFromQuery } from './launch-args.js'
import * as openraAudio from './openra-audio.js'
import * as openraFs from './openra-fs.js'
import * as openraGl from './openra-gl.js'
import * as openraInput from './openra-input.js'

// Order entry copies subject ids into wasm scratch; the bridge validates a real
// Uint32Array, so plain arrays off the postMessage wire are rebuilt here.
const ORDER_METHODS = new Set(['issueOrder', 'issueContextOrder', 'queryContextOrder'])

const fixArgs = (method, args) => {
	if (!ORDER_METHODS.has(method)) return args
	const order = args[0]
	if (order && Array.isArray(order.subjectIds)) {
		// Copy once: the caller's array is never aliased into wasm memory.
		return [{ ...order, subjectIds: Uint32Array.from(order.subjectIds) }, ...args.slice(1)]
	}
	return args
}

let bridge = null
let program = null
// The installMpSocket instance owns the transport work queue AND the close
// bookkeeping; the bridge's getMpCloseInfo() reads the latter.
let mpSocket = null
let serveMpWork = () => {}
let running = true
let pump = 0

const post = (message, transfer) => {
	try { self.postMessage(message, transfer ?? []) } catch (error) { console.error('[sim-worker] post failed:', error) }
}

const stopPump = reason => {
	if (!running) return
	running = false
	if (pump) { clearInterval(pump); pump = 0 }
	post({ type: 'stopped', reason })
}

async function boot(query, argv) {
	const { setModuleImports, getAssemblyExports, getConfig, localHeapViewU8, runMain } = await dotnet
		.withDiagnosticTracing(false)
		.create()
	setModuleImports('openra-audio', openraAudio)
	setModuleImports('openra-fs', openraFs)
	setModuleImports('openra-gl', openraGl)
	setModuleImports('openra-input', openraInput)
	await openraFs.preload()
	const config = getConfig()
	const exports = await getAssemblyExports(config.mainAssemblyName)
	program = exports.OpenRA.Program
	// The page forwards the same Host.Mode argv main.js used to pass to runMain.
	// A bare query string is only the fallback, and it still goes through the
	// loopback allowlist.
	const urlArgs = Array.isArray(argv) && argv.length > 0
		? argv
		: launchArgsFromQuery(query ?? '', globalThis.location?.hostname ?? '')
	await runMain(config.mainAssemblyName, urlArgs)
	mpSocket = installMpSocket(program, localHeapViewU8)
	serveMpWork = mpSocket.serveMpWork
	bridge = createSteelseedBridge(program, localHeapViewU8, mpSocket)

	const tick = () => {
		if (!running) return
		try {
			serveMpWork()
			if (!program.Frame(performance.now())) {
				stopPump(program.HostStatus())
				return
			}
			// Poll after the frame: the token short-circuits to 0 unless the world tick
			// advanced, so this is one integer read in the common case.
			try {
				const view = bridge.pollSnapshot()
				if (view) {
					// The bridge aliases the whole pinned slot (8 MiB); the payload is
					// the header's byteLength. Copying the slot would move ~200 MB/s
					// across the postMessage boundary at 25 Hz for nothing.
					const length = new DataView(view.buffer, view.byteOffset, 32).getUint32(8, true)
					const copy = view.slice(0, Math.min(length, view.byteLength))
					post({ type: 'snapshot', bytes: copy, syncProbe: program.GetSyncProbe() }, [copy.buffer])
				}
			} catch (error) {
				post({ type: 'snapshotError', message: String(error?.message ?? error) })
			}
		} catch (error) {
			stopPump(`${program.HostStatus()}\n${error?.stack ?? error}`)
		}
	}
	pump = setInterval(tick, 10)

	// Low-frequency status cache. Tick/hash travels with advancing snapshots,
	// not this 4 Hz feed: sparse independent samples can have no shared ticks.
	setInterval(() => {
		if (!running || !bridge) return
		const text = fn => { try { return String(fn()) } catch { return '' } }
		let sessionStatus = null
		try { sessionStatus = JSON.parse(program.GetSessionStatus()) } catch { sessionStatus = null }
		let supportPowers = null
		try { supportPowers = JSON.parse(program.GetSupportPowers()) } catch { supportPowers = null }
		post({
			type: 'status',
			values: {
				hostStatus: text(() => program.HostStatus()),
				IsRunning: (() => { try { return program.IsRunning() === true } catch { return false } })(),
				GetNetFrame: (() => { try { return program.GetNetFrame() } catch { return 0 } })(),
				GetConnectionProbe: text(() => program.GetConnectionProbe()),
				GetServerErrorProbe: text(() => program.GetServerErrorProbe()),
				GetLobbyPlayersProbe: text(() => program.GetLobbyPlayersProbe()),
				sessionStatus,
				supportPowers,
			},
		})
	}, 250)

	// Drain any RPC that raced ahead of 'ready' (see onmessage).
	while (pendingRpc.length > 0) runRpc(pendingRpc.shift())
	post({ type: 'ready' })
}

self.onmessage = event => {
	const message = event.data
	if (!message || typeof message !== 'object' || !message.type) return
	if (message.type === 'init') {
		if (initialized) return
		initialized = true
		boot(message.query, message.argv).catch(error => {
			post({ type: 'failed', error: String(error?.stack ?? error) })
		})
		return
	}
	if (message.type === 'call' || message.type === 'raw') {
		// The proxy only sends RPC after 'ready'; the queue covers a race where a
		// status push or snapshot reply nudges it earlier than the ready handler.
		if (!bridge) { pendingRpc.push(message); return }
		runRpc(message)
	}
}

	// Fail-closed answer guard: a bridge method whose promise never settles must
	// still answer once, or the page's pending entry leaks and the awaiting state
	// machine freezes (§7 rule 6). Timers cannot fire while a synchronous call
	// holds this worker, so a legitimate long call is never raced — only async
	// work that would otherwise hang forever is. A late settle posts a second
	// result for the same id; the page drops results it has no entry for.
	const RPC_GUARD_MS = 6_000
	function runRpc({ type, id, method, args }) {
		try {
			const fn = type === 'call' ? bridge[method] : program[method]
			if (typeof fn !== 'function') throw new TypeError(`no such ${type} method: ${method}`)
			const value = fn.apply(type === 'call' ? bridge : program, fixArgs(method, args))
			let answered = false
			Promise.resolve(value).then(
				resolved => { answered = true; post({ type: 'result', id, ok: true, value: resolved }) },
				error => { answered = true; post({ type: 'result', id, ok: false, value: String(error?.stack ?? error) }) },
			)
			setTimeout(() => {
				if (!answered) post({ type: 'result', id, ok: false, value: `rpc ${method} never settled (worker guard)` })
			}, RPC_GUARD_MS)
		} catch (error) {
			post({ type: 'result', id, ok: false, value: String(error?.stack ?? error) })
		}
	}

let initialized = false
const pendingRpc = []

