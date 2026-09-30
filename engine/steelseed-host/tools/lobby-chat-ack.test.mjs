import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../OpenRA.Browser/wwwroot/openra-steelseed-bridge.js', import.meta.url), 'utf8');
const { createSteelseedBridge } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
function bridge(program) {
	const heap = new Uint8Array(128);
	return createSteelseedBridge({
		OrderSubjectScratch: () => ({ byteLength: 4 }),
		SnapshotBufferGeneration: () => 1,
		SnapshotBufferPointer: slot => slot * 64,
		SnapshotBufferCapacity: () => 64,
		...program,
	}, () => heap);
}

test('lobby send resolves successfully only after matching server acknowledgement', async () => {
	let polls = 0;
	const api = bridge({
		LobbySendChat: text => { assert.equal(text, 'hello'); return 'chat queued 7'; },
		GetLobbyChatSendStatus: request => { assert.equal(request, 7); return ++polls < 2 ? 'pending' : 'accepted'; },
		CancelLobbyChatSend: () => assert.fail('accepted request must not be canceled'),
	});
	assert.equal(await api.lobbySendChat('hello'), 'chat sent');
	assert.equal(polls, 2);
});

test('join or flood refusal is returned so the HUD preserves the draft', async () => {
	const reason = 'Chat is temporarily rate limited. Retry shortly.';
	const api = bridge({ LobbySendChat: () => 'chat queued 3', GetLobbyChatSendStatus: () => reason });
	assert.equal(await api.lobbySendChat('keep this draft'), reason);
});

test('one pending request prevents a second send without falsely reporting success', async () => {
	const api = bridge({ LobbySendChat: () => 'a message is awaiting confirmation' });
	assert.equal(await api.lobbySendChat('next draft'), 'a message is awaiting confirmation');
});

test('a missing acknowledgement times out and releases the pending request', async t => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	let canceled = null;
	const api = bridge({
		LobbySendChat: () => 'chat queued 9',
		GetLobbyChatSendStatus: () => 'pending',
		CancelLobbyChatSend: request => { canceled = request; },
	});
	const pending = api.lobbySendChat('unsent draft');
	t.mock.timers.tick(5000);
	assert.equal(await pending, 'Chat confirmation timed out. Retry shortly.');
	assert.equal(canceled, 9);
});
