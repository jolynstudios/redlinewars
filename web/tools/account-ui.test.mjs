import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('shared game UI exposes distinct mode and settlement states', () => {
	const html = read('index.html');
	const ui = read('src/ui/index.ts');
	assert.match(html, /Skirmish · rating eligible/);
	assert.match(html, /Unranked network play/);
	assert.match(html, /id="account-ui"/);
	assert.match(ui, /Result pending server settlement/);
	assert.match(ui, /Match void — no rating change/);
	assert.match(ui, /Settlement unavailable — no rating change/);
});

test('account UI creates and upgrades guests while desktop credentials stay brokered', () => {
	const html = read('index.html');
	const ui = read('src/ui/index.ts');
	const account = read('src/core/account.ts');
	const preload = fs.readFileSync(path.resolve(root, '../desktop/preload.cjs'), 'utf8');
	const main = fs.readFileSync(path.resolve(root, '../desktop/main.mjs'), 'utf8');
	assert.match(ui, /query\.get\('debug'\) === 'on'/);
	assert.match(ui, /this\.effectiveMpMode\(\) !== 'off'/);
	assert.match(account, /credentials: 'include'/);
	assert.match(html, /id="account-guest-form"/);
	assert.match(html, /id="account-upgrade-form"/);
	assert.match(ui, /accountCreateGuest/);
	assert.match(ui, /result\.upgraded !== true/);
	assert.match(ui, /Account service is offline/);
	assert.match(account, /Use secure browser sign-in in the desktop app/);
	assert.match(account, /accountAvatarUrl/);
	assert.match(ui, /accountAvatarUpload/);
	assert.match(html, /name="username"/);
	assert.match(html, /name="identifier"/);
	assert.match(ui, /body: \{ username, callsign:/);
	assert.match(account, /\/api\/me\/profile/);
	assert.match(preload, /accountDeviceLogin/);
	assert.match(preload, /accountAvatarUpload/);
	assert.doesNotMatch(preload, /accessToken|Bearer/);
	assert.match(main, /safeStorage\.encryptString/);
	assert.match(main, /safeStorage\.decryptString/);
	assert.doesNotMatch(main, /console\.log\([^\n]*(?:accessToken|Bearer)/i);
});

test('private debug browser hosting uses relay placement without opening public multiplayer', () => {
	const ui = read('src/ui/index.ts');
	const net = read('src/core/net-config.ts');
	assert.match(ui, /this\.effectiveMpMode\(\) === 'full'/);
	assert.match(ui, /new URL\('\/v2\/rooms'/);
	assert.match(ui, /get\('debug'\) === 'on'/);
	assert.match(ui, /endpoint\.searchParams\.set\('debug', 'on'\)/);
	assert.match(ui, /Number\(config\.capacity\?\.donatedFree/);
	assert.match(ui, /join\.searchParams\.set\('k', room\.hostKey\)/);
	assert.match(ui, /join\.searchParams\.set\('debug', 'on'\)/);
	assert.match(ui, /ws\.searchParams\.set\('debug', 'on'\)/);
	assert.match(net, /browserMultiplayer: 'off'/);
});
