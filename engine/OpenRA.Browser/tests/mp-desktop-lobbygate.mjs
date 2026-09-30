// Phase 1 local rendered-UI regression gate. Never contacts a public relay and
// never builds or copies the shared AppBundle. Run AFTER compose and engine build:
//   node engine/OpenRA.Browser/tests/mp-desktop-lobbygate.mjs
// LOBBY_GATE_IDLE_SECONDS (default 45) shortens the engine idle term only here.
// Outputs screenshots/report.json to LOBBY_GATE_OUTPUT or a fresh temp directory.
import { loadChromium, launchGpuBrowser } from '../../../web/tools/harness.mjs';
import { spawnProcessGroup, stopProcessGroup } from '../../../web/tools/process-group.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const engine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const httpPort = Number(process.env.LOBBY_GATE_HTTP ?? 13862);
const wsPort = Number(process.env.LOBBY_GATE_WS ?? 13863);
const basePort = Number(process.env.LOBBY_GATE_BASE ?? 13870);
const idleSeconds = Number(process.env.LOBBY_GATE_IDLE_SECONDS ?? 45);
if (!Number.isFinite(idleSeconds) || idleSeconds < 30) throw new Error('idle term must be at least 30 seconds to allow UI synchronization');
const origin = `http://127.0.0.1:${httpPort}`;
const nodeKey = crypto.randomBytes(32).toString('hex');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lobbygate-node-'));
const outputDir = process.env.LOBBY_GATE_OUTPUT ? path.resolve(process.env.LOBBY_GATE_OUTPUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-lobbygate-evidence-'));
fs.mkdirSync(outputDir, { recursive: true });
const bundle = path.join(engine, 'bin-browser/AppBundle');
const build = JSON.parse(fs.readFileSync(path.join(bundle, 'steelseed/build.json'), 'utf8'));
const hostBuild = JSON.parse(fs.readFileSync(path.join(engine, 'steelseed-host/generated/build.json'), 'utf8'));
if (build.simBuild !== hostBuild.simBuild || build.modHash !== hostBuild.modHash) throw new Error('shared AppBundle and native host stamps differ; build and compose before this gate');
const catalog = JSON.parse(fs.readFileSync(path.join(engine, 'steelseed-host/generated/mods/ra/map-catalog.json'), 'utf8'));
const mapCandidates = catalog.filter(map => Number(map.players) >= 5);
const firstMap = mapCandidates[0];
const secondMap = mapCandidates.find(map => map.players !== firstMap?.players) ?? mapCandidates[1];
const maps = [firstMap, secondMap];
if (!maps.every(Boolean)) throw new Error('gate needs two generated maps with at least five seats');
const netConfig = JSON.parse(fs.readFileSync(path.join(bundle, 'steelseed/net-config.json'), 'utf8'));
const clients = [];
const checks = [];
const log = [];
const privateMessages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let roomhost;
let passed = false;

function assert(condition, reason) { if (!condition) throw new Error(reason); }
async function waitFor(fn, label, timeout = 30_000) {
	const deadline = Date.now() + timeout;
	let last;
	while (Date.now() <= deadline) {
		last = await fn();
		if (last) return last;
		await sleep(250);
	}
	throw new Error(`TIMEOUT ${label} (${timeout}ms); last=${JSON.stringify(last)}`);
}
async function api(route = '/v2/rooms', method = 'GET', body) {
	const response = await fetch(origin + route, {
		method, headers: { 'content-type': 'application/json', 'x-redline-node-key': nodeKey },
		...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000),
	});
	return { status: response.status, data: await response.json() };
}
async function rooms() {
	const result = await api();
	return Array.isArray(result.data) ? result.data : result.data.rooms ?? [];
}
async function snapshot(client) {
	const value = await client.page.evaluate(async () => JSON.parse(await globalThis.ora.GetLobbySnapshotProbe() || 'null'));
	// A disposed manager has no lobby; null is an empty ephemeral state.
	return value ?? { started: false, localClientIndex: -1, adminClientIndex: -1, clients: [], options: [], slots: [], chat: [] };
}
async function probe(client) { return client.page.evaluate(() => globalThis.ora.GetConnectionProbe()); }
async function state(client, predicate, label, timeout = 30_000) {
	let last;
	try { return await waitFor(async () => { last = await snapshot(client); return predicate(last) ? last : false; }, label, timeout); }
	catch (error) { throw new Error(`${error.message}; engine=${JSON.stringify(last)}`); }
}
function local(snapshot) { return snapshot.clients.find(c => c.index === snapshot.localClientIndex); }
function participant(snapshot, name) { return snapshot.clients.find(c => c.name === name); }
async function screenshot(client, name) {
	await client.page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true });
}
async function check(name, fn) {
	const started = Date.now();
	await fn();
	assertBrowserClean();
	checks.push({ name, status: 'passed', milliseconds: Date.now() - started });
	console.log(`PASS ${name}`);
}
function assertBrowserClean() {
	assert(clients.every(client => client.errors.length === 0), `browser page errors or unexpected external requests: ${JSON.stringify(clients.map(client => ({ name: client.name, errors: client.errors })))}`);
}
function action(client, text) { return client.page.locator('#mp-setup .mp-lobby-actions').getByRole('button', { name: text, exact: true }); }
async function boot(chromium, name) {
	const gpu = await launchGpuBrowser(chromium, 'mp-desktop-lobbygate', [
		'--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
	]);
	const client = { name, browser: gpu.browser, page: await gpu.browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors: [], console: [], accountFixtures: 0 };
	clients.push(client);
	client.page.on('pageerror', error => client.errors.push(String(error)));
	client.page.on('console', message => client.console.push(message.text()));
	await client.page.addInitScript(({ dir, key }) => { globalThis.__redlineLocalNode = { dir, key }; }, { dir: origin, key: nodeKey });
	await client.page.route('**/*', route => {
		const url = new URL(route.request().url());
		// Anonymous account bootstrap belongs to the shared browser UI. Provide
		// its one expected response locally without allowing a public request.
		if (url.origin === netConfig.accountOrigin && url.pathname === '/api/me' && route.request().method() === 'GET') {
			client.accountFixtures++;
			return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: null }), headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } });
		}
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
				client.errors.push(`non-local request blocked: ${url.origin}${url.pathname}`);
				return route.abort();
			}
		}
		return route.continue();
	});
	// Override the runtime config response only; no file or shipping switch changes.
	await client.page.route('**/net-config.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...netConfig, relay: origin, browserMultiplayer: 'full' }) }));
	await client.page.goto(`${origin}/steelseed/index.html?mode=game&platform=null&mp=1&Player.Name=${name}`, { timeout: 60_000 });
	await client.page.waitForFunction(() => globalThis.steelseed && globalThis.ora && globalThis.steelseedBridge, undefined, { timeout: 240_000, polling: 250 });
	await client.page.waitForFunction(async () => { try { return await globalThis.ora.IsRunning() && !document.querySelector('#session-start')?.disabled; } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
	assert(await client.page.evaluate(() => typeof globalThis.ora.GetLobbySnapshotProbe === 'function'), 'shared AppBundle lacks fresh phase-1 engine snapshot export');
	await client.page.evaluate(() => {
		globalThis.__lobbyGateStatuses = [];
		for (const status of document.querySelectorAll('#session-status, #session-mp-status')) {
			new MutationObserver(() => {
				globalThis.__lobbyGateStatuses.push(status.textContent);
				if (globalThis.__lobbyGateStatuses.length > 100) globalThis.__lobbyGateStatuses.shift();
			}).observe(status, { subtree: true, childList: true, characterData: true });
		}
	});
	await client.page.selectOption('#session-map', maps[0].uid);
	console.log(`BOOT ${name}`);
	return client;
}
async function host(client, { observer = false, capacity = 5, name = `${client.name} room` } = {}) {
	// Native builds and other GPU gates can briefly push the one-minute load
	// average above the node's real admission threshold. Respect that policy;
	// wait for headroom rather than weakening production capacity validation.
	await waitFor(async () => {
		const result = await api('/v2/health');
		const loadPct = os.loadavg()[0] / os.cpus().length;
		const available = process.availableMemory?.() ?? os.freemem();
		return loadPct < 0.8 && available > 512 * 1024 * 1024 && result.data.freeMatches > 0;
	}, 'local node healthy with room capacity', 240_000);
	await client.page.click('#session-tab-mp');
	await client.page.fill('#session-mp-name', client.name);
	await client.page.fill('#session-mp-roomname', name);
	await client.page.selectOption('#session-mp-slots', String(capacity));
	await client.page.locator('#session-mp-spectate').setChecked(observer);
	const before = new Set((await rooms()).map(room => room.roomId));
	await client.page.click('#session-mp-host');
	const room = await waitFor(async () => (await rooms()).find(room => !before.has(room.roomId)), 'new rendered Host room', 60_000);
	await waitFor(async () => /state=Connected/.test(await probe(client)), `${client.name} host connected`, 90_000);
	await state(client, s => !!local(s), `${client.name} engine lobby client`);
	client.joinedAt = Date.now();
	await client.page.locator('#mp-setup').waitFor({ state: 'visible' });
	return room;
}
async function join(client, room) {
	await client.page.click('#session-tab-mp');
	await client.page.fill('#session-mp-name', client.name);
	const button = client.page.locator(`#session-mp-rooms-body tr[data-room-id="${room.roomId}"] td.room-join button`);
	await button.waitFor({ state: 'visible', timeout: 60_000 });
	await button.click();
	await waitFor(async () => /state=Connected/.test(await probe(client)), `${client.name} UI join connected`, 90_000);
	await state(client, s => local(s)?.slot != null, `${client.name} takes player seat`);
	await client.page.waitForFunction(() => document.querySelector('#session-mp-panel')?.dataset.mpPhase === 'lobby', undefined, { polling: 100 });
	client.joinedAt = Date.now();
}
async function leave(client) {
	const button = action(client, 'Leave game');
	if (await button.isVisible()) await button.click();
	else if (await client.page.locator('#mp-match-banner button').isVisible()) await client.page.locator('#mp-match-banner button').click();
	else {
		// A live browser match exposes Menu > Return to main menu, which reloads
		// the same shared page. Exercise that real control rather than invoking
		// the engine's leave export from the test.
		await client.page.click('#hud-menu');
		await Promise.all([
			client.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
			client.page.click('#menu-main'),
		]);
		await client.page.waitForFunction(() => globalThis.steelseed && globalThis.ora && globalThis.steelseedBridge, undefined, { timeout: 240_000, polling: 250 });
		await client.page.waitForFunction(async () => { try { return await globalThis.ora.IsRunning() && !document.querySelector('#session-start')?.disabled; } catch { return false; } }, undefined, { timeout: 60_000, polling: 250 });
		await client.page.selectOption('#session-map', maps[0].uid);
	}
	await waitFor(async () => /(?:state=(?:NotConnected|local)|^no connection$)/.test(await probe(client)), `${client.name} left`);
	await client.page.locator('#mp-setup').waitFor({ state: 'hidden' });
	await waitFor(async () => (await snapshot(client)).chat.length === 0, `${client.name} leave clears chat`);
}
async function chat(client, tag) {
	const sender = local(await snapshot(client));
	if (!sender?.admin) {
		const remaining = 6000 - (Date.now() - (client.joinedAt ?? Date.now()));
		if (remaining > 0) await sleep(remaining);
	}
	const text = `lobby-memory-${tag}-${crypto.randomBytes(12).toString('hex')}`;
	privateMessages.push(text);
	await client.page.getByRole('textbox', { name: 'Lobby message', exact: true }).fill(text);
	await client.page.locator('.mp-lobby-chat-form').getByRole('button', { name: 'Send', exact: true }).click();
	await state(client, s => s.chat.some(message => message.text === text), 'chat confirmed by engine');
	return text;
}
async function expectChat(client, text) {
	await state(client, s => s.chat.some(message => message.text === text), `${client.name} live chat`);
	await client.page.locator('.mp-lobby-chat').getByText(text, { exact: true }).waitFor();
}
async function expectMapFooter(map) {
	for (const client of clients) {
		await state(client, s => s.map === map.uid, `${client.name} authoritative map`);
		await waitFor(async () => (await client.page.locator('#session-status').textContent()).startsWith(`Ready · ${map.title} by `), `${client.name} footer reflects live room map`);
	}
}
async function ready(client, value = true) {
	const s = await snapshot(client);
	if ((local(s)?.state === 'Ready') !== value) await action(client, value ? 'Ready' : 'Not ready').click();
	await state(client, s => (local(s)?.state === 'Ready') === value, `${client.name} ready=${value}`);
}
async function chooseRule(client, id) {
	const s = await snapshot(client);
	const descriptor = s.options.find(option => option.id === id && !option.locked && option.values.some(v => v.id !== option.value));
	assert(descriptor, `no mutable ${id} engine option`);
	const wanted = descriptor.values.find(v => v.id !== descriptor.value).id;
	await client.page.locator(`.mp-lobby-rules select[data-field="lobby-${id}"]`).selectOption(wanted);
	await client.page.locator('.mp-lobby-note').click();
	await state(client, s => s.options.some(option => option.id === id && option.value === wanted), `rule ${id} round trip`);
}
function files(root) {
	return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const file = path.join(root, entry.name);
		return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
	});
}
async function storageContains(client, text) {
	return client.page.evaluate(async needle => {
		async function contains(value) {
			if (typeof value === 'string') return value.includes(needle);
			if (value instanceof Blob) return contains(await value.arrayBuffer());
			if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
				const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
				return new TextDecoder().decode(bytes).includes(needle) || new TextDecoder('utf-16le').decode(bytes).includes(needle);
			}
			if (value && typeof value === 'object') for (const item of Object.values(value)) if (await contains(item)) return true;
			return false;
		}
		if ([localStorage, sessionStorage].some(storage => Object.keys(storage).some(key => String(storage.getItem(key)).includes(needle)))) return true;
		for (const database of await indexedDB.databases()) {
			const db = await new Promise((resolve, reject) => { const request = indexedDB.open(database.name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
			try {
				for (const name of db.objectStoreNames) {
					const values = await new Promise((resolve, reject) => { const request = db.transaction(name, 'readonly').objectStore(name).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
					if (await contains(values)) return true;
				}
			} finally { db.close(); }
		}
		return false;
	}, text);
}

try {
	roomhost = spawnProcessGroup(process.execPath, [path.join(engine, 'steelseed-host/tools/roomhost.mjs'),
		'--bundle', bundle, '--http', String(httpPort), '--ws', String(wsPort), '--base-port', String(basePort),
		'--max-matches', '3', '--data-dir', dataDir, '--admin-idle-seconds', String(idleSeconds), '--idle-kill', '300',
	], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REDLINE_NODE_KEY: nodeKey } });
	for (const stream of [roomhost.stdout, roomhost.stderr]) stream.on('data', chunk => log.push(String(chunk)));
	await waitFor(() => api('/v2/health').then(result => result.status === 200).catch(() => false), 'local node ready', 20_000);
	const chromium = await loadChromium('mp-desktop-lobbygate');
	const admin = await boot(chromium, 'LobbyAdmin');
	const alpha = await boot(chromium, 'LobbyAlpha');
	const bravo = await boot(chromium, 'LobbyBravo');
	assertBrowserClean();
	assert(clients.every(client => client.accountFixtures > 0), 'anonymous account bootstrap fixture was not exercised');
	let room;
	await check('observer host retains administration and capacity five without a seat', async () => {
		room = await host(admin, { observer: true });
		const s = await state(admin, s => local(s)?.admin && local(s).slot == null && s.capacity === 5, 'observer admin and five seats');
		assert(s.requestedCapacity === 5, 'creation lost requested capacity');
		assert(!s.startAllowed, 'empty observer room should not start');
		await admin.page.locator('.mp-lobby-host').waitFor({ state: 'visible' });
		const geometry = await admin.page.evaluate(() => {
			const box = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
			return {
				panel: box(document.querySelector('#mp-setup')),
				rules: box(document.querySelector('.mp-lobby-rules')),
				selects: [...document.querySelectorAll('.mp-lobby-host > label > select')].map(box),
				visibleBottom: document.querySelector('#session-status')?.getBoundingClientRect().top ?? innerHeight,
			};
		});
		assert(geometry.selects.length === 2, 'live Map/Seats controls missing');
		for (const box of geometry.selects) assert(box.width > 50 && box.height >= 20 && box.top >= geometry.panel.top && box.bottom <= geometry.visibleBottom && box.left >= geometry.panel.left && box.right <= geometry.panel.right,
			`live Map/Seats control lies outside visible room panel: ${JSON.stringify(geometry)}`);
		assert(geometry.rules.top >= Math.max(...geometry.selects.map(box => box.bottom)), `rules stretch Map/Seats below their row: ${JSON.stringify(geometry)}`);
		await screenshot(admin, '01-observer-admin');
	});
	await check('ready toggles and live chat has no backlog for later members', async () => {
		await join(alpha, room);
		await ready(alpha);
		await ready(alpha, false);
		const earlier = await chat(admin, 'before-bravo');
		await expectChat(alpha, earlier);
		await join(bravo, room);
		assert(!(await snapshot(bravo)).chat.some(message => message.text === earlier), 'new member received chat backlog');
		const rejected = `lobby-memory-refused-${crypto.randomBytes(12).toString('hex')}`;
		privateMessages.push(rejected);
		const input = bravo.page.getByRole('textbox', { name: 'Lobby message', exact: true });
		await input.fill(rejected);
		await bravo.page.locator('.mp-lobby-chat-form').getByRole('button', { name: 'Send', exact: true }).click();
		await bravo.page.waitForFunction(() => globalThis.__lobbyGateStatuses.some(text => /^Message refused/.test(text)), undefined, { timeout: 10_000, polling: 100 });
		assert(await input.inputValue() === rejected, 'refused chat silently cleared the draft');
		assert(!(await snapshot(bravo)).chat.some(message => message.text === rejected), 'refused chat incorrectly delivered');
		await sleep(6000);
		await bravo.page.locator('.mp-lobby-chat-form').getByRole('button', { name: 'Send', exact: true }).click();
		await Promise.all([expectChat(admin, rejected), expectChat(alpha, rejected), expectChat(bravo, rejected)]);
		const current = await chat(bravo, 'current-members');
		await Promise.all([expectChat(admin, current), expectChat(alpha, current)]);
		// A connected joiner must not retain the transient Connecting footer.
		// Check before retention, after the deliberately immediate refusal test.
		await expectMapFooter(maps[0]);
		await screenshot(alpha, '02-live-chat');
	});
	await check('one-click human kick permits rejoin and clears victim chat', async () => {
		let dialogs = 0;
		admin.page.on('dialog', dialog => { dialogs++; void dialog.dismiss(); });
		await admin.page.locator('.mp-roster-row').filter({ has: admin.page.locator('.mp-roster-name', { hasText: bravo.name }) }).getByRole('button', { name: 'Kick', exact: true }).click();
		await waitFor(async () => /state=NotConnected/.test(await probe(bravo)), 'kick disconnected victim');
		await waitFor(async () => (await snapshot(bravo)).chat.length === 0, 'disconnect clears engine chat');
		assert(dialogs === 0, 'Kick displayed a confirmation dialog');
		await leave(bravo);
		await join(bravo, room);
		assert((await snapshot(bravo)).chat.length === 0, 'rejoin has old chat');
	});
	await check('chat keeps at most one hundred visible messages', async () => {
		const prefix = `lobby-cap-${crypto.randomBytes(12).toString('hex')}`;
		privateMessages.push(prefix);
		const input = admin.page.getByRole('textbox', { name: 'Lobby message', exact: true });
		for (let i = 0; i < 102; i++) {
			await input.fill(`${prefix}-${i}`);
			await input.press('Enter');
			await waitFor(async () => (await input.inputValue()) === '', `UI chat submit ${i}`);
			await state(admin, s => s.chat.some(message => message.text === `${prefix}-${i}`), `retention message ${i} echoed`);
			// OpenRA's existing message tracker permits five messages per five
			// seconds. Capacity retention is independent of flood protection.
			if (i < 101) await sleep(1100);
		}
		await state(admin, s => s.chat.length === 100 && s.chat.at(-1)?.text === `${prefix}-101`, 'engine retains latest hundred chat messages');
		await waitFor(async () => await admin.page.locator('.mp-lobby-chat li').count() === 100, 'one hundred visible chat rows');
		assert(!(await snapshot(admin)).chat.some(message => message.text === `${prefix}-0`), 'oldest chat message retained beyond cap');
	});
	await check('single and all AI removal use rendered controls', async () => {
		await action(admin, 'Add AI').click();
		const s = await state(admin, s => s.clients.filter(c => c.bot).length === 3, 'three AI in remaining capacity');
		const name = s.clients.find(c => c.bot).name;
		await admin.page.locator('.mp-roster-row').filter({ has: admin.page.locator('.mp-roster-name', { hasText: name }) }).getByRole('button', { name: 'Remove AI', exact: true }).first().click();
		await state(admin, s => s.clients.filter(c => c.bot).length === 2, 'one AI removed');
		await action(admin, 'Remove all AI').click();
		await state(admin, s => s.clients.every(c => !c.bot), 'all AI removed');
	});
	await check('admin rules map capacity and player controls round trip through engine', async () => {
		await ready(alpha);
		await chooseRule(admin, 'tod');
		await chooseRule(admin, 'weather');
		await state(alpha, s => local(s).state !== 'Ready', 'room rule invalidates ready');
		const hostSelects = admin.page.locator('.mp-lobby-host > label > select');
		await hostSelects.nth(1).selectOption('4');
		await admin.page.locator('.mp-lobby-note').click();
		await state(admin, s => s.capacity === 4, 'four seats reflected');
		await hostSelects.nth(1).selectOption('5');
		await admin.page.locator('.mp-lobby-note').click();
		await state(admin, s => s.capacity === 5, 'five seats reflected');
		await hostSelects.nth(0).selectOption(maps[1].uid);
		await admin.page.locator('.mp-lobby-note').click();
		await state(admin, s => s.map === maps[1].uid && s.capacity === 5 && s.requestedCapacity === 5, 'map preserves selected capacity', 60_000);
		await expectMapFooter(maps[1]);
		await waitFor(async () => await admin.page.getByLabel(`Spawn for ${alpha.name}`, { exact: true }).locator('option').count() === Number(maps[1].players) + 1, 'map rebuild refreshes spawn dropdown');
		for (const [label, field, wanted] of [['Team', 'team', '1'], ['Spawn', 'spawn', '1']]) {
			await admin.page.getByLabel(`${label} for ${alpha.name}`, { exact: true }).selectOption(wanted);
			await state(admin, s => String(participant(s, alpha.name)?.[field]) === wanted, `${label} remote player round trip`);
		}
		const select = admin.page.getByLabel(`Faction for ${alpha.name}`, { exact: true });
		const selected = await select.inputValue();
		const wanted = await select.locator('option').evaluateAll((options, old) => options.find(option => option.value !== old && !option.disabled)?.value, selected);
		assert(wanted, 'no alternative faction available');
		await select.selectOption(wanted);
		await state(admin, s => participant(s, alpha.name)?.faction === wanted, 'faction remote player round trip');
		const smallMap = catalog.find(map => Number(map.players) === 2);
		assert(smallMap, 'map catalog lacks a two-seat map for capacity retention');
		await hostSelects.nth(0).selectOption(smallMap.uid);
		await admin.page.locator('.mp-lobby-note').click();
		await state(admin, s => s.map === smallMap.uid && s.capacity === 2 && s.requestedCapacity === 5, 'small map bounds actual seats retaining chosen five', 60_000);
		await expectMapFooter(smallMap);
		await hostSelects.nth(0).selectOption(maps[1].uid);
		await admin.page.locator('.mp-lobby-note').click();
		await state(admin, s => s.map === maps[1].uid && s.capacity === 5 && s.requestedCapacity === 5, 'larger map restores chosen five', 60_000);
		await expectMapFooter(maps[1]);
		await screenshot(admin, '03-live-rules-and-seats');
	});
	await check('Host leaves previous lobby and creates a clean new session', async () => {
		const previousRoom = room;
		room = await host(admin, { observer: true, name: 'Fresh host session' });
		const s = await snapshot(admin);
		assert(!s.started && s.clients.length === 1 && s.chat.length === 0 && local(s).slot == null, 'Host inherited old session state');
		assert(room.roomId !== previousRoom.roomId, 'Host reused previous room');
		await state(alpha, s => !participant(s, admin.name), 'previous room confirms host departure');
		await leave(alpha);
		await leave(bravo);
		await join(alpha, room);
		await join(bravo, room);
		// The observer admin is exempt from the join cooldown. This canary
		// checks Start cleanup without re-testing the explicit refusal above.
		const message = await chat(admin, 'new-lobby-before-start');
		await Promise.all([expectChat(alpha, message), expectChat(bravo, message)]);
	});
	await check('capacity five starts with two ready humans and three optional empty seats', async () => {
		await ready(alpha);
		await ready(bravo);
		await state(admin, s => s.startAllowed && s.capacity === 5, 'two ready humans permit Start');
		for (const client of [admin, alpha, bravo]) await client.page.evaluate(() => {
			globalThis.__phase1StartEvidence = null;
			const deadline = performance.now() + 120_000;
			const observe = () => {
				const ui = globalThis.steelseed.ctx.get('ui');
				if (ui.mpPhase === 'playing') {
					globalThis.__phase1StartEvidence = {
						memoryMessages: ui.mpLobbySnapshot?.chat?.length ?? 0,
						domMessages: document.querySelectorAll('.mp-lobby-chat li').length,
						inputText: document.querySelector('.mp-lobby-chat-form input')?.value ?? '',
						formHidden: document.querySelector('.mp-lobby-chat-form')?.hidden === true,
					};
				} else if (performance.now() < deadline) requestAnimationFrame(observe);
			};
			requestAnimationFrame(observe);
		});
		await action(admin, 'Start match').click();
		for (const client of [admin, alpha, bravo]) await waitFor(async () => /started=True/.test(await probe(client)), `${client.name} match started`, 120_000);
		for (const client of [admin, alpha, bravo]) {
			assert((await snapshot(client)).chat.length === 0, `${client.name} chat remains at Start`);
			assert(!(await client.page.locator('.mp-lobby-chat-form').isVisible()), `${client.name} free text stays visible during match`);
			const firstPlaying = await waitFor(() => client.page.evaluate(() => globalThis.__phase1StartEvidence), `${client.name} first playing frame chat evidence`);
			assert(firstPlaying.memoryMessages === 0 && firstPlaying.domMessages === 0 && firstPlaying.inputText === '' && firstPlaying.formHidden,
				`${client.name} first playing frame retains chat: ${JSON.stringify(firstPlaying)}`);
		}
		await sleep((idleSeconds + 5) * 1000);
		const s = await snapshot(alpha);
		assert(participant(s, admin.name)?.admin, 'playing admin was idle-demoted');
		const playerProbes = await Promise.all([probe(alpha), probe(bravo)]);
		assert(playerProbes.every(value => !/outofsync=True/.test(value)), 'match desynced');
		assert(playerProbes.every(value => Number(/netframe=(\d+)/.exec(value)?.[1] ?? 0) >= 50), `match frames stalled: ${playerProbes.join('\n')}`);
		await screenshot(alpha, '04-two-human-match');
	});
	await check('match departure returns each client to a clean room browser', async () => {
		await leave(admin);
		await leave(alpha);
		await leave(bravo);
		room = await host(admin, { observer: true, name: 'Idle transfer room' });
	});
	await check('lone admin exempt; idle transfer keeps connections and renews successor term', async () => {
		await sleep((idleSeconds + 5) * 1000);
		assert(local(await snapshot(admin)).admin, 'lone admin idle-demoted');
		await join(alpha, room);
		const waitingAt = Date.now();
		await state(alpha, s => local(s).admin && participant(s, admin.name)?.admin === false, 'idle admin promoted waiting human', (idleSeconds * 2 + 15) * 1000);
		assert(/state=Connected/.test(await probe(admin)), 'idle transfer disconnected former admin');
		await alpha.page.locator('.mp-lobby-host').waitFor({ state: 'visible' });
		// Keep the successor silent; any rule/chat command here would renew the
		// term itself and hide an inherited-expired-timer regression.
		await sleep(Math.floor(idleSeconds / 2) * 1000);
		assert(local(await snapshot(alpha)).admin, 'successor inherited expired idle term');
		await chooseRule(alpha, 'weather');
		await join(bravo, room);
		for (const label of ['Faction', 'Team', 'Spawn']) assert(await alpha.page.getByLabel(`${label} for ${bravo.name}`, { exact: true }).isEnabled(), `promoted admin cannot edit ${label}`);
		await alpha.page.getByLabel(`Team for ${bravo.name}`, { exact: true }).selectOption('2');
		await state(alpha, s => participant(s, bravo.name)?.team === 2, 'promoted admin changes remote team');
		const promotedControls = alpha.page.locator('.mp-lobby-host > label > select');
		await promotedControls.nth(1).selectOption('3');
		await alpha.page.locator('.mp-lobby-note').click();
		await state(alpha, s => s.capacity === 3 && s.requestedCapacity === 3, 'promoted admin changes capacity');
		await promotedControls.nth(0).selectOption(maps[1].uid);
		await alpha.page.locator('.mp-lobby-note').click();
		await state(alpha, s => s.map === maps[1].uid && s.capacity === 3, 'promoted admin changes map retaining capacity', 60_000);
		await expectMapFooter(maps[1]);
		await screenshot(alpha, '05-promoted-admin-controls');
		checks.push({ name: 'idle transfer timing', status: 'passed', milliseconds: Date.now() - waitingAt });
		await leave(admin);
		await leave(alpha);
		await leave(bravo);
	});
	await check('unranked human plus AI starts and communication stays absent from persistence', async () => {
		room = await host(alpha, { capacity: 2 });
		await action(alpha, 'Add AI').click();
		await state(alpha, s => s.clients.some(c => c.bot), 'AI added to two-seat room');
		await chat(alpha, 'human-ai');
		await ready(alpha);
		await waitFor(async () => /started=True/.test(await probe(alpha)), 'human-plus-AI auto start', 120_000);
		await leave(alpha);
		for (const text of privateMessages) {
			assert(!log.join('').includes(text), 'chat text entered node stdout/stderr');
			for (const client of clients) {
				assert(!client.console.some(line => line.includes(text)), `${client.name} wrote chat text to its console`);
				assert(!await storageContains(client, text), `${client.name} saved chat in browser storage`);
			}
		}
		const inspected = files(dataDir);
		for (const file of inspected) {
			const bytes = fs.readFileSync(file);
			for (const text of privateMessages) assert(!bytes.includes(Buffer.from(text)) && !bytes.includes(Buffer.from(text, 'utf16le')), `chat text persisted in ${path.relative(dataDir, file)}`);
		}
		checks.push({ name: 'node logs/support/replay canary inspection', status: 'passed', files: inspected.map(file => path.relative(dataDir, file)) });
	});
	assertBrowserClean();
	passed = true;
} catch (error) {
	console.error(`FAIL ${error.stack ?? error}`);
	console.error(`node diagnostic tail:\n${log.join('').split('\n').filter(line => /create rejected|healthy|room .*state|runner-missing|error/i.test(line)).slice(-20).join('\n')}`);
	checks.push({ name: 'gate failure', status: 'failed', error: String(error.stack ?? error) });
	for (const client of clients) {
		await screenshot(client, `failure-${client.name}`).catch(() => {});
		console.error(`${client.name}: ${await probe(client).catch(() => 'unavailable')}`);
	}
} finally {
	for (const client of clients) await client.browser.close().catch(() => {});
	await stopProcessGroup(roomhost).catch(error => checks.push({ name: 'cleanup', status: 'failed', error: String(error) }));
	fs.writeFileSync(path.join(outputDir, 'report.json'), JSON.stringify({
		status: passed ? 'passed' : 'failed', bundle, build, idleSeconds, checks,
		limitations: ['Chromium loopback browser gate; packaged desktop, physical devices and real-network paths are separate release checks.', 'Browser storage inspection covers local/session storage and IndexedDB; client replay export requires separate replay gate.'],
	}, null, 2));
	if (passed) fs.rmSync(dataDir, { recursive: true, force: true });
	else console.error(`node data retained: ${dataDir}`);
}
console.log(`mp-desktop-lobbygate ${passed ? 'PASS' : 'FAIL'}; evidence ${outputDir}`);
process.exitCode = passed ? 0 : 1;
