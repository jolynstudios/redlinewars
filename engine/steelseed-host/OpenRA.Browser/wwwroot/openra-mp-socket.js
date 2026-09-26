// Browser WebSocket transport bridge for the STEELSEED network session
// (BrowserWebSocketConnection.cs). JS owns the native WebSocket; C# owns the
// OpenRA wire framing. C# never calls into JS: the presentation pump serves
// queued transport commands every frame via the Program.Mp* exports, and
// WebSocket event handlers call back through Program.MpWs* exports.
//
// The two sides share the wasm linear memory: C# hands us pinned buffer
// addresses (recv/send) in the create command payload, we copy payload bytes
// in and out of the heap view.
//
// Work kinds (mirror BrowserWebSocketConnection): 0 = dead create (no-op),
// 1 = create, 2 = send, 3 = close.
//
// Every failure path is fail-closed: a command that cannot be served still
// consumes its work item (MpWorkDone in a finally) and notifies C# through
// MpWsOnClose, so the connection fails once, with a reason, instead of being
// retried forever. Close reasons stay on this side of the bridge; C# reads
// them back via getMpCloseInfo (which wraps getCloseInfo below).

const CONNECT_TIMEOUT_MS = 15000

export function installMpSocket(program, heapView) {
	const sockets = new Map()
	const sendPtrs = new Map()
	// Ids whose close C# has been notified about: guards every late event and
	// every heap access once the pinned buffers may be gone.
	const closed = new Set()
	// Pending connect timers by id: torn down on open, on close, and on any
	// fail-closed path, so a dead connection never leaves a dangling timer.
	const connectTimers = new Map()
	// Close information per connection id, recorded by whichever side
	// observed the failure first. Entries persist: reading must not consume.
	const closeInfo = new Map()
	let lastClosedId = null
	let heap = null

	const clearConnectTimer = id => {
		const timer = connectTimers.get(id)
		if (timer !== undefined) {
			clearTimeout(timer)
			connectTimers.delete(id)
		}
	}

	const view = () => {
		heap = heapView()
		return heap
	}

	// Idempotent close notification: C# fails the connection and releases
	// its pinned buffers exactly once, whichever path closes first.
	function notifyClosed(id) {
		if (closed.has(id)) return
		closed.add(id)
		clearConnectTimer(id)
		sockets.delete(id)
		sendPtrs.delete(id)
		lastClosedId = id
		program.MpWsOnClose(id)
	}

	function recordClose(id, code, reason) {
		const existing = closeInfo.get(id)
		if (existing) {
			// First observation wins for real events: the synthetic 'connect
			// timeout' reason must not be clobbered by the trailing native
			// close event (1006, ''). One exception: the send pump can serve
			// a queued write in the window between the relay initiating the
			// close and this page's onclose, recording the transport noise
			// 'send on a closed socket' (code 0) first. The coded close event
			// is the honest record — it replaces exactly that entry.
			const syntheticSend = existing.code === 0 && existing.reason === 'send on a closed socket'
			if (!syntheticSend || code === 0) return
		}
		closeInfo.set(id, { code, reason })
	}

	function wsCreate(id, url, recvPtr, recvCap, sendPtr) {
		let ws
		try {
			ws = new WebSocket(url)
		} catch (error) {
			// A throwing constructor (bad URL, mixed content) must still
			// consume the work item and notify C#, or the same create is
			// retried every frame forever.
			console.warn(`[mp] websocket create failed: ${error}`)
			recordClose(id, 0, String(error))
			notifyClosed(id)
			return
		}
		ws.binaryType = 'arraybuffer'
		sockets.set(id, ws)
		sendPtrs.set(id, sendPtr)
		connectTimers.set(id, setTimeout(() => {
			connectTimers.delete(id)
			if (closed.has(id) || ws.readyState === WebSocket.OPEN) return
			recordClose(id, 0, 'connect timeout')
			try { ws.close() } catch { /* already closing */ }
			notifyClosed(id)
		}, CONNECT_TIMEOUT_MS))
		ws.onopen = () => {
			if (closed.has(id)) return
			clearConnectTimer(id)
			program.MpWsOnOpen(id)
		}
		ws.onmessage = event => {
			if (closed.has(id)) return
			const bytes = new Uint8Array(event.data)
			// The stream is re-framed by its length prefix on the C# side, so
			// slice boundaries are irrelevant: deliver a message larger than
			// the receive capacity in recvCap-sized slices, each followed by
			// MpWsOnMessage(id, n).
			for (let off = 0; off < bytes.length; off += recvCap) {
				const end = Math.min(off + recvCap, bytes.length)
				view().set(bytes.subarray(off, end), recvPtr)
				program.MpWsOnMessage(id, end - off)
			}
		}
		ws.onerror = () => program.MpWsOnError(id)
		ws.onclose = event => {
			clearConnectTimer(id)
			recordClose(id, event.code, event.reason)
			notifyClosed(id)
		}
	}

	function wsSend(id, length) {
		const ws = sockets.get(id)
		const ptr = sendPtrs.get(id)
		if (!ws || ws.readyState !== WebSocket.OPEN || ptr === undefined) {
			// A send served after the socket died must never be dropped
			// silently — C# has to learn the connection is gone.
			recordClose(id, 0, 'send on a closed socket')
			notifyClosed(id)
			return
		}
		// Copy OUT of linear memory before send(): C# reuses the send buffer for
		// the next chunk immediately after MpWorkDone().
		const bytes = view().slice(ptr, ptr + length)
		ws.send(bytes)
	}

	function wsClose(id) {
		const ws = sockets.get(id)
		if (!ws) return
		// Owner-initiated close: C# queued this close itself, so it needs no
		// MpWsOnClose — but delivery must stop and the shared-memory handles
		// must drop before the native close lands.
		closed.add(id)
		sockets.delete(id)
		sendPtrs.delete(id)
		try { ws.close() } catch { /* already closing */ }
	}

	return {
		// Serves queued transport commands until the queue drains. Each item
		// is wrapped individually and MpWorkDone() always runs: one failing
		// item must never stall the queue or leak the served command.
		serveMpWork() {
			while (program.MpHasWork()) {
				const kind = program.MpWorkKind()
				const id = program.MpWorkId()
				try {
					if (kind === 1)
						wsCreate(id, program.MpWorkUrl(), program.MpRecvPtr(), program.MpRecvCap(), program.MpSendPtr(), program.MpSendCap())
					else if (kind === 2)
						wsSend(id, program.MpSendLen())
					else if (kind === 3)
						wsClose(id)
					// kind 0 is a dead create; the shim ignores it.
				} catch (error) {
					console.error(`[mp] transport command ${kind} for connection ${id} failed:`, error)
				} finally {
					program.MpWorkDone()
				}
			}
		},
		// Close information for one connection, or — with no argument — the
		// most recent entry recorded on this page. The bridge's
		// getMpCloseInfo() wraps the no-argument form.
		getCloseInfo(id) {
			return id === undefined ? (closeInfo.get(lastClosedId) ?? null) : (closeInfo.get(id) ?? null)
		},
	}
}
