import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// Import the actual shipping file bytes as ESM: wwwroot/*.js has no
// package.json type of its own, so a data: URL preserves byte-exact behavior.
const socketSource = readFileSync(
	new URL('../OpenRA.Browser/wwwroot/openra-mp-socket.js', import.meta.url), 'utf8');
const { installMpSocket } = await import(
	`data:text/javascript;base64,${Buffer.from(socketSource).toString('base64')}`);

const RECV_CAPACITY = 256 * 1024; // mirrors BrowserWebSocketConnection.RecvCapacity
const bridgeSource = readFileSync(
	new URL('../OpenRA.Browser/wwwroot/openra-steelseed-bridge.js', import.meta.url), 'utf8');
const { createSteelseedBridge } = await import(
	`data:text/javascript;base64,${Buffer.from(bridgeSource).toString('base64')}`);

const closeFields = info => info && ({ code: info.code, reason: info.reason });

const SEND_CAPACITY = 128 * 1024; // mirrors BrowserWebSocketConnection.SendCapacity

// Minimal stand-in for the browser WebSocket: tests drive the event handlers
// by hand, sends are recorded, and URLs in `throwOn` make the constructor
// throw the way a malformed or mixed-content URL does.
class FakeWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	static instances = [];
	static throwOn = new Set();
	constructor(url) {
		if (FakeWebSocket.throwOn.has(url) || FakeWebSocket.throwOn.has(new URL(url).origin))
			throw new SyntaxError(`Failed to construct 'WebSocket': ${url} is not a valid WebSocket URL.`);
		this.url = url;
		this.readyState = FakeWebSocket.CONNECTING;
		this.sent = [];
		this.closeArgs = null;
		FakeWebSocket.instances.push(this);
	}
	send(bytes) { this.sent.push(bytes.slice()); }
	close(code, reason) { this.readyState = FakeWebSocket.CLOSED; this.closeArgs = { code, reason }; }
	// Test-side event triggers.
	openEvent() { this.readyState = FakeWebSocket.OPEN; this.onopen(); }
	messageEvent(data) { this.onmessage({ data }); }
	errorEvent() { this.onerror(); }
	closeEvent(code = 1006, reason = '') { this.readyState = FakeWebSocket.CLOSED; this.onclose({ code, reason }); }
}

// Transcription of BrowserWebSocketConnection's pump contract: queued work is
// served head-first, a Send larger than the send buffer keeps its head item and
// advances headOffset (never re-enqueued behind later items), a create for a
// dead id is served as no-op kind 0, and the pins are released only when the
// served WorkClose completes.
function fixture({ recvCapacity = RECV_CAPACITY, sendCapacity = SEND_CAPACITY } = {}) {
	FakeWebSocket.instances = [];
	FakeWebSocket.throwOn = new Set();
	globalThis.WebSocket = FakeWebSocket;
	const recvPtr = 0x1000;
	const sendPtr = recvPtr + recvCapacity;
	const heap = new Uint8Array(sendPtr + sendCapacity);
	const live = new Map();
	const closing = new Set();
	const kinds = [], ids = [], payloads = [];
	let served = null;
	let headOffset = 0;
	let pinsReleased = false;
	let heapFreed = false;
	let views = 0;
	let workDoneCount = 0;
	const opened = [], messages = [], errors = [], closes = [];
	const program = {
		opened, messages, errors, closes,
		workDone: () => workDoneCount,
		pinsReleased: () => pinsReleased,
		createUrl: '', createRecvPtr: 0, createRecvCap: 0, createSendPtr: 0, createSendCap: 0,
		MpHasWork() {
			if (served) return true;
			if (kinds.length === 0) return false;
			served = { kind: kinds[0], id: ids[0], sendLen: 0 };
			if (served.kind === 1) {
				if (live.has(served.id)) {
					program.createUrl = live.get(served.id).url;
					program.createRecvPtr = recvPtr;
					program.createRecvCap = recvCapacity;
					program.createSendPtr = sendPtr;
					program.createSendCap = sendCapacity;
				} else {
					// Dead create: no-op kind with the payload statics cleared.
					served.kind = 0;
					program.createUrl = '';
					program.createRecvPtr = program.createRecvCap = 0;
					program.createSendPtr = program.createSendCap = 0;
				}
			} else if (served.kind === 2) {
				const conn = live.get(served.id);
				if (conn) {
					const payload = payloads[0];
					served.sendLen = Math.min(payload.length - headOffset, sendCapacity);
					heap.set(payload.subarray(headOffset, headOffset + served.sendLen), sendPtr);
				}
			}
			return true;
		},
		MpWorkKind: () => served.kind,
		MpWorkId: () => served.id,
		MpSendLen: () => served.sendLen,
		MpWorkUrl: () => program.createUrl,
		MpRecvPtr: () => program.createRecvPtr,
		MpRecvCap: () => program.createRecvCap,
		MpSendPtr: () => program.createSendPtr,
		MpSendCap: () => program.createSendCap,
		MpWorkDone() {
			assert.ok(served, 'MpWorkDone without a served work item');
			workDoneCount++;
			if (served.kind === 2) {
				const payload = payloads[0];
				headOffset += served.sendLen;
				if (payload.length > headOffset && live.has(served.id)) {
					served = null; // the head stays queued; its next chunk is served next
					return;
				}
			}
			if (served.kind === 3 && closing.has(served.id)) {
				closing.delete(served.id);
				pinsReleased = true;
				heapFreed = true; // C# released the pins: the heap is off limits now
			}
			kinds.shift(); ids.shift(); payloads.shift();
			headOffset = 0;
			served = null;
		},
		MpWsOnOpen: id => opened.push(id),
		MpWsOnMessage(id, n) {
			if (heapFreed) throw new Error('MpWsOnMessage after the pins were released');
			messages.push({ id, n, bytes: heap.slice(recvPtr, recvPtr + n) });
		},
		MpWsOnError: id => errors.push(id),
		MpWsOnClose: id => closes.push(id),
	};
	const enqueue = (kind, id, payload = null) => { kinds.push(kind); ids.push(id); payloads.push(payload); };
	// connect queues a create the way the C# constructor does; the returned
	// disposer mirrors DisposeTransport (Live removal plus a queued close).
	const connect = (id, url = `ws://fixture/${id}`) => {
		live.set(id, { url });
		enqueue(1, id);
		return () => { live.delete(id); closing.add(id); enqueue(3, id); };
	};
	const transport = installMpSocket(program, () => {
		views++;
		if (heapFreed) throw new Error('heap access after the pins were released');
		return heap;
	});
	const { serveMpWork, getCloseInfo } = transport;
	return { program, heap, recvPtr, sendPtr, views: () => views, created: FakeWebSocket.instances, connect, enqueue, serveMpWork, getCloseInfo, transport };
}

