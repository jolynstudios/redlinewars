import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTcpWriter, createWsWriter } from './relay-flow.mjs';

function fakeSocket() {
	const socket = new EventEmitter();
	socket.write = () => true;
	socket.writableLength = 0;
	socket.destroyed = false;
	socket.writableEnded = false;
	socket.destroy = () => { socket.destroyed = true; };
	return socket;
}
const buf = (size, fill = 0x41) => Buffer.alloc(size, fill);

test('tcp: pre-attach backlog flushes in FIFO order on attach', () => {
	const w = createTcpWriter({ limitBytes: 1024, onFailure: () => assert.fail('unexpected failure') });
	const first = buf(4, 1), second = buf(4, 2);
	assert.equal(w.write(first), true);
	assert.equal(w.write(second), true);
	const socket = fakeSocket();
	const sent = [];
	socket.write = chunk => { sent.push(chunk); return true; };
	w.attach(socket);
	assert.deepEqual(sent, [first, second]);
});

test('tcp: over-limit chunk reaches no socket and fails the channel once', () => {
	const failures = [];
	const w = createTcpWriter({ limitBytes: 10, onFailure: why => failures.push(why) });
	const socket = fakeSocket();
	const sent = [];
	socket.write = chunk => { sent.push(chunk); socket.writableLength += chunk.length; return false; };
	w.attach(socket);
	assert.equal(w.write(buf(8)), true);
	assert.equal(w.write(buf(3)), false); // 8 in flight + 3 > 10: terminal
	assert.equal(failures.length, 1);
	assert.deepEqual(sent, [buf(8)]);
	assert.equal(w.write(buf(1)), false);
	assert.equal(failures.length, 1);
});

test('tcp: admission bounded by queued bytes plus socket.writableLength until drain', () => {
	const failures = [];
	const w = createTcpWriter({ limitBytes: 20, onFailure: why => failures.push(why) });
	const socket = fakeSocket();
	let admitted = true;
	socket.write = chunk => { socket.writableLength += chunk.length; return admitted; };
	w.attach(socket);
	assert.equal(w.write(buf(10)), true);
	assert.equal(socket.writableLength, 10);
	admitted = false;
	assert.equal(w.write(buf(10)), true); // 10 in flight + 10 == cap
	assert.equal(socket.writableLength, 20); // queued app-side bytes flushed into the socket
	assert.equal(w.write(buf(1)), false); // 20 queued + 1 > 20: terminal
	assert.equal(failures.length, 1);
});

test('tcp: socket close while backlog pending fails the channel and releases references', () => {
	const failures = [];
	const w = createTcpWriter({ limitBytes: 1024, onFailure: why => failures.push(why) });
	assert.equal(w.write(buf(4)), true);
	const socket = fakeSocket();
	w.attach(socket);
	socket.emit('close');
	assert.equal(failures.length, 1);
	assert.equal(w.write(buf(1)), false);
});

test('tcp: attach after close destroys the socket', () => {
	const w = createTcpWriter({ limitBytes: 1024, onFailure: () => {} });
	w.close();
	const socket = fakeSocket();
	w.attach(socket);
	assert.equal(socket.destroyed, true);
});

test('ws: in-flight reservation blocks sends until the callback releases', () => {
	const ws = { readyState: 1, bufferedAmount: 0, sent: [] };
	let callback;
	ws.send = (data, options, cb) => { ws.sent.push(data); callback = cb; };
	const failures = [];
	const w = createWsWriter(ws, { limitBytes: 10, onFailure: why => failures.push(why) });
	assert.equal(w.send(buf(6)), true);
	assert.equal(w.send(buf(6)), false); // 6 in flight + 6 > 10: terminal
	assert.equal(failures.length, 1);
	assert.equal(w.send(buf(1)), false);
	callback();
	const w2 = createWsWriter(ws, { limitBytes: 10, onFailure: () => assert.fail('unexpected failure') });
	assert.equal(w2.send(buf(6)), true);
	callback();
	assert.equal(w2.send(buf(6)), true); // released: 0 in flight + 6 <= 10
});

test('tcp lifecycle: drain resumes once; teardown discards queued bytes and ignores late drain', () => {
	const failures = [];
	const sent = [];
	const socket = fakeSocket();
	socket.write = chunk => {
		sent.push(Buffer.from(chunk));
		socket.writableLength += chunk.length;
		return false;
	};
	const writer = createTcpWriter({ limitBytes: 8, onFailure: error => failures.push(error) });
	writer.write(Buffer.from('ab'));
	writer.write(Buffer.from('cd'));
	writer.attach(socket);
	assert.deepEqual(Buffer.concat(sent), Buffer.from('ab'));
	assert.equal(writer.write(Buffer.from('ef')), true);
	socket.writableLength = 0;
	socket.emit('drain');
	assert.deepEqual(Buffer.concat(sent), Buffer.from('abcd'));
	socket.emit('close');
	assert.equal(failures.length, 1);
	socket.writableLength = 0;
	socket.emit('drain');
	assert.equal(writer.write(Buffer.from('gh')), false);
	assert.deepEqual(Buffer.concat(sent), Buffer.from('abcd'));
	assert.equal(failures.length, 1);
});
