// Shared byte-bounded relay writers. Owners close their transports on failure.
function overload() {
	return Object.assign(new Error('relay backpressure'), { code: 'ERR_RELAY_BACKPRESSURE' });
}

function bytesOf(data) {
	return typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.length;
}

export function createTcpWriter({ limitBytes, onFailure }) {
	const chunks = [];
	let head = 0;
	let bytes = 0;
	let socket = null;
	let closed = false;
	let waitingDrain = false;
	let flushing = false;
	let submittingBytes = 0;

	function close() {
		if (closed) return;
		closed = true;
		if (socket) {
			socket.removeListener('drain', onDrain);
			socket.removeListener('error', fail);
			socket.removeListener('close', onSocketClose);
		}
		chunks.length = 0;
		head = 0;
		bytes = 0;
		submittingBytes = 0;
	}
	function fail(error) {
		if (closed) return;
		close();
		onFailure?.(error);
	}
	function onSocketClose() {
		fail(new Error('tcp socket closed'));
	}
	function onDrain() {
		waitingDrain = false;
		flush();
	}
	function flush() {
		if (closed || !socket || flushing || waitingDrain) return;
		if (socket.destroyed || socket.writableEnded) {
			fail(new Error('tcp socket not writable'));
			return;
		}
		flushing = true;
		try {
			while (!closed && !waitingDrain && head < chunks.length) {
				const chunk = chunks[head];
				chunks[head++] = undefined;
				bytes -= chunk.length;
				if (head === chunks.length) { chunks.length = 0; head = 0; }
				// Reserve during write too: custom writables can invoke owner callbacks
				// synchronously, before writableLength reflects this accepted chunk.
				submittingBytes = socket.writableLength + chunk.length;
				waitingDrain = true;
				const ready = socket.write(chunk);
				submittingBytes = 0;
				if (ready) waitingDrain = false;
			}
		} catch (error) {
			fail(error);
		} finally {
			submittingBytes = 0;
			flushing = false;
		}
	}
	return {
		write(chunk) {
			if (closed) return false;
			const pending = Math.max(socket?.writableLength ?? 0, submittingBytes);
			if (bytes + pending + chunk.length > limitBytes) {
				fail(overload());
				return false;
			}
			chunks.push(chunk);
			bytes += chunk.length;
			flush();
			return !closed;
		},
		attach(next) {
			if (closed) { next.destroy(); return; }
			if (socket) throw new Error('tcp writer already attached');
			socket = next;
			socket.on('drain', onDrain);
			socket.on('error', fail);
			socket.on('close', onSocketClose);
			flush();
		},
		close,
	};
}

export function createWsWriter(ws, { limitBytes, onFailure }) {
	let closed = false;
	let inFlight = 0;
	function close() {
		closed = true;
		inFlight = 0;
	}
	function fail(error) {
		if (closed) return;
		close();
		onFailure?.(error);
	}
	return {
		send(data, options) {
			if (closed) return false;
			if (ws.readyState !== 1) {
				fail(new Error('ws socket not open'));
				return false;
			}
			const size = bytesOf(data);
			if (Math.max(inFlight, ws.bufferedAmount ?? 0) + size > limitBytes) {
				fail(overload());
				return false;
			}
			inFlight += size;
			let done = false;
			const release = error => {
				if (done || closed) return;
				done = true;
				inFlight -= size;
				if (error) fail(error);
			};
			try {
				ws.send(data, options, release);
			} catch (error) {
				done = true;
				fail(error);
			}
			return !closed;
		},
		close,
	};
}