test('create-throws advances the queue, notifies close, and the next join works', () => {
	const f = fixture();
	// The fake matches the parsed endpoint, so the registered
	// form is the parsed/normalized one ('ws://bad-url' -> 'ws://bad-url/').
	FakeWebSocket.throwOn.add('ws://bad-url');
	f.connect(1, 'ws://bad-url');
	f.connect(2); // queued behind the failing create
	f.serveMpWork();
	// The failed create consumed its work item (MpWorkDone ran) and the create
	// behind it was still served in the same pass.
	assert.equal(f.program.workDone(), 2);
	assert.deepEqual(f.program.closes, [1]);
	const info = f.getCloseInfo(1);
	assert.equal(info.code, 0);
	assert.ok(info.reason.includes('not a valid WebSocket URL'), info.reason);
	assert.equal(f.getCloseInfo(), null); // the second create is the current join
	assert.equal(f.views(), 0); // the dead create never touched the heap
	// Only the second create produced a socket, and it works end to end.
	assert.equal(f.created.length, 1);
	f.created[0].openEvent();
	assert.deepEqual(f.program.opened, [2]);
	f.created[0].messageEvent(Uint8Array.from([7, 8]));
	assert.deepEqual(f.program.messages, [{ id: 2, n: 2, bytes: Uint8Array.from([7, 8]) }]);
	// Tear the live socket down so no connect timer outlives the test.
	f.created[0].closeEvent();
	assert.deepEqual(f.program.closes, [1, 2]);
});

test('a send served before the socket is open fails closed', () => {
	const f = fixture();
	f.connect(1);
	f.serveMpWork();
	const ws = f.created[0];
	assert.equal(ws.readyState, FakeWebSocket.CONNECTING);
	f.enqueue(2, 1, Uint8Array.from([1, 2, 3]));
	f.serveMpWork();
	// Nothing reached the wire; the connection failed with a reason instead.
	assert.equal(ws.sent.length, 0);
	assert.deepEqual(f.program.closes, [1]);
	const early = f.getCloseInfo(1);
	assert.equal(early.code, 0);
	assert.equal(early.reason, 'send on a closed socket');
	// A late open must not resurrect the failed connection.
	ws.openEvent();
	assert.deepEqual(f.program.opened, []);
	// The send bytes were never copied out of the shared buffer.
	assert.equal(f.views(), 0);
});

