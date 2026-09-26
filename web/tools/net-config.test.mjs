// T5.1 acceptance (MULTIPLAYER-SERVICE.md, Phase 5): the net-config loader
// fails closed. Covers the four mandated cases — missing file, bad JSON,
// unknown value, http: relay on a non-loopback page — plus the shell
// shortcut and the relay validation rules of §5.1.
// Runs under plain `node --test` (Node ≥22.18 strips the loader's types).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNetConfig, parseNetConfig } from '../src/core/net-config.ts';
import fs from 'node:fs';
import path from 'node:path';

const GOOD = { schema: 1, relay: 'https://play.redlinewars.online', browserMultiplayer: 'join' };

const ok = (payload, pageHost = 'www.redlinewars.online') =>
	loadNetConfig({ fetchJson: async () => payload, pageHost });

test('missing file (fetch rejects) yields off', async () => {
	const cfg = await loadNetConfig({
		fetchJson: async () => { throw new Error('404 not found'); },
		pageHost: 'www.redlinewars.online',
	});
	assert.deepEqual(cfg, { relay: null, browserMultiplayer: 'off' });
});

test('bad JSON (res.json rejects) yields off', async () => {
	const cfg = await loadNetConfig({
		fetchJson: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
		pageHost: 'www.redlinewars.online',
	});
	assert.deepEqual(cfg, { relay: null, browserMultiplayer: 'off' });
});

test('unknown browserMultiplayer value yields off', async () => {
	assert.deepEqual(await ok({ ...GOOD, browserMultiplayer: 'maybe' }),
		{ relay: null, browserMultiplayer: 'off' });
});

test('http: relay on a non-loopback page yields off', async () => {
	assert.deepEqual(await ok({ ...GOOD, relay: 'http://play.redlinewars.online' }),
		{ relay: null, browserMultiplayer: 'off' });
});

test('schema other than 1 yields off', async () => {
	assert.deepEqual(await ok({ ...GOOD, schema: 2 }),
		{ relay: null, browserMultiplayer: 'off' });
});

test('join with a valid https relay is accepted', async () => {
	assert.deepEqual(await ok(GOOD),
		{ relay: 'https://play.redlinewars.online', browserMultiplayer: 'join' });
});

test('account origin is optional and only accepts a secure absolute origin', async () => {
	assert.deepEqual(await ok({ ...GOOD, accountOrigin: 'https://www.redlinewars.online/api/' }), {
		relay: GOOD.relay,
		browserMultiplayer: 'join',
		accountOrigin: 'https://www.redlinewars.online',
	});
	assert.deepEqual(await ok({ ...GOOD, accountOrigin: 'http://www.redlinewars.online' }), {
		relay: GOOD.relay,
		browserMultiplayer: 'join',
	});
});

test('http: relay is accepted on a loopback page (dev)', async () => {
	for (const host of ['127.0.0.1:5173', 'localhost:5173']) {
		assert.deepEqual(await ok({ ...GOOD, relay: 'http://127.0.0.1:13600' }, host),
			{ relay: 'http://127.0.0.1:13600', browserMultiplayer: 'join' });
	}
});

test('off keeps the mode and may still carry a valid relay (no requests in off)', async () => {
	assert.deepEqual(await ok({ schema: 1, relay: GOOD.relay, browserMultiplayer: 'off' }),
		{ relay: GOOD.relay, browserMultiplayer: 'off' });
});

test('join without a usable relay yields off', async () => {
	assert.deepEqual(await ok({ schema: 1, browserMultiplayer: 'join' }),
		{ relay: null, browserMultiplayer: 'off' });
	assert.deepEqual(await ok({ ...GOOD, relay: 'not-a-url' }),
		{ relay: null, browserMultiplayer: 'off' });
	assert.deepEqual(await ok({ ...GOOD, relay: 'ftp://play.redlinewars.online' }),
		{ relay: null, browserMultiplayer: 'off' });
});

test('malformed payloads yield off', async () => {
	assert.deepEqual(await ok(null), { relay: null, browserMultiplayer: 'off' });
	assert.deepEqual(await ok('nope'), { relay: null, browserMultiplayer: 'off' });
	assert.deepEqual(await ok(42), { relay: null, browserMultiplayer: 'off' });
	assert.deepEqual(await ok([]), { relay: null, browserMultiplayer: 'off' });
});

test('desktop shell answers full without fetching', async () => {
	const cfg = await loadNetConfig({
		fetchJson: async () => { throw new Error('must not fetch inside the shell'); },
		shellPresent: true,
		pageHost: 'www.redlinewars.online',
	});
	assert.deepEqual(cfg, { relay: null, browserMultiplayer: 'full' });
});

test('parseNetConfig is a pure mirror of the loader contract', () => {
	assert.equal(parseNetConfig(GOOD, 'www.redlinewars.online').browserMultiplayer, 'join');
	assert.equal(parseNetConfig(GOOD, '192.168.1.20').browserMultiplayer, 'join');
	assert.deepEqual(parseNetConfig({ ...GOOD, relay: 'http://127.0.0.1:13600' }, '192.168.1.20'),
		{ relay: null, browserMultiplayer: 'off' });
});

test('UI polling has an explicit production-off request guard', () => {
	const ui = fs.readFileSync(path.resolve(import.meta.dirname, '../src/ui/index.ts'), 'utf8');
	assert.match(ui, /private async refreshMpRooms\(\)[\s\S]*?if \(this\.effectiveMpMode\(\) === 'off'\) return[\s\S]*?fetch\(`/);
	assert.match(ui, /private selectSessionTab[\s\S]*?if \(this\.effectiveMpMode\(\) === 'off'\) \{[\s\S]*?return/);
	assert.match(ui, /if \(mode === 'off'\) \{[\s\S]*?this\.stopMpRoomsPolling\(\)/);
});