test('no heap access after the served close releases the pins', () => {
	const f = fixture();
	const dispose = f.connect(1);
	f.serveMpWork();
	const ws = f.created[0];
	ws.openEvent();
	dispose(); // C# queues the close; the pins are still held
	assert.equal(f.program.pinsReleased(), false);
	f.serveMpWork(); // the close is served; MpWorkDone releases the pins
	assert.equal(f.program.pinsReleased(), true);
	// Server bytes in flight after the close: no heap view, no message.
	ws.messageEvent(Uint8Array.from([9, 9, 9]));
	assert.deepEqual(f.program.messages, []);
	// The trailing native close event notifies nothing new for an
	// owner-initiated close, and a late open cannot resurrect it.
	ws.closeEvent(1006);
	assert.deepEqual(f.program.closes, []);
	ws.openEvent();
	assert.deepEqual(f.program.opened, [1]); // the setup open is still the only one
});

test('a 300 KB send followed by a small send arrives in order', () => {
	const f = fixture();
	f.connect(1);
	f.serveMpWork();
	const ws = f.created[0];
	ws.openEvent();
	const big = new Uint8Array(300 * 1024);
	for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
	const small = Uint8Array.from([1, 2, 3, 4]);
	f.enqueue(2, 1, big);
	f.enqueue(2, 1, small);
	f.serveMpWork();
	// The big payload is chunked in place; the small send never overtakes it.
	const chunks = Math.ceil(big.length / SEND_CAPACITY);
	assert.equal(f.program.workDone(), 1 + chunks + 1);
	assert.equal(ws.sent.length, chunks + 1);
	assert.equal(ws.sent[0].length, SEND_CAPACITY);
	assert.ok(Buffer.from(ws.sent[0]).equals(Buffer.from(big.subarray(0, SEND_CAPACITY))), 'first chunk');
	assert.equal(ws.sent[chunks - 1].length, big.length - (chunks - 1) * SEND_CAPACITY);
	assert.equal(ws.sent[chunks].length, small.length);
	assert.ok(Buffer.from(ws.sent[chunks]).equals(Buffer.from(small)), 'small send after the big one');
	const received = Buffer.concat(ws.sent.map(bytes => Buffer.from(bytes)));
	const expected = Buffer.concat([Buffer.from(big), Buffer.from(small)]);
	assert.ok(received.equals(expected));
	// A fully served stream notifies no close and records no close info.
	assert.deepEqual(f.program.closes, []);
	assert.equal(f.getCloseInfo(1), null);
	assert.equal(f.getCloseInfo(), null);
});

test('a create that never opens fails closed after the 15 s connect timeout', t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const f = fixture();
	f.connect(1, 'ws://127.0.0.1:1/g/0000000000000000');
	f.serveMpWork();
	const ws = f.created[0];
	t.mock.timers.tick(14999);
	assert.deepEqual(f.program.closes, []);
	assert.equal(ws.closeArgs, null);
	t.mock.timers.tick(1);
	// Failed once, with a reason, and the socket was closed.
	assert.deepEqual(f.program.closes, [1]);
	const timedOut = f.getCloseInfo(1);
	assert.equal(timedOut.code, 0);
	assert.equal(timedOut.reason, 'connect timeout');
	assert.ok(Number.isFinite(timedOut.at), 'close records carry a recording timestamp');
	assert.notEqual(ws.closeArgs, null);
	assert.equal(ws.readyState, FakeWebSocket.CLOSED);
	// The trailing native close event does not clobber the timeout reason —
	// nor its recording moment.
	ws.closeEvent(1006);
	assert.equal(f.getCloseInfo(1), timedOut);
	assert.deepEqual(f.program.closes, [1]);
});

test('a previous session\'s close stays readable with its own recording time', () => {
	// Timestamps remain readable by ID, but current-attempt ownership prevents
	// historical closes from aborting a new join (including before its pump).
	const f = fixture();
	f.connect(1);
	f.serveMpWork();
	f.created[0].closeEvent(1000, 'demoted');
	const corpse = f.getCloseInfo();
	assert.equal(corpse.code, 1000);
	assert.equal(corpse.reason, 'demoted');
	// Connection 2 joins AFTER connection 1 died; its record is distinct. In
	// the real flow minutes pass between the two (a demotion teardown, the
	// NotConnected wait, the settle) — here both land in one clock tick, so
	// the provable contract is: recording times never go backwards and every
	// record carries one. The HUD compares `at` against a joinStartedAt
	// captured BEFORE its dial, which is strictly older than its own close.
	f.connect(2);
	f.serveMpWork();
	f.created[1].openEvent();
	assert.equal(f.getCloseInfo(), null, 'a fresh connection never inherits a historical close');
	assert.equal(f.getCloseInfo(1), corpse, 'historical recording time remains available by ID');
	f.created[1].closeEvent(4404, 'room reserved');
	const fresh = f.getCloseInfo();
	assert.notEqual(fresh, corpse);
	assert.equal(fresh.code, 4404);
	assert.ok(Number.isFinite(fresh.at) && fresh.at >= corpse.at, 'recording times are wall-clock and never go backwards');
});

test('received bytes forward byte-exact; an oversize message arrives in recvCap slices', () => {
	const f = fixture({ recvCapacity: 8, sendCapacity: 64 });
	f.connect(1);
	f.serveMpWork();
	const ws = f.created[0];
	ws.openEvent();
	// A normal payload lands byte-exact in the pinned receive buffer.
	ws.messageEvent(Uint8Array.from([1, 2, 3]));
	assert.deepEqual(f.program.messages, [{ id: 1, n: 3, bytes: Uint8Array.from([1, 2, 3]) }]);
	assert.equal(f.heap[f.recvPtr], 1);
	assert.equal(f.heap[f.recvPtr + 2], 3);
	// Exactly the capacity forwards fully.
	ws.messageEvent(new Uint8Array(8).fill(7));
	assert.equal(f.program.messages.at(-1).n, 8);
	// Capacity+1: two deliveries (8 + 1) and no close — the C# side re-frames
	// the stream by length prefix, so slice boundaries are irrelevant.
	ws.messageEvent(new Uint8Array(9).fill(9));
	assert.equal(f.program.messages.at(-2).n, 8);
	assert.equal(f.program.messages.at(-1).n, 1);
	assert.equal(f.program.messages.at(-1).bytes[0], 9);
	assert.deepEqual(f.program.closes, []);
	assert.equal(f.getCloseInfo(1), null);
});


test('a new join clears current close diagnostics while preserving historical failures', () => {
	const f = fixture();
	f.connect(1);
	f.serveMpWork();
	f.created[0].closeEvent(1006, 'first network failed');
	assert.deepEqual(closeFields(f.getCloseInfo()), { code: 1006, reason: 'first network failed' });
	f.connect(2);
	f.serveMpWork();
	assert.equal(f.getCloseInfo(), null, 'the previous close must not refuse a new pending join');
	assert.deepEqual(closeFields(f.getCloseInfo(1)), { code: 1006, reason: 'first network failed' });
	f.created[1].openEvent();
	assert.equal(f.getCloseInfo(), null);
	f.created[1].closeEvent(4403, 'current failure');
	assert.deepEqual(closeFields(f.getCloseInfo()), { code: 4403, reason: 'current failure' });
});

test('a late old close cannot contaminate the latest join', () => {
	const f = fixture();
	f.connect(1);
	f.serveMpWork();
	f.created[0].openEvent();
	f.connect(2);
	f.serveMpWork();
	f.created[0].closeEvent(1006, 'late old failure');
	assert.equal(f.getCloseInfo(), null);
	assert.deepEqual(closeFields(f.getCloseInfo(1)), { code: 1006, reason: 'late old failure' });
	f.created[1].openEvent();
	f.created[1].closeEvent(1000, 'current departure');
	assert.deepEqual(closeFields(f.getCloseInfo()), { code: 1000, reason: 'current departure' });
});


test('the bridge starts fresh diagnostics before the queued native socket is pumped', async () => {
	const f = fixture();
	f.connect(1);
	f.serveMpWork();
	f.created[0].openEvent();
	f.created[0].closeEvent(1000, 'previous lobby departure');
	f.program.OrderSubjectScratch = () => ({ byteLength: 16, set() {} });
	f.program.SnapshotBufferGeneration = () => 1;
	f.program.SnapshotBufferPointer = slot => slot * 64;
	f.program.SnapshotBufferCapacity = () => 64;
	f.program.JoinMultiplayer = () => { f.connect(2); return 'joining room epoch=2'; };
	const bridge = createSteelseedBridge(f.program, () => f.heap, f.transport);
	assert.equal(await bridge.joinMultiplayer('fixture', 80), 'joining room epoch=2');
	assert.equal(await bridge.getMpCloseInfo(), null,
		'a worker RPC can probe before the next socket pump; previous close must not refuse it');
	assert.deepEqual(closeFields(f.getCloseInfo(1)), { code: 1000, reason: 'previous lobby departure' });
	f.serveMpWork();
	f.created[1].closeEvent(4404, 'new room refused');
	assert.deepEqual(closeFields(await bridge.getMpCloseInfo()), { code: 4404, reason: 'new room refused' },
		'a genuine failure of the new attempt must still surface');
});

